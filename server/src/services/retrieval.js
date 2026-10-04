// Local BM25 retrieval over heading-aware chunks (documented substitute for a vector DB).
// The same index class serves the workspace (from SQLite) and the eval runner (from the policy files).

const { db } = require('../db');
const { queryGroups, tokenize } = require('../lib/text');

const K1 = 1.2;
const B = 0.75;
const SYNONYM_DISCOUNT = 0.8;

class SearchIndex {
  constructor(chunks) {
    this.chunks = chunks.map(c => {
      // Title and heading terms are repeated so section topics weigh more than passing mentions.
      const terms = tokenize(`${c.title} ${c.title} ${c.heading} ${c.heading} ${c.content}`);
      const tf = new Map();
      for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
      return { ...c, tf, len: terms.length };
    });
    this.df = new Map();
    for (const c of this.chunks) for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.avgLen = this.chunks.reduce((a, c) => a + c.len, 0) / Math.max(1, this.chunks.length);
    // Unknown words (product names, places) get the median IDF so one of them can't dominate coverage.
    const idfs = [...this.df.keys()].map(t => this.idf(t)).sort((a, b) => a - b);
    this.oovWeight = idfs.length ? idfs[Math.floor(idfs.length / 2)] : 1;
  }

  idf(term) {
    const n = this.chunks.length;
    const df = this.df.get(term) || 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  /**
   * @param {string} query
   * @param {{limit?:number, visibility?:'public'|'internal', includeQuarantined?:boolean}} opts
   *   visibility 'public' hides internal-only docs (used by the customer widget).
   * Quarantined documents are never returned as context; matches are reported separately for the trace.
   */
  search(query, { limit = 5, visibility = 'internal', includeQuarantined = false } = {}) {
    // Coverage is IDF-weighted, so generic words like "policy" or "customer" count little and
    // questions about uncovered topics score low.
    const groups = queryGroups(query).map(g => ({ ...g, weight: this.df.has(g.base) ? this.idf(g.base) : this.oovWeight }));
    const totalWeight = groups.reduce((a, g) => a + g.weight, 0);
    const scored = [];
    const quarantinedHits = new Set();

    for (const c of this.chunks) {
      // Each query word scores once (best of its stem and synonyms) so expansions don't double count.
      let score = 0;
      const matched = [];
      for (const g of groups) {
        let best = 0;
        let bestForm = null;
        for (const f of g.forms) {
          const tf = c.tf.get(f);
          if (!tf) continue;
          const s = this.idf(f) * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * c.len / this.avgLen)) * (f === g.base ? 1 : SYNONYM_DISCOUNT);
          if (s > best) { best = s; bestForm = f; }
        }
        if (best > 0) { score += best; matched.push(bestForm); }
      }
      if (score <= 0) continue;
      if (c.trust === 'quarantined') {
        if (score > 1.5) quarantinedHits.add(c.doc_id);
        if (!includeQuarantined) continue;
      }
      if (visibility === 'public' && c.visibility === 'internal') continue;
      const hit = groups.filter(g => g.forms.some(f => c.tf.has(f)));
      const coverage = totalWeight ? hit.reduce((a, g) => a + g.weight, 0) / totalWeight : 0;
      scored.push({
        chunk_id: c.chunk_id, doc_id: c.doc_id, title: c.title, heading: c.heading, content: c.content,
        visibility: c.visibility, trust: c.trust, score: +score.toFixed(3), coverage: +coverage.toFixed(2), matched_terms: matched,
        matched_groups: hit.length, query_groups: groups.length,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return { results: scored.slice(0, limit), quarantined_doc_ids: [...quarantinedHits] };
  }

  // IDF-weighted share of the query's words that appear in one chunk (0..1).
  coverage(query, chunkId) {
    const c = this.chunks.find(x => x.chunk_id === chunkId);
    if (!c) return 0;
    const groups = queryGroups(query).map(g => ({ ...g, weight: this.df.has(g.base) ? this.idf(g.base) : this.oovWeight }));
    const total = groups.reduce((a, g) => a + g.weight, 0);
    return total ? +(groups.filter(g => g.forms.some(f => c.tf.has(f))).reduce((a, g) => a + g.weight, 0) / total).toFixed(2) : 0;
  }

  // Best chunk per document, for "which documents are relevant" questions.
  searchDocuments(query, opts = {}) {
    const { results, quarantined_doc_ids } = this.search(query, { ...opts, limit: 50 });
    const byDoc = new Map();
    for (const r of results) if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, r);
    return { results: [...byDoc.values()].slice(0, opts.limit || 5), quarantined_doc_ids };
  }
}

// One cached index per workspace database.
const cache = new WeakMap();

function workspaceIndex() {
  let cached = cache.get(db.current());
  if (!cached) {
    const rows = db.all(`SELECT c.chunk_id, c.doc_id, c.heading, c.content, d.title, d.visibility, d.trust
                         FROM doc_chunks c JOIN documents d ON d.doc_id = c.doc_id ORDER BY c.doc_id, c.position`);
    cached = new SearchIndex(rows);
    cache.set(db.current(), cached);
  }
  return cached;
}

function invalidate() { cache.delete(db.current()); }

module.exports = { SearchIndex, workspaceIndex, invalidate };
