// Usage: npm run reset            -> demo workspace (provided dataset)
//        npm run reset -- --empty -> empty workspace for real data (keeps the policy pack)
//        npm run reset -- --empty --no-docs -> completely empty knowledge base too
require('../src/lib/env').loadEnv();
const { db } = require('../src/db');
const { reset } = require('../src/seed');

(async () => {
  await db.init({ fresh: true });
  const mode = process.argv.includes('--empty') ? 'empty' : 'demo';
  const out = reset({ mode, keepDocuments: !process.argv.includes('--no-docs') });
  console.log(`Workspace reset (${mode}):`, out);
})().catch(e => { console.error(e); process.exit(1); });
