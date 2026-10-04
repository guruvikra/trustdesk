const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');

// TRUSTDESK_DB=":memory:" keeps everything in RAM (used by the test suite).
// The default database holds the demo workspace; every other workspace gets its own file
// under workspaces/ (database-per-tenant), so customer data is isolated by construction.
const DB_PATH = process.env.TRUSTDESK_DB || path.resolve(__dirname, '../../trustdesk_node.db');
const IN_MEMORY = DB_PATH === ':memory:';
const TENANT_DIR = path.resolve(__dirname, '../../workspaces');
let sqlModule = null;
const loadSql = async () => (sqlModule = sqlModule || (await initSqlJs()));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, tier TEXT NOT NULL,
  country TEXT, verified INTEGER NOT NULL DEFAULT 0, tags_json TEXT DEFAULT '[]', created_at TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  order_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, status TEXT NOT NULL, placed_at TEXT,
  delivered_at TEXT, eligible_return_until TEXT, total REAL NOT NULL DEFAULT 0, currency TEXT DEFAULT 'INR',
  payment_status TEXT, tracking_number TEXT, items_json TEXT NOT NULL DEFAULT '[]',
  replacement_for TEXT, created_by_action TEXT
);
-- Expected labels from the seed data are deliberately NOT stored here; only the eval runner reads them.
CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY, customer_id TEXT, order_id TEXT, channel TEXT NOT NULL,
  subject TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  requester_email TEXT, source_ref TEXT,
  triage_json TEXT, triage_run_id TEXT, assignee TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS ticket_messages (
  message_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, author_type TEXT NOT NULL, author TEXT,
  body TEXT NOT NULL, internal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  doc_id TEXT PRIMARY KEY, title TEXT NOT NULL, audience TEXT, version TEXT, source_type TEXT NOT NULL,
  source_path TEXT, visibility TEXT NOT NULL DEFAULT 'public', trust TEXT NOT NULL DEFAULT 'trusted',
  trust_reasons_json TEXT DEFAULT '[]', content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS doc_chunks (
  chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, position INTEGER NOT NULL, heading TEXT,
  content TEXT NOT NULL, term_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_jobs (
  job_id TEXT PRIMARY KEY, status TEXT NOT NULL, source_name TEXT NOT NULL, doc_ids_json TEXT DEFAULT '[]',
  logs_json TEXT DEFAULT '[]', error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS tool_catalog (
  tool_name TEXT PRIMARY KEY, description TEXT, risk_level TEXT, requires_human_approval INTEGER NOT NULL,
  allowed_categories_json TEXT, required_fields_json TEXT, config_json TEXT
);
CREATE TABLE IF NOT EXISTS tool_actions (
  action_id TEXT PRIMARY KEY, ticket_id TEXT, tool_name TEXT NOT NULL, parameters_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE, payload_hash TEXT NOT NULL, status TEXT NOT NULL,
  requires_approval INTEGER NOT NULL, proposed_by TEXT NOT NULL, source_run_id TEXT, block_reason TEXT,
  decided_by TEXT, decided_at TEXT, decision_note TEXT, executed_at TEXT, execution_result_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  draft_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, run_id TEXT, body TEXT NOT NULL, original_body TEXT,
  citations_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft', reviewed_by TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY, ticket_id TEXT, run_type TEXT NOT NULL, provider TEXT, model TEXT,
  input_summary TEXT, retrieved_doc_ids_json TEXT DEFAULT '[]', quarantined_doc_ids_json TEXT DEFAULT '[]',
  recommended_actions_json TEXT DEFAULT '[]', blocked_actions_json TEXT DEFAULT '[]',
  guardrail_json TEXT DEFAULT '{}', output_json TEXT DEFAULT '{}', steps_json TEXT DEFAULT '[]',
  final_status TEXT NOT NULL, latency_ms INTEGER, prompt_version TEXT, feedback TEXT, created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS eval_runs (
  eval_run_id TEXT PRIMARY KEY, status TEXT NOT NULL, provider TEXT, metrics_json TEXT,
  cases_json TEXT, error TEXT, created_at TEXT NOT NULL, finished_at TEXT
);
CREATE TABLE IF NOT EXISTS deflection_events (
  event_id TEXT PRIMARY KEY, question TEXT NOT NULL, answered INTEGER NOT NULL, confidence REAL,
  citations_json TEXT DEFAULT '[]', outcome TEXT NOT NULL DEFAULT 'pending', ticket_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, token TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS integrations (
  platform TEXT PRIMARY KEY, config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT, last_result_json TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS external_links (
  ticket_id TEXT NOT NULL, platform TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT, created_by TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (ticket_id, platform)
);
CREATE TABLE IF NOT EXISTS workspace_settings (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS automation_events (
  event_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, trigger TEXT NOT NULL, mode TEXT NOT NULL, outcome TEXT NOT NULL,
  confidence REAL, threshold REAL, reasons_json TEXT DEFAULT '[]', run_id TEXT, detail TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON doc_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_runs_ticket ON agent_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_actions_ticket ON tool_actions(ticket_id);
`;

class Database {
  constructor(filePath, schema = SCHEMA) {
    this.filePath = filePath;
    this.schema = schema;
    this.sql = null;
    this.batchDepth = 0;
  }

  async init({ fresh = false } = {}) {
    const SQL = await loadSql();
    if (!IN_MEMORY && !fresh && fs.existsSync(this.filePath)) {
      this.sql = new SQL.Database(fs.readFileSync(this.filePath));
    } else {
      this.sql = new SQL.Database();
    }
    this.sql.run('PRAGMA foreign_keys = ON;');
    this.sql.exec(this.schema);
  }

  save() {
    if (IN_MEMORY || !this.sql || this.batchDepth > 0) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, Buffer.from(this.sql.export()));
  }

  // Groups many writes into one transaction and a single disk flush.
  transaction(fn) {
    this.batchDepth++;
    this.sql.run('BEGIN');
    try {
      const out = fn();
      this.sql.run('COMMIT');
      return out;
    } catch (e) {
      this.sql.run('ROLLBACK');
      throw e;
    } finally {
      this.batchDepth--;
      this.save();
    }
  }

  run(query, params = []) {
    this.sql.run(query, params.map(p => (p === undefined ? null : p)));
    this.save();
  }

  get(query, params = []) {
    return this.all(query, params)[0] || null;
  }

  all(query, params = []) {
    const stmt = this.sql.prepare(query);
    stmt.bind(params.map(p => (p === undefined ? null : p)));
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

const DEMO_ORG_ID = 'org_demo';
const defaultDb = new Database(DB_PATH);
const tenants = new Map([[DEMO_ORG_ID, defaultDb]]);
const als = new AsyncLocalStorage();

const current = () => (als.getStore() && als.getStore().db) || defaultDb;

// Facade used by every service: queries go to the workspace of the current request
// (set by the auth middleware) or to the demo workspace outside a request.
const db = {
  init: opts => defaultDb.init(opts),
  run: (q, p) => current().run(q, p),
  get: (q, p) => current().get(q, p),
  all: (q, p) => current().all(q, p),
  transaction: fn => current().transaction(fn),
  save: () => current().save(),
  current,
};

async function openTenant(orgId) {
  if (tenants.has(orgId)) return tenants.get(orgId);
  const tdb = new Database(path.join(TENANT_DIR, `${orgId}.db`));
  await tdb.init();
  tenants.set(orgId, tdb);
  return tdb;
}

const withTenant = (orgId, tdb, fn) => als.run({ orgId, db: tdb }, fn);
const currentOrgId = () => (als.getStore() && als.getStore().orgId) || DEMO_ORG_ID;

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

module.exports = { db, parseJson, DB_PATH, IN_MEMORY, Database, openTenant, withTenant, currentOrgId, DEMO_ORG_ID };
