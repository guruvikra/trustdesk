// Knowledge base: documents, ingestion jobs, search playground.
const express = require('express');
const multer = require('multer');
const { db, parseJson } = require('../db');
const { httpError, requireRole, tenantScope } = require('../lib/http');
const ingest = require('../services/ingest');
const retrieval = require('../services/retrieval');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 10 } });

function formatDoc(d, withContent = false) {
  return {
    doc_id: d.doc_id, title: d.title, audience: d.audience, version: d.version, source_type: d.source_type, source_path: d.source_path,
    visibility: d.visibility, trust: d.trust, trust_reasons: parseJson(d.trust_reasons_json, []), chunk_count: d.chunk_count,
    characters: d.content.length, created_at: d.created_at, updated_at: d.updated_at, ...(withContent ? { content: d.content } : {}),
  };
}

router.get('/documents', (req, res) => {
  const rows = db.all('SELECT d.*, (SELECT COUNT(*) FROM doc_chunks c WHERE c.doc_id = d.doc_id) AS chunk_count FROM documents d ORDER BY d.doc_id');
  res.json(rows.map(d => formatDoc(d)));
});

router.get('/documents/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) throw httpError(400, 'q is required');
  const opts = { limit: Math.min(20, Number(req.query.limit) || 6), visibility: req.query.visibility === 'public' ? 'public' : 'internal' };
  const out = req.query.mode === 'documents' ? retrieval.workspaceIndex().searchDocuments(q, opts) : retrieval.workspaceIndex().search(q, opts);
  res.json({ query: q, ...out });
});

router.get('/documents/:id', (req, res) => {
  const d = db.get('SELECT d.*, (SELECT COUNT(*) FROM doc_chunks c WHERE c.doc_id = d.doc_id) AS chunk_count FROM documents d WHERE doc_id = ?', [req.params.id]);
  if (!d) throw httpError(404, `Document ${req.params.id} not found`);
  res.json({ ...formatDoc(d, true), chunks: db.all('SELECT chunk_id, position, heading, content FROM doc_chunks WHERE doc_id = ? ORDER BY position', [d.doc_id]) });
});

/**
 * Ingest one or more documents. Accepts any of:
 *   JSON {documents:[{doc_id?, title?, content, audience?, visibility?}]} or a single document object
 *   JSON {url}
 *   multipart form with files[] (.pdf .md .txt .html) plus optional visibility
 * Returns 202 with a job id; poll GET /ingest-jobs/:id.
 */
router.post('/documents/ingest', upload.array('files'), tenantScope, (req, res) => {
  const b = req.body || {};
  const visibility = ['public', 'internal'].includes(b.visibility) ? b.visibility : undefined;
  let jobId;
  if (req.files && req.files.length) {
    const files = req.files;
    jobId = ingest.submitIngestJob(files.map(f => f.originalname).join(', '), async (log) => {
      const docs = [];
      for (const f of files) {
        try {
          const ex = await ingest.extractFile(f);
          if (!ex.content.trim()) { log(`No extractable text in ${f.originalname} (scanned/image-only PDF? OCR is not supported)`); continue; }
          log(`Extracted ${ex.content.length} characters from ${f.originalname}`);
          docs.push({ ...ex, visibility, source_path: `upload/${f.originalname}` });
        } catch (e) { log(`Failed to read ${f.originalname}: ${e.message}`); }
      }
      return docs;
    });
  } else if (b.url) {
    jobId = ingest.submitIngestJob(b.url, async (log) => {
      const ex = await ingest.fetchUrl(b.url);
      log(`Fetched ${ex.content.length} characters from ${b.url}`);
      return [{ ...ex, visibility }];
    });
  } else {
    const docs = Array.isArray(b.documents) ? b.documents : b.content ? [b] : [];
    if (!docs.length) throw httpError(400, 'Provide documents[], content, url, or files');
    jobId = ingest.submitIngestJob(docs.map(d => d.doc_id || d.title || 'document').join(', '),
      docs.map(d => ({ doc_id: d.doc_id, title: d.title, content: d.content, audience: d.audience, version: d.version, visibility: d.visibility || visibility, source_type: d.source_type || 'manual' })));
  }
  res.status(202).json({ job_id: jobId, status: 'queued' });
});

router.post('/documents/resync', (req, res) => {
  res.status(202).json({ job_id: ingest.submitIngestJob('data/knowledge_base (policy pack)', 'folder'), status: 'queued' });
});

router.patch('/documents/:id', requireRole('support_manager', 'admin'), (req, res) => {
  const d = db.get('SELECT * FROM documents WHERE doc_id = ?', [req.params.id]);
  if (!d) throw httpError(404, `Document ${req.params.id} not found`);
  const visibility = ['public', 'internal'].includes(req.body.visibility) ? req.body.visibility : d.visibility;
  const trust = ['trusted', 'quarantined'].includes(req.body.trust) ? req.body.trust : d.trust;
  const reasons = parseJson(d.trust_reasons_json, []);
  if (trust !== d.trust) reasons.push(`${trust === 'trusted' ? 'Released' : 'Quarantined'} manually by ${req.user.email} at ${new Date().toISOString()}`);
  db.run('UPDATE documents SET visibility = ?, trust = ?, trust_reasons_json = ?, updated_at = ? WHERE doc_id = ?', [visibility, trust, JSON.stringify(reasons), new Date().toISOString(), d.doc_id]);
  retrieval.invalidate();
  res.json(formatDoc({ ...db.get('SELECT * FROM documents WHERE doc_id = ?', [d.doc_id]), chunk_count: db.get('SELECT COUNT(*) AS n FROM doc_chunks WHERE doc_id = ?', [d.doc_id]).n }));
});

router.delete('/documents/:id', requireRole('support_manager', 'admin'), (req, res) => {
  if (!db.get('SELECT doc_id FROM documents WHERE doc_id = ?', [req.params.id])) throw httpError(404, `Document ${req.params.id} not found`);
  db.transaction(() => {
    db.run('DELETE FROM doc_chunks WHERE doc_id = ?', [req.params.id]);
    db.run('DELETE FROM documents WHERE doc_id = ?', [req.params.id]);
  });
  retrieval.invalidate();
  res.json({ deleted: req.params.id });
});

router.get('/ingest-jobs', (req, res) => {
  res.json(db.all('SELECT job_id FROM ingest_jobs ORDER BY created_at DESC LIMIT 20').map(j => ingest.getJob(j.job_id)));
});

router.get('/ingest-jobs/:id', (req, res) => {
  const j = ingest.getJob(req.params.id);
  if (!j) throw httpError(404, `Job ${req.params.id} not found`);
  res.json(j);
});

module.exports = router;
