const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { authenticate, errorHandler } = require('./lib/http');
const llm = require('./llm');

function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '5mb' }));

  app.get(['/health', '/api/health'], (req, res) => res.json({ status: 'ok', service: 'trustdesk', llm: llm.config() }));

  app.use('/api', require('./routes/public'));
  app.use('/api', authenticate, require('./routes/helpdesk'));
  app.use('/api', authenticate, require('./routes/knowledge'));
  app.use('/api', authenticate, require('./routes/platform'));
  app.use('/api', (req, res) => res.status(404).json({ detail: `No route ${req.method} ${req.path}` }));

  // Embeddable widget script and the built React dashboard.
  const publicDir = path.resolve(__dirname, '../public');
  app.use(express.static(publicDir));
  app.get('*', (req, res) => {
    const index = path.join(publicDir, 'index.html');
    if (fs.existsSync(index)) return res.sendFile(index);
    res.status(404).send('Frontend not built. Run "npm run build" from the repo root.');
  });

  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
