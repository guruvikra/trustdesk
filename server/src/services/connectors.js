// Integrations. Each app is isolated behind one interface so the TrustDesk pipeline is identical
// wherever a ticket comes from:
//   helpdesks (Zendesk, Freshdesk, Intercom, Front): test · fetchTickets · postReply
//   issue trackers (Linear):                          test · createIssue
// Every app supports an API key/token; Zendesk, Intercom, Front and Linear also support OAuth
// when <APP>_CLIENT_ID / <APP>_CLIENT_SECRET are configured on the server.

const crypto = require('crypto');
const { db, parseJson } = require('../db');
const { createTicket } = require('./tickets');

const stripHtml = html => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
const toHtml = text => String(text).split('\n').map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>');
const textOf = v => (v == null ? '' : typeof v === 'string' ? v : Array.isArray(v) ? v.map(textOf).join('; ') : v.message || v.title || v.description || JSON.stringify(v));
const err = (status, message) => Object.assign(new Error(message), { status });

// Turns app API failures into messages an admin can act on.
function friendlyError(status, label, detail) {
  if (status === 401 || status === 403) return `${label} rejected the credentials — check the API key/token${label === 'Zendesk' ? ', agent email and that token access is enabled' : ''}.`;
  if (status === 404) return `${label} account or endpoint not found — check the subdomain/domain.`;
  if (status === 429) return `${label} rate limit reached — wait a minute and try again.`;
  return `${label} returned HTTP ${status}${detail ? `: ${detail}` : ''}`;
}

async function request(label, url, { method = 'GET', headers = {}, body, form } = {}) {
  let res;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      method,
      headers: { Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e.name === 'TimeoutError') throw err(504, `${label} did not respond within 15 seconds — try again.`);
    throw err(502, `Could not reach ${label} (${e.cause && e.cause.code ? e.cause.code : e.message}) — check the subdomain/domain.`);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const detail = json && textOf(json.description || json.error_description || json.error || json.message || json.errors).slice(0, 200);
    throw err(502, friendlyError(res.status, label, detail));
  }
  if (json && json.errors && label === 'Linear') throw err(502, `Linear: ${textOf(json.errors).slice(0, 200)}`);
  return json;
}

const basic = s => `Basic ${Buffer.from(s).toString('base64')}`;
const bearer = t => `Bearer ${t}`;
const host = (v, suffix) => String(v || '').trim().replace(/^https?:\/\//, '').replace(new RegExp(`\\.${suffix.replace('.', '\\.')}.*$`), '').replace(/\/.*$/, '');

const PLATFORMS = {
  zendesk: {
    label: 'Zendesk', kind: 'helpdesk', color: '#03363d',
    description: 'Import open tickets, draft cited replies, post answers back and mark tickets solved.',
    authModes: ['api_key', 'oauth'],
    fields: {
      api_key: [
        { key: 'subdomain', label: 'Subdomain', placeholder: 'yourcompany (from yourcompany.zendesk.com)' },
        { key: 'email', label: 'Agent email', placeholder: 'you@company.com' },
        { key: 'api_token', label: 'API token', secret: true, placeholder: 'Admin Center → Apps and integrations → Zendesk API' },
      ],
      oauth: [{ key: 'subdomain', label: 'Subdomain', placeholder: 'yourcompany (from yourcompany.zendesk.com)' }],
    },
    help: 'API token: Admin Center → Apps and integrations → APIs → Zendesk API → enable Token access → Add API token.',
    base: c => `https://${host(c.subdomain, 'zendesk.com')}.zendesk.com/api/v2`,
    headers: c => ({ Authorization: c.auth_mode === 'oauth' ? bearer(c.access_token) : basic(`${c.email}/token:${c.api_token}`) }),
    oauth: {
      env: 'ZENDESK',
      authorizeUrl: (c, p) => `https://${host(c.subdomain, 'zendesk.com')}.zendesk.com/oauth/authorizations/new?${new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, scope: 'read write', state: p.state })}`,
      exchange: (c, p) => request('Zendesk', `https://${host(c.subdomain, 'zendesk.com')}.zendesk.com/oauth/tokens`, { method: 'POST', body: { grant_type: 'authorization_code', code: p.code, client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: p.redirectUri, scope: 'read write' } }),
    },
    async test(c) { const me = await request('Zendesk', `${this.base(c)}/users/me.json`, { headers: this.headers(c) }); return `Connected as ${me.user.name} (${me.user.role})`; },
    async fetchTickets(c, limit = 25) {
      const data = await request('Zendesk', `${this.base(c)}/tickets.json?sort_by=created_at&sort_order=desc&per_page=${limit}&include=users`, { headers: this.headers(c) });
      const users = new Map((data.users || []).map(u => [u.id, u]));
      return (data.tickets || []).filter(t => !['closed', 'solved'].includes(t.status)).map(t => ({
        ticket_id: `zd_${t.id}`, source_ref: String(t.id), channel: 'zendesk', subject: t.subject || t.raw_subject, body: t.description, created_at: t.created_at,
        requester_email: users.get(t.requester_id) ? users.get(t.requester_id).email : null, requester_name: users.get(t.requester_id) ? users.get(t.requester_id).name : null,
      }));
    },
    async postReply(c, id, body, { internal = false, resolve = false } = {}) {
      const ticket = { comment: { body, public: !internal } };
      if (resolve) ticket.status = 'solved';
      await request('Zendesk', `${this.base(c)}/tickets/${id}.json`, { method: 'PUT', headers: this.headers(c), body: { ticket } });
      return `Posted ${internal ? 'internal note' : 'public reply'} to Zendesk #${id}${resolve ? ' and marked solved' : ''}`;
    },
  },

  freshdesk: {
    label: 'Freshdesk', kind: 'helpdesk', color: '#25c16f',
    description: 'Import open tickets, reply from TrustDesk and resolve them in Freshdesk.',
    authModes: ['api_key'],
    fields: {
      api_key: [
        { key: 'domain', label: 'Domain', placeholder: 'yourcompany (from yourcompany.freshdesk.com)' },
        { key: 'api_key', label: 'API key', secret: true, placeholder: 'Profile settings → Your API Key' },
      ],
    },
    help: 'API key: click your avatar → Profile settings → View API key.',
    base: c => `https://${host(c.domain, 'freshdesk.com')}.freshdesk.com/api/v2`,
    headers: c => ({ Authorization: basic(`${c.api_key}:X`) }),
    async test(c) { const me = await request('Freshdesk', `${this.base(c)}/agents/me`, { headers: this.headers(c) }); return `Connected as ${me.contact ? me.contact.name : 'agent'}`; },
    async fetchTickets(c, limit = 25) {
      const list = await request('Freshdesk', `${this.base(c)}/tickets?order_by=created_at&order_type=desc&per_page=${limit}&include=requester,description`, { headers: this.headers(c) });
      // Freshdesk status: 2 open, 3 pending, 4 resolved, 5 closed.
      return (list || []).filter(t => ![4, 5].includes(t.status)).map(t => ({
        ticket_id: `fd_${t.id}`, source_ref: String(t.id), channel: 'freshdesk', subject: t.subject, body: t.description_text || stripHtml(t.description), created_at: t.created_at,
        requester_email: t.requester ? t.requester.email : null, requester_name: t.requester ? t.requester.name : null,
      }));
    },
    async postReply(c, id, body, { internal = false, resolve = false } = {}) {
      if (internal) await request('Freshdesk', `${this.base(c)}/tickets/${id}/notes`, { method: 'POST', headers: this.headers(c), body: { body: toHtml(body), private: true } });
      else await request('Freshdesk', `${this.base(c)}/tickets/${id}/reply`, { method: 'POST', headers: this.headers(c), body: { body: toHtml(body) } });
      if (resolve) await request('Freshdesk', `${this.base(c)}/tickets/${id}`, { method: 'PUT', headers: this.headers(c), body: { status: 4 } });
      return `Posted ${internal ? 'private note' : 'reply'} to Freshdesk #${id}${resolve ? ' and marked resolved' : ''}`;
    },
  },

  intercom: {
    label: 'Intercom', kind: 'helpdesk', color: '#1f8ded',
    description: 'Import open conversations, reply as an admin and close them in Intercom.',
    authModes: ['api_key', 'oauth'],
    fields: {
      api_key: [{ key: 'access_token', label: 'Access token', secret: true, placeholder: 'Developer Hub → your app → Authentication' }],
      oauth: [],
    },
    help: 'Access token: Intercom Developer Hub → New app → Authentication → Access token.',
    base: () => 'https://api.intercom.io',
    headers: c => ({ Authorization: bearer(c.access_token), 'Intercom-Version': '2.11' }),
    oauth: {
      env: 'INTERCOM',
      authorizeUrl: (c, p) => `https://app.intercom.com/oauth?${new URLSearchParams({ client_id: p.clientId, state: p.state, redirect_uri: p.redirectUri })}`,
      exchange: async (c, p) => {
        const out = await request('Intercom', 'https://api.intercom.io/auth/eagle/token', { method: 'POST', body: { code: p.code, client_id: p.clientId, client_secret: p.clientSecret } });
        return { access_token: out.access_token || out.token };
      },
    },
    async me(c) { return request('Intercom', `${this.base()}/me`, { headers: this.headers(c) }); },
    async test(c) { const me = await this.me(c); return `Connected as ${me.name}${me.app ? ` · ${me.app.name}` : ''}`; },
    async fetchTickets(c, limit = 25) {
      const data = await request('Intercom', `${this.base()}/conversations?per_page=${limit}`, { headers: this.headers(c) });
      return (data.conversations || []).filter(cv => cv.state !== 'closed').map(cv => {
        const src = cv.source || {};
        return {
          ticket_id: `ic_${cv.id}`, source_ref: String(cv.id), channel: 'intercom', subject: cv.title || src.subject || stripHtml(src.body).slice(0, 80) || 'Intercom conversation',
          body: stripHtml(src.body), created_at: cv.created_at ? new Date(cv.created_at * 1000).toISOString() : undefined,
          requester_email: src.author && src.author.email, requester_name: src.author && src.author.name,
        };
      });
    },
    async postReply(c, id, body, { internal = false, resolve = false } = {}) {
      const admin = await this.me(c);
      await request('Intercom', `${this.base()}/conversations/${id}/reply`, { method: 'POST', headers: this.headers(c), body: { message_type: internal ? 'note' : 'comment', type: 'admin', admin_id: admin.id, body: toHtml(body) } });
      if (resolve) await request('Intercom', `${this.base()}/conversations/${id}/parts`, { method: 'POST', headers: this.headers(c), body: { message_type: 'close', type: 'admin', admin_id: admin.id } });
      return `Posted ${internal ? 'note' : 'reply'} to Intercom conversation ${id}${resolve ? ' and closed it' : ''}`;
    },
  },

  front: {
    label: 'Front', kind: 'helpdesk', color: '#a857f1',
    description: 'Import open conversations from shared inboxes, reply and archive them in Front.',
    authModes: ['api_key', 'oauth'],
    fields: {
      api_key: [
        { key: 'api_token', label: 'API token', secret: true, placeholder: 'Settings → Developers → API tokens' },
        { key: 'teammate_id', label: 'Reply as teammate ID (optional)', placeholder: 'tea_xxxx — required by some inboxes', optional: true },
      ],
      oauth: [{ key: 'teammate_id', label: 'Reply as teammate ID (optional)', placeholder: 'tea_xxxx', optional: true }],
    },
    help: 'API token: Front Settings → Developers → API tokens → Create (scopes: shared resources, read/write).',
    base: () => 'https://api2.frontapp.com',
    headers: c => ({ Authorization: bearer(c.auth_mode === 'oauth' ? c.access_token : c.api_token) }),
    oauth: {
      env: 'FRONT',
      authorizeUrl: (c, p) => `https://app.frontapp.com/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state })}`,
      exchange: (c, p) => request('Front', 'https://app.frontapp.com/oauth/token', { method: 'POST', headers: { Authorization: basic(`${p.clientId}:${p.clientSecret}`) }, form: { grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri } }),
    },
    async test(c) { const me = await request('Front', `${this.base()}/me`, { headers: this.headers(c) }); return `Connected to Front${me && me.name ? ` (${me.name})` : ''}`; },
    async fetchTickets(c, limit = 20) {
      const data = await request('Front', `${this.base()}/conversations?q[statuses][]=unassigned&q[statuses][]=assigned&limit=${limit}`, { headers: this.headers(c) });
      const out = [];
      for (const cv of data._results || []) {
        let body = '';
        try {
          const msgs = await request('Front', `${this.base()}/conversations/${cv.id}/messages?limit=1`, { headers: this.headers(c) });
          const m = (msgs._results || [])[0];
          body = m ? m.text || stripHtml(m.body) : '';
        } catch (_) { /* keep subject only */ }
        out.push({
          ticket_id: `fr_${cv.id}`, source_ref: cv.id, channel: 'front', subject: cv.subject || 'Front conversation', body,
          created_at: cv.created_at ? new Date(cv.created_at * 1000).toISOString() : undefined,
          requester_email: cv.recipient && cv.recipient.handle, requester_name: cv.recipient && cv.recipient.name,
        });
      }
      return out;
    },
    async postReply(c, id, body, { internal = false, resolve = false } = {}) {
      const author = c.teammate_id ? { author_id: c.teammate_id } : {};
      if (internal) await request('Front', `${this.base()}/conversations/${id}/comments`, { method: 'POST', headers: this.headers(c), body: { body, ...author } });
      else await request('Front', `${this.base()}/conversations/${id}/messages`, { method: 'POST', headers: this.headers(c), body: { body: toHtml(body), ...author } });
      if (resolve) await request('Front', `${this.base()}/conversations/${id}`, { method: 'PATCH', headers: this.headers(c), body: { status: 'archived' } });
      return `Posted ${internal ? 'comment' : 'reply'} to Front ${id}${resolve ? ' and archived it' : ''}`;
    },
  },

  linear: {
    label: 'Linear', kind: 'issue_tracker', color: '#5e6ad2',
    description: 'Escalate product bugs and defects from a ticket into a Linear issue with full context.',
    authModes: ['api_key', 'oauth'],
    fields: {
      api_key: [
        { key: 'api_key', label: 'Personal API key', secret: true, placeholder: 'Settings → Account → Security & access → API keys' },
        { key: 'team_key', label: 'Team key (optional)', placeholder: 'e.g. ENG — defaults to your first team', optional: true },
      ],
      oauth: [{ key: 'team_key', label: 'Team key (optional)', placeholder: 'e.g. ENG', optional: true }],
    },
    help: 'API key: Linear Settings → Account → Security & access → Personal API keys → New key.',
    headers: c => ({ Authorization: c.auth_mode === 'oauth' ? bearer(c.access_token) : c.api_key }),
    oauth: {
      env: 'LINEAR',
      authorizeUrl: (c, p) => `https://linear.app/oauth/authorize?${new URLSearchParams({ client_id: p.clientId, redirect_uri: p.redirectUri, response_type: 'code', scope: 'read,write', state: p.state })}`,
      exchange: (c, p) => request('Linear', 'https://api.linear.app/oauth/token', { method: 'POST', form: { code: p.code, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'authorization_code' } }),
    },
    gql(c, query, variables) { return request('Linear', 'https://api.linear.app/graphql', { method: 'POST', headers: this.headers(c), body: { query, variables } }).then(r => r.data); },
    async team(c) {
      const d = await this.gql(c, '{ teams { nodes { id name key } } }');
      const teams = d.teams.nodes;
      const t = c.team_key ? teams.find(x => x.key.toLowerCase() === String(c.team_key).toLowerCase()) : teams[0];
      if (!t) throw err(400, c.team_key ? `Linear team "${c.team_key}" not found (available: ${teams.map(x => x.key).join(', ')})` : 'No Linear teams found');
      return t;
    },
    async test(c) {
      const d = await this.gql(c, '{ viewer { name } organization { name } }');
      const t = await this.team(c);
      return `Connected as ${d.viewer.name} · ${d.organization.name} · issues go to team ${t.key}`;
    },
    async createIssue(c, { title, description }) {
      const t = await this.team(c);
      const d = await this.gql(c, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }', { input: { teamId: t.id, title, description } });
      return d.issueCreate.issue;
    },
  },
};

const HELPDESKS = Object.keys(PLATFORMS).filter(k => PLATFORMS[k].kind === 'helpdesk');

// --- Storage ----------------------------------------------------------------

function getIntegration(platform) {
  const row = db.get('SELECT * FROM integrations WHERE platform = ?', [platform]);
  return row ? { ...row, config: parseJson(row.config_json, {}), last_result: parseJson(row.last_result_json, null), enabled: Boolean(row.enabled) } : null;
}

const publicUrl = () => (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8000}`).replace(/\/$/, '');
const redirectUri = platform => `${publicUrl()}/api/oauth/${platform}/callback`;
function oauthCreds(def) {
  if (!def.oauth) return null;
  const id = process.env[`${def.oauth.env}_CLIENT_ID`];
  const secret = process.env[`${def.oauth.env}_CLIENT_SECRET`];
  return id && secret ? { clientId: id, clientSecret: secret } : null;
}

// Never return secrets to the browser.
function publicView(platform) {
  const def = PLATFORMS[platform];
  const row = getIntegration(platform);
  const cfg = row ? row.config : {};
  const allFields = [...new Map(Object.values(def.fields).flat().map(f => [f.key, f])).values()];
  const config = {};
  for (const f of allFields) {
    const v = cfg[f.key];
    config[f.key] = f.secret ? (v ? `••••${String(v).slice(-4)}` : '') : v || '';
  }
  return {
    platform, label: def.label, kind: def.kind, color: def.color, description: def.description, help: def.help,
    auth_modes: def.authModes, fields: def.fields, config, auth_mode: cfg.auth_mode || def.authModes[0],
    enabled: Boolean(row && row.enabled), last_sync_at: row && row.last_sync_at, last_result: row && row.last_result,
    oauth: def.oauth ? { available: Boolean(oauthCreds(def)), redirect_uri: redirectUri(platform), env_vars: [`${def.oauth.env}_CLIENT_ID`, `${def.oauth.env}_CLIENT_SECRET`] } : null,
    capabilities: { import: def.kind === 'helpdesk', reply: def.kind === 'helpdesk', issues: def.kind === 'issue_tracker' },
  };
}

function listIntegrations() { return Object.keys(PLATFORMS).map(publicView); }

function writeConfig(platform, config, enabled) {
  db.run(`INSERT INTO integrations (platform, config_json, enabled, updated_at) VALUES (?,?,?,?)
          ON CONFLICT(platform) DO UPDATE SET config_json = excluded.config_json, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  [platform, JSON.stringify(config), enabled ? 1 : 0, new Date().toISOString()]);
}

function definition(platform) {
  const def = PLATFORMS[platform];
  if (!def) throw err(404, `Unknown integration ${platform}`);
  return def;
}

// Saves API-key credentials (enables the integration) or the pre-OAuth fields (e.g. Zendesk subdomain).
function saveIntegration(platform, input) {
  const def = definition(platform);
  const mode = def.authModes.includes(input.auth_mode) ? input.auth_mode : 'api_key';
  const current = getIntegration(platform);
  const config = { ...(current ? current.config : {}), auth_mode: mode };
  for (const f of def.fields[mode]) {
    const v = input[f.key];
    if (v === undefined || (f.secret && String(v).startsWith('••••'))) continue;
    config[f.key] = String(v).trim();
  }
  const missing = def.fields[mode].filter(f => !f.optional && !config[f.key]).map(f => f.label);
  if (missing.length) throw err(400, `Missing: ${missing.join(', ')}`);
  if (mode === 'oauth') {
    // Store the pre-OAuth fields only; a working connection keeps its auth mode until OAuth completes.
    if (current && current.enabled) config.auth_mode = current.config.auth_mode;
    writeConfig(platform, config, Boolean(current && current.enabled));
  } else {
    writeConfig(platform, config, true);
  }
  return publicView(platform);
}

function disableIntegration(platform) {
  definition(platform);
  const current = getIntegration(platform);
  if (current) {
    const { access_token, api_token, api_key, ...rest } = current.config;
    writeConfig(platform, rest, false);
  }
  return publicView(platform);
}

function requireEnabled(platform) {
  const def = definition(platform);
  const row = getIntegration(platform);
  if (!row || !row.enabled) throw err(400, `${def.label} is not connected`);
  return { def, config: row.config };
}

async function testIntegration(platform) {
  const { def, config } = requireEnabled(platform);
  return { message: await def.test(config) };
}

async function syncIntegration(platform) {
  const { def, config } = requireEnabled(platform);
  if (!def.fetchTickets) throw err(400, `${def.label} is not a ticket source`);
  const result = { fetched: 0, created: 0, skipped: 0, ticket_ids: [] };
  try {
    const tickets = await def.fetchTickets(config);
    result.fetched = tickets.length;
    for (const t of tickets) {
      const { created, ticket } = createTicket(t);
      if (created) { result.created++; result.ticket_ids.push(ticket.ticket_id); } else result.skipped++;
    }
    result.message = `Fetched ${result.fetched} open ${def.label} conversations; ${result.created} new, ${result.skipped} already imported.`;
  } catch (e) {
    result.error = e.message;
  }
  db.run('UPDATE integrations SET last_sync_at = ?, last_result_json = ? WHERE platform = ?', [new Date().toISOString(), JSON.stringify(result), platform]);
  if (result.error) throw err(502, result.error);
  return result;
}

// Used when an agent sends a reply on a ticket imported from a helpdesk.
// If the source app is not connected (e.g. a webhook-tester ticket), the reply is kept in TrustDesk only.
async function pushReply(ticket, body, opts) {
  if (!HELPDESKS.includes(ticket.channel) || !ticket.source_ref) return null;
  const row = getIntegration(ticket.channel);
  if (!row || !row.enabled) return `Saved in TrustDesk only — ${PLATFORMS[ticket.channel].label} is not connected, so nothing was posted there.`;
  return PLATFORMS[ticket.channel].postReply(row.config, ticket.source_ref, body, opts);
}

function isConnected(platform) { const row = getIntegration(platform); return Boolean(row && row.enabled); }

// Creates (once) a Linear issue for a ticket. Concurrent clicks share one in-flight request.
const linearInFlight = new Map();
function createLinearIssue(ticketView, user) {
  const key = `${require('../db').currentOrgId()}:${ticketView.ticket_id}`;
  if (!linearInFlight.has(key)) linearInFlight.set(key, createLinearIssueOnce(ticketView, user).finally(() => linearInFlight.delete(key)));
  return linearInFlight.get(key);
}

async function createLinearIssueOnce(ticketView, user) {
  const existing = db.get("SELECT * FROM external_links WHERE ticket_id = ? AND platform = 'linear'", [ticketView.ticket_id]);
  if (existing) return { identifier: existing.external_id, url: existing.url, replayed: true };
  const { def, config } = requireEnabled('linear');
  const tri = ticketView.triage || {};
  const description = [
    `**Escalated from TrustDesk ticket ${ticketView.ticket_id}** (${ticketView.channel})`, '',
    `**Customer:** ${ticketView.customer ? `${ticketView.customer.name} (${ticketView.customer.tier})` : ticketView.requester_email || 'unknown'}`,
    ticketView.order ? `**Order:** ${ticketView.order.order_id} — ${ticketView.order.items.map(i => i.name).join(', ')}` : null,
    tri.category ? `**Triage:** ${tri.category} · ${tri.priority}${tri.flags && tri.flags.length ? ` · flags: ${tri.flags.join(', ')}` : ''}` : null,
    '', '**Customer message**', '', `> ${String(ticketView.body).split('\n').join('\n> ')}`,
  ].filter(l => l !== null).join('\n');
  const issue = await def.createIssue(config, { title: `[Support] ${ticketView.subject}`, description });
  db.run('INSERT INTO external_links (ticket_id, platform, external_id, url, created_by, created_at) VALUES (?,?,?,?,?,?)',
    [ticketView.ticket_id, 'linear', issue.identifier, issue.url, user.email, new Date().toISOString()]);
  return { identifier: issue.identifier, url: issue.url, replayed: false };
}

function externalLinks(ticketId) {
  return db.all('SELECT platform, external_id, url, created_by, created_at FROM external_links WHERE ticket_id = ?', [ticketId]);
}

// --- OAuth ------------------------------------------------------------------

const oauthStates = new Map(); // state -> { orgId, platform, user, expires }

function startOAuth(platform, { orgId, user }) {
  const def = definition(platform);
  if (!def.oauth) throw err(400, `${def.label} does not support OAuth; use an API key`);
  const creds = oauthCreds(def);
  if (!creds) throw err(400, `OAuth for ${def.label} is not configured on the server. Set ${def.oauth.env}_CLIENT_ID and ${def.oauth.env}_CLIENT_SECRET, and register ${redirectUri(platform)} as the redirect URL.`);
  const row = getIntegration(platform);
  const config = row ? row.config : {};
  const missing = def.fields.oauth.filter(f => !f.optional && !config[f.key]);
  if (missing.length) throw err(400, `Save ${missing.map(f => f.label).join(', ')} first`);
  const state = crypto.randomBytes(16).toString('hex');
  for (const [k, v] of oauthStates) if (v.expires < Date.now()) oauthStates.delete(k);
  oauthStates.set(state, { orgId, platform, user: user.email, expires: Date.now() + 10 * 60 * 1000 });
  return { url: def.oauth.authorizeUrl(config, { ...creds, redirectUri: redirectUri(platform), state }) };
}

function consumeState(state, platform) {
  const s = oauthStates.get(state);
  oauthStates.delete(state);
  if (!s || s.platform !== platform || s.expires < Date.now()) throw err(400, 'OAuth session expired or invalid — start again from Integrations');
  return s;
}

// Called inside the organisation's workspace context by the callback route.
async function finishOAuth(platform, code) {
  const def = definition(platform);
  const creds = oauthCreds(def);
  const row = getIntegration(platform);
  const config = { ...(row ? row.config : {}), auth_mode: 'oauth' };
  const tokens = await def.oauth.exchange(config, { ...creds, code, redirectUri: redirectUri(platform) });
  if (!tokens || !tokens.access_token) throw err(502, `${def.label} did not return an access token`);
  config.access_token = tokens.access_token;
  writeConfig(platform, config, true);
  return publicView(platform);
}

// --- Webhook payload normalizers (body templates shown on the Integrations page) -----

function normalizeWebhook(platform, p) {
  if (platform === 'zendesk') {
    const t = p.ticket || p;
    return { ticket_id: t.id || t.ticket_id ? `zd_${t.id || t.ticket_id}` : undefined, source_ref: String(t.id || t.ticket_id || ''), channel: 'zendesk',
      subject: t.subject || t.title, body: t.description || t.latest_comment || t.body, requester_email: t.requester_email || (t.requester && t.requester.email), requester_name: t.requester_name || (t.requester && t.requester.name) };
  }
  if (platform === 'freshdesk') {
    const t = p.freshdesk_webhook || p.ticket || p;
    const id = t.ticket_id || t.id;
    return { ticket_id: id ? `fd_${id}` : undefined, source_ref: id ? String(id) : null, channel: 'freshdesk',
      subject: t.ticket_subject || t.subject, body: stripHtml(t.ticket_description || t.description || t.body), requester_email: t.ticket_contact_email || t.requester_email || t.email, requester_name: t.ticket_contact_name || t.requester_name };
  }
  if (platform === 'intercom') {
    const item = (p.data && p.data.item) || p;
    const parts = item.source || item.conversation_message || {};
    return { ticket_id: item.id ? `ic_${item.id}` : undefined, source_ref: item.id ? String(item.id) : null, channel: 'intercom',
      subject: parts.subject || item.title || 'Intercom conversation', body: stripHtml(parts.body || item.body), requester_email: (item.user && item.user.email) || (parts.author && parts.author.email), requester_name: (item.user && item.user.name) || (parts.author && parts.author.name) };
  }
  if (platform === 'front') {
    const cv = p.conversation || (p.payload && p.payload.conversation) || p;
    const msg = (p.target && p.target.data) || p.message || {};
    return { ticket_id: cv.id ? `fr_${cv.id}` : undefined, source_ref: cv.id || null, channel: 'front',
      subject: cv.subject || 'Front conversation', body: msg.text || stripHtml(msg.body) || cv.subject, requester_email: cv.recipient && cv.recipient.handle, requester_name: cv.recipient && cv.recipient.name };
  }
  return { channel: platform, subject: p.subject, body: p.body || p.description, requester_email: p.email || p.requester_email, requester_name: p.name };
}

module.exports = {
  isConnected, listIntegrations, saveIntegration, disableIntegration, testIntegration, syncIntegration, pushReply, normalizeWebhook,
  createLinearIssue, externalLinks, startOAuth, consumeState, finishOAuth, PLATFORMS, HELPDESKS,
};
