// Accounts: organisations (workspaces), users, sessions. Stored in a separate control-plane
// database; each organisation's support data lives in its own workspace database.

const crypto = require('crypto');
const path = require('path');
const { Database, DB_PATH, IN_MEMORY, DEMO_ORG_ID } = require('../db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orgs (
  org_id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT NOT NULL UNIQUE, plan TEXT NOT NULL DEFAULT 'trial',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL, last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

const ROLES = ['admin', 'support_manager', 'support_agent'];
const DEMO_PASSWORD = () => process.env.DEMO_PASSWORD || 'trustdesk';
const DEMO_ACCOUNTS = [
  { user_id: 'usr_agent', name: 'Asha (Support Agent)', email: 'agent@trustdesk.dev', role: 'support_agent', token: 'demo-agent-token' },
  { user_id: 'usr_manager', name: 'Meera (Support Manager)', email: 'manager@trustdesk.dev', role: 'support_manager', token: 'demo-manager-token' },
  { user_id: 'usr_admin', name: 'Admin', email: 'admin@trustdesk.dev', role: 'admin', token: 'demo-admin-token' },
];

const store = new Database(IN_MEMORY ? ':memory:' : path.join(path.dirname(DB_PATH), 'trustdesk_accounts.db'), SCHEMA);

const err = (status, message) => Object.assign(new Error(message), { status });
const id = prefix => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

function publicUser(u) {
  return u && { user_id: u.user_id, name: u.name, email: u.email, role: u.role, org_id: u.org_id, created_at: u.created_at, last_login_at: u.last_login_at };
}

function publicOrg(o) {
  return o && { org_id: o.org_id, name: o.name, public_key: o.public_key, plan: o.plan, created_at: o.created_at, is_demo: o.org_id === DEMO_ORG_ID };
}

async function init() {
  await store.init();
  // The demo workspace and its fixed demo sessions always exist (used by tests and the "Try the demo" button).
  if (!store.get('SELECT org_id FROM orgs WHERE org_id = ?', [DEMO_ORG_ID])) {
    store.run('INSERT INTO orgs (org_id, name, public_key, plan, created_at) VALUES (?,?,?,?,?)',
      [DEMO_ORG_ID, 'BlueGadgets (demo)', 'pk_demo', 'demo', new Date().toISOString()]);
  }
  for (const a of DEMO_ACCOUNTS) {
    const existing = store.get('SELECT password_hash FROM accounts WHERE user_id = ?', [a.user_id]);
    if (!existing) {
      store.run('INSERT INTO accounts (user_id, org_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)',
        [a.user_id, DEMO_ORG_ID, a.name, a.email, hashPassword(DEMO_PASSWORD()), a.role, new Date().toISOString()]);
    } else if (!verifyPassword(DEMO_PASSWORD(), existing.password_hash)) {
      store.run('UPDATE accounts SET password_hash = ? WHERE user_id = ?', [hashPassword(DEMO_PASSWORD()), a.user_id]);
    }
    store.run('INSERT OR IGNORE INTO sessions (token, user_id, created_at) VALUES (?,?,?)', [a.token, a.user_id, new Date().toISOString()]);
  }
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  store.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?,?,?)', [token, userId, new Date().toISOString()]);
  store.run('UPDATE accounts SET last_login_at = ? WHERE user_id = ?', [new Date().toISOString(), userId]);
  return token;
}

function validateCredentials({ email, password, name }) {
  if (!name || !String(name).trim()) throw err(400, 'Name is required');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) throw err(400, 'A valid email is required');
  if (!password || String(password).length < 8) throw err(400, 'Password must be at least 8 characters');
  if (store.get('SELECT user_id FROM accounts WHERE lower(email) = lower(?)', [email])) throw err(409, 'An account with this email already exists');
}

// Creates an organisation and its owner. The caller initialises the workspace database.
function signup({ name, email, password, company }) {
  validateCredentials({ name, email, password });
  if (!company || !String(company).trim()) throw err(400, 'Company name is required');
  const orgId = id('org');
  const userId = id('usr');
  const now = new Date().toISOString();
  store.transaction(() => {
    store.run('INSERT INTO orgs (org_id, name, public_key, plan, created_at) VALUES (?,?,?,?,?)',
      [orgId, String(company).trim(), `pk_${crypto.randomBytes(8).toString('hex')}`, 'trial', now]);
    store.run('INSERT INTO accounts (user_id, org_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)',
      [userId, orgId, String(name).trim(), String(email).trim().toLowerCase(), hashPassword(password), 'admin', now]);
  });
  const token = createSession(userId);
  return { token, user: publicUser(getUser(userId)), org: publicOrg(getOrg(orgId)) };
}

function login({ email, password }) {
  const u = email ? store.get('SELECT * FROM accounts WHERE lower(email) = lower(?)', [String(email).trim()]) : null;
  if (!u || !password || !verifyPassword(password, u.password_hash)) throw err(401, 'Invalid email or password');
  const token = createSession(u.user_id);
  return { token, user: publicUser(getUser(u.user_id)), org: publicOrg(getOrg(u.org_id)) };
}

function logout(token) { store.run('DELETE FROM sessions WHERE token = ?', [token]); }

const SESSION_DAYS = 30;

function sessionUser(token) {
  if (!token) return null;
  const u = store.get('SELECT a.*, s.created_at AS session_created FROM sessions s JOIN accounts a ON a.user_id = s.user_id WHERE s.token = ?', [token]);
  const isDemo = DEMO_ACCOUNTS.some(a => a.token === token);
  if (u && !isDemo && Date.now() - new Date(u.session_created).getTime() > SESSION_DAYS * 86400000) {
    store.run('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  return u ? { user: publicUser(u), org: publicOrg(getOrg(u.org_id)) } : null;
}

const getUser = userId => store.get('SELECT * FROM accounts WHERE user_id = ?', [userId]);
const getOrg = orgId => store.get('SELECT * FROM orgs WHERE org_id = ?', [orgId]);
const getOrgByKey = key => publicOrg(store.get('SELECT * FROM orgs WHERE public_key = ?', [key]));

function renameOrg(orgId, name) {
  if (!name || !String(name).trim()) throw err(400, 'Name is required');
  store.run('UPDATE orgs SET name = ? WHERE org_id = ?', [String(name).trim(), orgId]);
  return publicOrg(getOrg(orgId));
}

// --- Team -----------------------------------------------------------------

function listTeam(orgId) {
  return store.all('SELECT * FROM accounts WHERE org_id = ? ORDER BY created_at', [orgId]).map(publicUser);
}

// Adds a teammate with a generated temporary password (returned once; no email service in this demo).
function invite(orgId, { name, email, role }) {
  if (!ROLES.includes(role)) throw err(400, `role must be one of ${ROLES.join(', ')}`);
  const tempPassword = `td-${crypto.randomBytes(5).toString('hex')}`;
  validateCredentials({ name, email, password: tempPassword });
  const userId = id('usr');
  store.run('INSERT INTO accounts (user_id, org_id, name, email, password_hash, role, created_at) VALUES (?,?,?,?,?,?,?)',
    [userId, orgId, String(name).trim(), String(email).trim().toLowerCase(), hashPassword(tempPassword), role, new Date().toISOString()]);
  return { user: publicUser(getUser(userId)), temporary_password: tempPassword };
}

function memberOf(orgId, userId) {
  const u = getUser(userId);
  if (!u || u.org_id !== orgId) throw err(404, 'Team member not found');
  return u;
}

function setRole(orgId, userId, role, actor) {
  if (!ROLES.includes(role)) throw err(400, `role must be one of ${ROLES.join(', ')}`);
  memberOf(orgId, userId);
  if (userId === actor.user_id && role !== 'admin') throw err(400, 'You cannot remove your own admin role');
  store.run('UPDATE accounts SET role = ? WHERE user_id = ?', [role, userId]);
  return publicUser(getUser(userId));
}

function removeMember(orgId, userId, actor) {
  memberOf(orgId, userId);
  if (userId === actor.user_id) throw err(400, 'You cannot remove yourself');
  store.transaction(() => {
    store.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
    store.run('DELETE FROM accounts WHERE user_id = ?', [userId]);
  });
  return { removed: userId };
}

const listOrgIds = () => store.all('SELECT org_id FROM orgs').map(r => r.org_id);

module.exports = {
  listOrgIds, init, signup, login, logout, sessionUser, getOrgByKey, renameOrg, listTeam, invite, setRole, removeMember,
  DEMO_ACCOUNTS, publicOrg, getOrg, ROLES,
};
