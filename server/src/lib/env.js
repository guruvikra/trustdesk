// Tiny .env loader (repo root or server/), so no extra dependency is needed.
const fs = require('fs');
const path = require('path');

function loadEnv() {
  for (const file of [path.resolve(__dirname, '../../../.env'), path.resolve(__dirname, '../../.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

module.exports = { loadEnv };
