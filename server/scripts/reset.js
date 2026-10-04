// Usage: npm run reset            -> demo workspace (provided dataset)
//        npm run reset -- --empty -> empty workspace for real data (keeps the policy pack)
//        npm run reset -- --empty --no-docs -> completely empty knowledge base too
require('../src/lib/env').loadEnv();
const { db } = require('../src/db');
const { reset } = require('../src/seed');

// The running server keeps the database in memory and would overwrite this reset, so refuse.
function serverRunning(port) {
  return new Promise(resolve => {
    const sock = require('net').connect(port, '127.0.0.1');
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

(async () => {
  const port = Number(process.env.PORT) || 8000;
  if (!process.argv.includes('--force') && await serverRunning(port)) {
    console.error(`TrustDesk is running on port ${port}. Stop it first, or use Settings → Model & data → Load sample data in the app.`);
    process.exit(1);
  }
  await db.init({ fresh: true });
  const mode = process.argv.includes('--empty') ? 'empty' : 'demo';
  const out = reset({ mode, keepDocuments: !process.argv.includes('--no-docs') });
  console.log(`Workspace reset (${mode}):`, out);
})().catch(e => { console.error(e); process.exit(1); });
