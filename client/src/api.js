// Thin fetch wrapper that attaches the demo bearer token and surfaces API error details.
const KEY = 'trustdesk_session';
let memory = null; // fallback when storage is unavailable

export const session = {
  read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return memory; } },
  get token() { const s = this.read(); return s && s.token; },
  save(data) { memory = data; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* storage unavailable */ } },
  clear() { memory = null; try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ } },
};

export async function api(path, { method = 'GET', body, form, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (session.token) opts.headers.Authorization = `Bearer ${session.token}`;
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text }; }
  if (res.status === 401 && session.token && !path.startsWith('/api/auth/')) {
    // Session expired or the user was removed: send them back to the login page.
    session.clear();
    window.dispatchEvent(new Event('trustdesk:logout'));
  }
  if (!res.ok) {
    const err = new Error((data && data.detail) || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// Polls fn until done(result) is true or the timeout passes.
export async function poll(fn, done, { interval = 600, timeout = 120000 } = {}) {
  const start = Date.now();
  for (;;) {
    const r = await fn();
    if (done(r)) return r;
    if (Date.now() - start > timeout) throw new Error('Timed out waiting for background job');
    await new Promise(res => setTimeout(res, interval));
  }
}
