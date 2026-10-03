const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '../../trustdesk_node.db');
const DATA_DIR = path.resolve(__dirname, '../../data');

class SqlJsWrapper {
  constructor() {
    this.sqlDb = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    const SQL = await initSqlJs();
    if (fs.existsSync(DB_PATH)) {
      const fileBuffer = fs.readFileSync(DB_PATH);
      this.sqlDb = new SQL.Database(fileBuffer);
    } else {
      this.sqlDb = new SQL.Database();
    }
    this.initialized = true;
  }

  save() {
    if (!this.sqlDb) return;
    try {
      const data = this.sqlDb.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(DB_PATH, buffer);
    } catch (e) {
      console.error('[DB] Failed to save database to disk:', e.message);
    }
  }

  _cleanParams(params) {
    if (!Array.isArray(params)) return [];
    return params.map(p => (p === undefined ? null : p));
  }

  run(sql, params = []) {
    if (!this.sqlDb) throw new Error('Database not initialized');
    this.sqlDb.run(sql, this._cleanParams(params));
    this.save();
    return { changes: 1 };
  }

  get(sql, params = []) {
    if (!this.sqlDb) throw new Error('Database not initialized');
    const stmt = this.sqlDb.prepare(sql);
    stmt.bind(this._cleanParams(params));
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  }

  all(sql, params = []) {
    if (!this.sqlDb) throw new Error('Database not initialized');
    const stmt = this.sqlDb.prepare(sql);
    stmt.bind(this._cleanParams(params));
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  exec(sql) {
    if (!this.sqlDb) throw new Error('Database not initialized');
    this.sqlDb.run(sql);
    this.save();
  }
}

const db = new SqlJsWrapper();

async function initDatabase() {
  await db.init();

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      tier TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      status TEXT NOT NULL,
      placed_at TEXT,
      delivered_at TEXT,
      eligible_return_until TEXT,
      total REAL NOT NULL,
      currency TEXT DEFAULT 'INR',
      payment_status TEXT DEFAULT 'paid',
      tracking_number TEXT,
      items_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      customer_id TEXT,
      order_id TEXT,
      channel TEXT NOT NULL,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      triage_category TEXT,
      triage_priority TEXT,
      triage_sentiment TEXT,
      triage_escalation INTEGER DEFAULT 0,
      expected_category TEXT,
      expected_priority TEXT,
      expected_sentiment TEXT,
      expected_escalation INTEGER,
      expected_actions_json TEXT
    );

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      doc_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'public',
      version TEXT NOT NULL DEFAULT '2026.07',
      is_untrusted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_actions (
      action_id TEXT PRIMARY KEY,
      tool_name TEXT NOT NULL,
      description TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      requires_approval INTEGER NOT NULL,
      allowed_categories_json TEXT,
      required_fields_json TEXT,
      extra_json TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      request_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      ticket_id TEXT,
      customer_id TEXT,
      order_id TEXT,
      idempotency_key TEXT UNIQUE,
      parameters_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      reviewed_by TEXT,
      reviewed_at TEXT,
      execution_result_json TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      run_id TEXT PRIMARY KEY,
      ticket_id TEXT,
      run_type TEXT NOT NULL,
      model TEXT NOT NULL,
      retrieved_doc_ids_json TEXT NOT NULL,
      guardrail_results_json TEXT NOT NULL,
      draft_reply TEXT,
      citations_json TEXT NOT NULL,
      recommended_action TEXT,
      latency_ms INTEGER DEFAULT 85,
      tokens_used INTEGER DEFAULT 420,
      cost_usd REAL DEFAULT 0.0018,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS eval_runs (
      eval_run_id TEXT PRIMARY KEY,
      run_at TEXT NOT NULL,
      dataset_size INTEGER NOT NULL,
      passed_cases INTEGER NOT NULL,
      failed_cases INTEGER NOT NULL,
      accuracy REAL NOT NULL,
      summary_json TEXT NOT NULL,
      details_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_users (
      user_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      department TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_jobs (
      job_id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      stage TEXT NOT NULL,
      chunks_indexed INTEGER NOT NULL DEFAULT 0,
      logs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS deflector_events (
      event_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      deflected INTEGER NOT NULL,
      resolved_doc_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS qna_feedback (
      feedback_id TEXT PRIMARY KEY,
      query TEXT NOT NULL,
      answer TEXT NOT NULL,
      doc_id TEXT,
      rating TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await seedDataIfEmpty();
}

async function seedDataIfEmpty() {
  const existingDocs = db.get('SELECT COUNT(*) as count FROM knowledge_documents');
  if (existingDocs && existingDocs.count > 0) {
    return;
  }

  // 1. Seed Knowledge Documents
  const kbDir = path.join(DATA_DIR, 'knowledge_base');
  if (fs.existsSync(kbDir)) {
    const files = fs.readdirSync(kbDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const fullPath = path.join(kbDir, file);
        const content = fs.readFileSync(fullPath, 'utf8');
        
        let docId = 'KB-' + file.replace('.md', '').toUpperCase();
        let title = file.replace(/_/g, ' ').replace('.md', '');
        let audience = 'public';
        let isUntrusted = 0;
        let version = '2026.07';

        const lines = content.split('\n');
        for (const line of lines.slice(0, 10)) {
          if (line.toLowerCase().startsWith('document id:')) docId = line.split(':')[1].trim();
          if (line.toLowerCase().startsWith('title:')) title = line.split(':')[1].trim();
          if (line.toLowerCase().startsWith('audience:')) audience = line.split(':')[1].trim();
          if (line.toLowerCase().startsWith('version:')) version = line.split(':')[1].trim();
        }

        if (file.includes('adversarial') || docId.includes('ADVERSARIAL')) {
          isUntrusted = 1;
        }

        db.run(
          `INSERT OR REPLACE INTO knowledge_documents (doc_id, title, source_path, content, audience, version, is_untrusted, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
          [docId, title, `data/knowledge_base/${file}`, content, audience, version, isUntrusted]
        );
      }
    }
  }

  // 2. Seed Customers
  const custPath = path.join(DATA_DIR, 'customers.json');
  if (fs.existsSync(custPath)) {
    const customers = JSON.parse(fs.readFileSync(custPath, 'utf8'));
    for (const c of customers) {
      db.run(
        `INSERT OR REPLACE INTO customers (customer_id, name, email, tier, verified, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [c.customer_id, c.name, c.email, c.tier, c.verified ? 1 : 0, c.created_at || '2026-01-01T00:00:00Z']
      );
    }
  }

  // 3. Seed Orders
  const ordersPath = path.join(DATA_DIR, 'orders.json');
  if (fs.existsSync(ordersPath)) {
    const orders = JSON.parse(fs.readFileSync(ordersPath, 'utf8'));
    for (const o of orders) {
      db.run(
        `INSERT OR REPLACE INTO orders (order_id, customer_id, status, placed_at, delivered_at, eligible_return_until, total, currency, payment_status, tracking_number, items_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [o.order_id, o.customer_id, o.status, o.placed_at, o.delivered_at, o.eligible_return_until, o.total || 0, o.currency || 'INR', o.payment_status || 'paid', o.tracking_number, JSON.stringify(o.items || [])]
      );
    }
  }

  // 4. Seed Tool Actions
  const toolsPath = path.join(DATA_DIR, 'tool_actions.json');
  if (fs.existsSync(toolsPath)) {
    const tools = JSON.parse(fs.readFileSync(toolsPath, 'utf8'));
    for (const t of tools) {
      db.run(
        `INSERT OR REPLACE INTO tool_actions (action_id, tool_name, description, risk_level, requires_approval, allowed_categories_json, required_fields_json, extra_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.tool_name,
          t.tool_name,
          t.description,
          t.risk_level,
          t.requires_human_approval ? 1 : 0,
          JSON.stringify(t.allowed_categories || []),
          JSON.stringify(t.required_fields || []),
          JSON.stringify(t)
        ]
      );
    }
  }

  // 5. Seed Tickets
  const ticketsPath = path.join(DATA_DIR, 'tickets.json');
  if (fs.existsSync(ticketsPath)) {
    const tickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
    for (const t of tickets) {
      db.run(
        `INSERT OR REPLACE INTO tickets 
         (ticket_id, customer_id, order_id, channel, subject, body, created_at, status,
          expected_category, expected_priority, expected_sentiment, expected_escalation, expected_actions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.ticket_id,
          t.customer_id,
          t.order_id,
          t.channel,
          t.subject,
          t.body,
          t.created_at,
          t.status || 'open',
          t.expected_category,
          t.expected_priority,
          t.expected_sentiment,
          t.expected_escalation ? 1 : 0,
          JSON.stringify(t.expected_actions || [])
        ]
      );
    }
  }

  // 6. Seed Default Staff
  const defaultStaff = [
    { user_id: 'usr_001', name: 'Nikhil S (Admin)', email: 'nikhil@atatus.com', role: 'admin', department: 'Executive Support' },
    { user_id: 'usr_002', name: 'Janani S', email: 'jananis@atatus.com', role: 'support_manager', department: 'Returns & Escalations' },
    { user_id: 'usr_003', name: 'Parthasarathi', email: 'parthasarathi@atatus.com', role: 'support_agent', department: 'Frontline Customer Success' },
    { user_id: 'usr_004', name: 'Demo Agent', email: 'agent@trustdesk.internal', role: 'support_agent', department: 'Triage Squad' }
  ];
  for (const s of defaultStaff) {
    db.run(
      `INSERT OR REPLACE INTO staff_users (user_id, name, email, role, department, created_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      [s.user_id, s.name, s.email, s.role, s.department]
    );
  }

  db.save();
  console.log('[DB] TrustDesk Node database seeded successfully with Airtribe dataset.');
}

module.exports = {
  db,
  initDatabase,
  DB_PATH
};
