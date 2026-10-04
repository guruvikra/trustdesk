const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { db, parseJson } = require('../db');
const { tokenize } = require('../lib/text');
const { scanDocument } = require('./guardrails');
const retrieval = require('./retrieval');

const KB_DIR = path.resolve(__dirname, '../../../data/knowledge_base');

// Reads the "Doc ID / Audience / Version" header used by the provided policy files.
function parseMarkdownDoc(raw, fallback = {}) {
  const lines = raw.split('\n');
  const meta = {};
  for (const line of lines.slice(0, 12)) {
    const m = line.match(/^(Doc ID|Document ID|Audience|Version|Visibility)\s*:\s*(.+)$/i);
    if (m) meta[m[1].toLowerCase().replace(/\s+/g, '_')] = m[2].trim();
  }
  const titleLine = lines.find(l => /^#\s+/.test(l));
  return {
    doc_id: meta.doc_id || meta.document_id || fallback.doc_id,
    title: titleLine ? titleLine.replace(/^#\s+/, '').trim() : fallback.title || 'Untitled document',
    audience: meta.audience || fallback.audience || 'Customer support agents',
    version: meta.version || fallback.version || '1.0',
    visibility: (meta.visibility || fallback.visibility || '').toLowerCase() || null,
  };
}

const META_LINE = /^(Doc ID|Document ID|Audience|Version|Visibility)\s*:/i;

// Splits long text into ~900 char windows on paragraph, then sentence, boundaries.
function splitLong(text, max = 900) {
  if (text.length <= max * 1.3) return [text];
  const parts = text.split(/\n\s*\n/).length > 1 ? text.split(/\n\s*\n/) : text.split(/(?<=[.!?])\s+/);
  const out = [];
  let acc = '';
  for (const p of parts) {
    if (acc && (acc + ' ' + p).length > max) { out.push(acc.trim()); acc = ''; }
    acc += (acc ? '\n\n' : '') + p;
  }
  if (acc.trim()) out.push(acc.trim());
  return out;
}

// Heading-aware chunking: each "## section" becomes one chunk; headerless text (PDFs) is windowed.
function chunkMarkdown(content, title) {
  const sections = [];
  let heading = 'Overview';
  let buf = [];
  const flush = () => {
    const cleaned = buf.filter(l => !META_LINE.test(l)).join('\n').trim();
    if (cleaned) sections.push({ heading, content: cleaned });
    buf = [];
  };
  for (const line of String(content).split('\n')) {
    if (/^#\s+/.test(line)) continue;
    const h = line.match(/^#{2,4}\s+(.+)/);
    if (h) { flush(); heading = h[1].trim(); continue; }
    buf.push(line);
  }
  flush();
  return sections.flatMap(s => splitLong(s.content).map(c => ({ heading: s.heading, content: c, title })));
}

function defaultVisibility(audience) {
  return /engineer|administrator|internal|staff only/i.test(audience || '') ? 'internal' : 'public';
}

// Citation IDs must look like KB-XXX-001 so replies can cite them as [KB-XXX-001].
function normalizeId(raw) {
  if (!raw || !String(raw).trim()) return null;
  const id = String(raw).trim().toUpperCase().replace(/[^A-Z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return id ? (id.startsWith('KB-') ? id : `KB-${id}`) : null;
}

function slugId(title) {
  return 'KB-' + String(title).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) + '-' + uuidv4().slice(0, 4).toUpperCase();
}

// Stores (or replaces) one document and its chunks. Returns the stored document row.
function upsertDocument({ doc_id, title, content, audience, version, visibility, source_type = 'manual', source_path = null }) {
  const parsed = parseMarkdownDoc(content, { doc_id, title, audience, version, visibility });
  const id = normalizeId(doc_id || parsed.doc_id) || slugId(parsed.title);
  const finalTitle = title || parsed.title;
  const finalAudience = audience || parsed.audience;
  const scan = scanDocument({ content, audience: finalAudience, source_type });
  const vis = visibility || parsed.visibility || defaultVisibility(finalAudience);
  const now = new Date().toISOString();
  const chunks = chunkMarkdown(content, finalTitle);

  db.transaction(() => {
    const existing = db.get('SELECT created_at FROM documents WHERE doc_id = ?', [id]);
    db.run('DELETE FROM doc_chunks WHERE doc_id = ?', [id]);
    db.run(
      `INSERT OR REPLACE INTO documents (doc_id, title, audience, version, source_type, source_path, visibility, trust,
        trust_reasons_json, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, finalTitle, finalAudience, version || parsed.version, source_type, source_path, vis, scan.trust,
        JSON.stringify(scan.reasons), content, existing ? existing.created_at : now, now]
    );
    chunks.forEach((c, i) => {
      db.run('INSERT INTO doc_chunks (chunk_id, doc_id, position, heading, content, term_count) VALUES (?,?,?,?,?,?)',
        [`${id}#${i + 1}`, id, i + 1, c.heading, c.content, tokenize(c.title + ' ' + c.heading + ' ' + c.content).length]);
    });
  });
  retrieval.invalidate();
  return { ...db.get('SELECT * FROM documents WHERE doc_id = ?', [id]), chunk_count: chunks.length, trust_reasons: scan.reasons };
}

function loadKnowledgeBaseFolder(dir = KB_DIR) {
  return fs.readdirSync(dir).filter(f => /\.(md|txt)$/i.test(f)).sort().map(file => {
    const content = fs.readFileSync(path.join(dir, file), 'utf8');
    return upsertDocument({ content, source_type: 'policy_pack', source_path: `data/knowledge_base/${file}` });
  });
}

// --- Background ingestion jobs ------------------------------------------

function log(jobId, message) {
  const job = db.get('SELECT logs_json FROM ingest_jobs WHERE job_id = ?', [jobId]);
  const logs = parseJson(job && job.logs_json, []);
  logs.push({ at: new Date().toISOString(), message });
  db.run('UPDATE ingest_jobs SET logs_json = ? WHERE job_id = ?', [JSON.stringify(logs), jobId]);
}

// Queues ingestion so large uploads never block other requests; returns immediately with a job id.
function submitIngestJob(sourceName, docs) {
  const jobId = `job_${uuidv4().slice(0, 8)}`;
  db.run('INSERT INTO ingest_jobs (job_id, status, source_name, created_at) VALUES (?,?,?,?)',
    [jobId, 'queued', sourceName, new Date().toISOString()]);
  setImmediate(() => runJob(jobId, docs));
  return jobId;
}

async function runJob(jobId, docs) {
  try {
    db.run("UPDATE ingest_jobs SET status = 'running' WHERE job_id = ?", [jobId]);
    const ids = [];
    // A function lets slow extraction (PDF parsing, URL fetches) happen inside the job too.
    const list = docs === 'folder' ? null : typeof docs === 'function' ? await docs(msg => log(jobId, msg)) : docs;
    if (!list) {
      log(jobId, 'Re-syncing policy pack from data/knowledge_base');
      for (const d of loadKnowledgeBaseFolder()) {
        ids.push(d.doc_id);
        log(jobId, `${d.doc_id}: ${d.chunk_count} chunks, trust=${d.trust}${d.trust_reasons.length ? ' — ' + d.trust_reasons[0] : ''}`);
      }
    } else {
      for (const input of list) {
        if (!input.content || !String(input.content).trim()) { log(jobId, `Skipped "${input.title || 'untitled'}": empty content`); continue; }
        const d = upsertDocument(input);
        ids.push(d.doc_id);
        log(jobId, `${d.doc_id}: ${d.chunk_count} chunks, visibility=${d.visibility}, trust=${d.trust}${d.trust_reasons.length ? ' — ' + d.trust_reasons[0] : ''}`);
      }
    }
    db.run("UPDATE ingest_jobs SET status = 'completed', doc_ids_json = ?, finished_at = ? WHERE job_id = ?",
      [JSON.stringify(ids), new Date().toISOString(), jobId]);
  } catch (e) {
    db.run("UPDATE ingest_jobs SET status = 'failed', error = ?, finished_at = ? WHERE job_id = ?", [e.message, new Date().toISOString(), jobId]);
  }
}

function getJob(jobId) {
  const j = db.get('SELECT * FROM ingest_jobs WHERE job_id = ?', [jobId]);
  if (!j) return null;
  return { ...j, doc_ids: parseJson(j.doc_ids_json, []), logs: parseJson(j.logs_json, []), doc_ids_json: undefined, logs_json: undefined };
}

// --- Text extraction for uploads and URLs ---------------------------------

async function extractFile({ originalname, buffer, mimetype }) {
  const name = originalname || 'upload';
  if (/\.pdf$/i.test(name) || mimetype === 'application/pdf') {
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    // pdf.js misreads pooled Node buffers (non-zero byteOffset); parse a private copy.
    const out = await pdf(Buffer.from(buffer));
    return { title: name.replace(/\.pdf$/i, ''), content: markHeadings(out.text.replace(/\n{3,}/g, '\n\n').trim()), source_type: 'pdf_upload' };
  }
  if (!/\.(md|markdown|txt|html?)$/i.test(name)) throw new Error('Unsupported file type (use PDF, Markdown, text or HTML)');
  if (buffer.includes(0)) throw new Error('File looks binary, not text');
  const text = buffer.toString('utf8');
  if (/\.html?$/i.test(name)) return { ...htmlToText(text), source_type: 'file_upload', title: name.replace(/\.html?$/i, '') };
  const h1 = (text.match(/^#\s+(.+)$/m) || [])[1];
  return { title: h1 ? h1.trim() : name.replace(/\.(md|txt|markdown)$/i, ''), content: text, source_type: 'file_upload' };
}

// PDFs lose heading markup; short title-like lines on their own become "## " sections for chunking.
function markHeadings(text) {
  const lines = text.split('\n');
  return lines.map((l, i) => {
    const t = l.trim();
    const next = (lines[i + 1] || '').trim();
    const isTitle = t.length >= 3 && t.length <= 60 && !/[.,;:!?)]$/.test(t) && /^[A-Z0-9]/.test(t) && !/^[•*\u2022-]/.test(t)
      && t.split(/\s+/).length <= 8 && next.length > 0 && (i === 0 || !lines[i - 1].trim() || next.length > t.length * 1.5);
    return isTitle ? `## ${t}` : l;
  }).join('\n');
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1];
  const body = html
    .replace(/<(script|style|nav|footer|header|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, l, t) => `\n\n${'#'.repeat(Math.max(2, Number(l)))} ${t.replace(/<[^>]+>/g, '').trim()}\n`)
    .replace(/<(br|\/p|\/li|\/div|\/tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  return { title: title ? title.trim() : null, content: body };
}

// Blocks requests to internal networks (SSRF): loopback, private, link-local, metadata, odd ports.
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (_) { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('URL must start with http:// or https://');
  if (u.port && !['80', '443'].includes(u.port)) throw new Error('Only standard web ports (80/443) are allowed');
  const net = require('net');
  const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await require('dns').promises.lookup(u.hostname, { all: true }).catch(() => { throw new Error(`Could not resolve ${u.hostname}`); });
  const isPrivate = a => /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a) || a === '::1' || /^f[cd]|^fe80|^::ffff:(127|10|192\.168|169\.254)\./i.test(a) || a === '::';
  if (addrs.some(a => isPrivate(a.address))) throw new Error('URLs on private or internal networks are not allowed');
  return u;
}

async function fetchUrl(url, hops = 0) {
  await assertPublicUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { 'User-Agent': 'TrustDesk-KB-Sync/1.0' } });
    // Follow redirects manually so every hop is re-checked against internal networks.
    if (res.status >= 300 && res.status < 400) {
      if (hops >= 3) throw new Error('Too many redirects');
      return fetchUrl(new URL(res.headers.get('location') || '', url).toString(), hops + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    const type = res.headers.get('content-type') || '';
    if (type.includes('pdf')) return extractFile({ originalname: 'page.pdf', buffer: Buffer.from(await res.arrayBuffer()), mimetype: 'application/pdf' });
    const text = await res.text();
    // Follow HTML/JS redirect pages (<meta http-equiv="refresh" ...>) used by many docs sites.
    const refresh = type.includes('html') && text.length < 5000 && (text.match(/http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)/i) || [])[1];
    if (refresh && hops < 3) return fetchUrl(new URL(refresh, url).toString(), hops + 1);
    const parsed = type.includes('html') ? htmlToText(text) : { title: null, content: text };
    if (type.includes('html')) parsed.links = [...text.matchAll(/<a\s[^>]*href=["']([^"'#]+)/gi)].map(m => { try { return new URL(m[1], res.url || url).toString(); } catch (_) { return null; } }).filter(Boolean);
    parsed.finalUrl = url;
    return { title: parsed.title || new URL(url).hostname + new URL(url).pathname, content: parsed.content, source_type: 'url', source_path: url, links: parsed.links || [] };
  } finally {
    clearTimeout(timer);
  }
}

// Crawls a docs site: the start page plus linked pages in the same section (same host and path
// prefix), breadth-first, a few at a time. Each page becomes one document.
async function crawlSite(startUrl, { maxPages = 20, log = () => {} } = {}) {
  const first = await fetchUrl(startUrl);
  const base = new URL(first.source_path);
  const prefix = base.pathname.endsWith('/') ? base.pathname : base.pathname.replace(/[^/]*$/, '');
  const norm = u => { const x = new URL(u); x.hash = ''; x.search = ''; return x.toString().replace(/\/$/, ''); };
  const seen = new Set([norm(first.source_path)]);
  const docs = [];
  const queue = [];
  const accept = (page) => {
    if (page.content && page.content.trim().length > 80) { docs.push(page); log(`Fetched ${page.source_path} (${page.content.length} characters)`); }
    for (const l of page.links || []) {
      let u; try { u = new URL(l); } catch (_) { continue; }
      if (u.host !== base.host || !u.pathname.startsWith(prefix) || /\.(png|jpe?g|gif|svg|css|js|ico|zip|mp4|woff2?)$/i.test(u.pathname)) continue;
      const k = norm(u.toString());
      if (!seen.has(k)) { seen.add(k); queue.push(u.toString()); }
    }
  };
  accept(first);
  log(`Start page ${first.source_path} → found ${queue.length} linked pages in ${prefix}`);
  while (queue.length && docs.length < maxPages) {
    const batch = queue.splice(0, Math.min(4, maxPages - docs.length));
    const pages = await Promise.all(batch.map(u => fetchUrl(u).catch(e => { log(`Skipped ${u}: ${e.message}`); return null; })));
    pages.filter(Boolean).forEach(accept);
  }
  return docs.slice(0, maxPages).map(({ links, ...d }) => d);
}

module.exports = { crawlSite, extractFile, fetchUrl, htmlToText, upsertDocument, loadKnowledgeBaseFolder, submitIngestJob, getJob, chunkMarkdown, parseMarkdownDoc };
