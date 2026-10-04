require('./lib/env').loadEnv();
const { db, DB_PATH } = require('./db');
const accounts = require('./services/accounts');
const { ensureSeeded } = require('./seed');
const { createApp } = require('./app');
const llm = require('./llm');

const PORT = Number(process.env.PORT) || 8000;

async function start() {
  await db.init();
  await accounts.init();
  const counts = ensureSeeded();
  const app = createApp();
  app.listen(PORT, () => {
    const cfg = llm.config();
    console.log(`TrustDesk running on http://localhost:${PORT}`);
    console.log(`  database: ${DB_PATH}`);
    console.log(`  model:    ${cfg.provider} (${cfg.model})${cfg.provider === 'mock' ? '  — set GEMINI_API_KEY in .env to use Gemini' : ''}`);
    console.log(`  data:     ${counts.documents} documents, ${counts.tickets} tickets, ${counts.customers} customers`);
  });
}

start().catch(e => { console.error(e); process.exit(1); });
