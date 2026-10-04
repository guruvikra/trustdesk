const { openTenant, withTenant, DEMO_ORG_ID } = require('../db');
const accounts = require('../services/accounts');

// Wraps async route handlers so thrown errors reach the error middleware.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function bearer(req) {
  const header = req.get('authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : req.query.token;
}

// Session auth: resolves the user and their organisation, then runs the rest of the request
// inside that organisation's workspace database.
async function authenticate(req, res, next) {
  try {
    const session = accounts.sessionUser(bearer(req));
    if (!session) return res.status(401).json({ detail: 'Missing or invalid token. Log in via POST /api/auth/login.' });
    req.user = session.user;
    req.org = session.org;
    req.token = bearer(req);
    req.tenant = { orgId: session.org.org_id, db: await openTenant(session.org.org_id) };
    withTenant(req.tenant.orgId, req.tenant.db, next);
  } catch (e) { next(e); }
}

// Public surfaces (widget, webhooks) identify the workspace by its public key; no key = demo workspace.
async function publicWorkspace(req, res, next) {
  try {
    const key = req.get('X-Workspace-Key') || req.query.key || (req.body && req.body.workspace_key);
    const org = key ? accounts.getOrgByKey(key) : accounts.publicOrg(accounts.getOrg(DEMO_ORG_ID));
    if (!org) return res.status(404).json({ detail: 'Unknown workspace key' });
    req.org = org;
    req.tenant = { orgId: org.org_id, db: await openTenant(org.org_id) };
    withTenant(req.tenant.orgId, req.tenant.db, next);
  } catch (e) { next(e); }
}

// Middleware that resumes callbacks from streams/events (e.g. multer) lose the async context;
// put this after such middleware to re-enter the request's workspace.
const tenantScope = (req, res, next) => (req.tenant ? withTenant(req.tenant.orgId, req.tenant.db, next) : next());

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({ detail: `Requires role: ${roles.join(' or ')}` });
  next();
};

function errorHandler(err, req, res, _next) {
  if (err.code && String(err.code).startsWith('LIMIT_')) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 15 MB)' : err.code === 'LIMIT_FILE_COUNT' ? 'Too many files (max 10 per upload)' : err.message;
    return res.status(400).json({ detail: msg });
  }
  if (err.type === 'entity.too.large') return res.status(413).json({ detail: 'Request body is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON body' });
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', req.method, req.path, err);
  res.status(status).json({ detail: err.message, ...(err.extra || {}) });
}

module.exports = { wrap, httpError, authenticate, publicWorkspace, tenantScope, requireRole, errorHandler, bearer };
