// Loads the provided dataset, or prepares an empty workspace for real data.
//   mode "demo":  policy pack + customers + orders + tickets + tool catalog (default)
//   mode "empty": tool catalog + users only; add your own documents and tickets.
//   keepDocuments: in "empty" mode, keep the provided policy pack in the knowledge base.

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { loadKnowledgeBaseFolder } = require('./services/ingest');
const retrieval = require('./services/retrieval');

const DATA_DIR = path.resolve(__dirname, '../../data');
const readJson = f => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));

const TABLES = ['tool_actions', 'drafts', 'agent_runs', 'ticket_messages', 'tickets', 'orders', 'customers', 'doc_chunks', 'documents',
  'ingest_jobs', 'deflection_events', 'eval_runs', 'tool_catalog', 'users', 'automation_events', 'external_links'];
// Integration credentials survive a workspace reset on purpose. Users live in the accounts store.

function seedCatalogAndUsers() {
  for (const t of readJson('tool_actions.json')) {
    const { tool_name, description, risk_level, requires_human_approval, allowed_categories, required_fields, ...config } = t;
    db.run(`INSERT OR REPLACE INTO tool_catalog (tool_name, description, risk_level, requires_human_approval, allowed_categories_json,
            required_fields_json, config_json) VALUES (?,?,?,?,?,?,?)`,
    [tool_name, description, risk_level, requires_human_approval ? 1 : 0, JSON.stringify(allowed_categories), JSON.stringify(required_fields), JSON.stringify(config)]);
  }
}

function seedCustomersOrdersTickets() {
  for (const c of readJson('customers.json')) {
    db.run('INSERT OR REPLACE INTO customers (customer_id, name, email, tier, country, verified, tags_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
      [c.customer_id, c.name, c.email, c.tier, c.country, c.verified ? 1 : 0, JSON.stringify(c.tags || []), c.created_at]);
  }
  for (const o of readJson('orders.json')) {
    db.run(`INSERT OR REPLACE INTO orders (order_id, customer_id, status, placed_at, delivered_at, eligible_return_until, total, currency,
            payment_status, tracking_number, items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [o.order_id, o.customer_id, o.status, o.placed_at, o.delivered_at, o.eligible_return_until, o.total, o.currency, o.payment_status, o.tracking_number, JSON.stringify(o.items || [])]);
  }
  for (const t of readJson('tickets.json')) {
    // expected_* labels are intentionally dropped here.
    db.run(`INSERT OR REPLACE INTO tickets (ticket_id, customer_id, order_id, channel, subject, body, created_at, status, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`, [t.ticket_id, t.customer_id, t.order_id, t.channel, t.subject, t.body, t.created_at, t.status || 'open', t.created_at]);
    db.run('INSERT OR REPLACE INTO ticket_messages (message_id, ticket_id, author_type, author, body, internal, created_at) VALUES (?,?,?,?,?,0,?)',
      [`msg_${t.ticket_id}_0`, t.ticket_id, 'customer', t.customer_id, t.body, t.created_at]);
  }
}

function reset({ mode = 'demo', keepDocuments = true } = {}) {
  db.transaction(() => {
    for (const t of TABLES) db.run(`DELETE FROM ${t}`);
    seedCatalogAndUsers();
    if (mode === 'demo') seedCustomersOrdersTickets();
  });
  retrieval.invalidate();
  if (mode === 'demo' || keepDocuments) loadKnowledgeBaseFolder();
  return summary();
}

function ensureSeeded() {
  if (!db.get('SELECT COUNT(*) AS n FROM tool_catalog').n) return reset({ mode: 'demo' });
  return summary();
}

function summary() {
  const n = t => db.get(`SELECT COUNT(*) AS n FROM ${t}`).n;
  return { documents: n('documents'), chunks: n('doc_chunks'), customers: n('customers'), orders: n('orders'), tickets: n('tickets'), tools: n('tool_catalog') };
}

module.exports = { reset, ensureSeeded, summary, DATA_DIR };
