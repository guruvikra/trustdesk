// Tiny .env loader (repo root or server/), so no extra dependency is needed.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  for (const file of [path.resolve(__dirname, '../../../.env'), path.resolve(__dirname, '../../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2];
      // Quoted values are taken literally; unquoted values may end with an inline "# comment".
      if (/^["'].*["']$/.test(v)) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '').trim();
      // Empty values behave like "not set" (e.g. LLM_PROVIDER= or ZENDESK_CLIENT_ID=).
      if (v !== '') process.env[m[1]] = v;
    }
  }
}

module.exports = { loadEnv };
