// Small text utilities shared by retrieval, the assistant and the mock model.

const STOPWORDS = new Set(`a an and are as at be been but by can could did do does for from had has have
how i if in into is it its just me my of on or our please so than that the their them then there these
they this to too up us was we were what when where which who why will with would you your yours am
also any all get got about after before over under again once only own same some such very more most
other out off now here hi hello times thanks thank dear team support help need want can't cant dont don't im i'm`
  .split(/\s+/).filter(Boolean));

// Light domain synonym expansion so customer wording matches policy wording.
const SYNONYMS = {
  charged: ['charge', 'duplicate'], twice: ['duplicate'], two: ['duplicate', 'double'], double: ['duplicate'], charges: ['charge', 'duplicate'],
  broken: ['damaged', 'defective'], cracked: ['damaged'], shattered: ['damaged'], faulty: ['defective'],
  stuck: ['movement', 'stale'], moved: ['movement'], parcel: ['package'], courier: ['carrier'],
  swollen: ['swelling', 'battery', 'safety'], swelling: ['battery', 'safety'], bulging: ['swelling', 'safety'],
  overheating: ['safety'], hot: ['overheating'], smoke: ['safety'], burning: ['safety'],
  voucher: ['coupon'], promo: ['coupon'], discount: ['coupon'], goodwill: ['coupon'],
  money: ['refund'], reimburse: ['refund'], return: ['refund', 'returned'],
  password: ['identity', 'verification'], email: ['account', 'identity'], login: ['account'],
  prompt: ['instructions', 'hidden'], secret: ['api', 'key'], token: ['authentication'],
  license: ['software'], subscription: ['software'], guarantee: ['warranty'],
  arrive: ['delivery', 'delivered'], arrival: ['delivery', 'delivered'], late: ['delivery'], delayed: ['delivery', 'tracking'], shipping: ['delivery'],
};

function stem(word) {
  let w = word;
  if (w.length > 5 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  // Drop a final "e" so charge/charged, arrive/arrived, damage/damaged share one stem.
  if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

// Synonyms are matched by raw word or by stem ("arrived" finds the entry for "arrive").
const SYNONYMS_BY_STEM = Object.fromEntries(Object.entries(SYNONYMS).map(([k, v]) => [stem(k), v]));
const synonymsOf = w => SYNONYMS[w] || SYNONYMS_BY_STEM[stem(w)] || [];

function rawWords(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter(Boolean);
}

// Terms used for indexing documents.
function tokenize(text) {
  return rawWords(text).filter(w => w.length > 1 && !STOPWORDS.has(w)).map(stem);
}

// Terms used for queries: tokenized plus synonym expansion (deduplicated).
function queryTerms(text) {
  const out = new Set();
  for (const w of rawWords(text)) {
    if (w.length <= 1 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
    for (const s of synonymsOf(w)) out.add(stem(s));
  }
  return [...out];
}

// Conversational filler that says nothing about the topic; ignored when measuring coverage only.
const FILLER = new Set(`bought buy buying purchased purchase last week weeks month months year years today yesterday tomorrow ago since
changed change mind supposed get getting got want wanted wants would could should like know tell told said really much many lot thing
things something someone anyone everything kindly sir madam asap quickly soon possible way time still already ok okay`.split(/\s+/).filter(Boolean));

// One group per distinct query word: its stem plus synonym stems (used for coverage scoring).
function queryGroups(text) {
  const groups = new Map();
  for (const w of rawWords(text)) {
    if (w.length <= 1 || STOPWORDS.has(w) || FILLER.has(w)) continue;
    const base = stem(w);
    if (!groups.has(base)) groups.set(base, new Set([base]));
    for (const syn of synonymsOf(w)) groups.get(base).add(stem(syn));
  }
  return [...groups.entries()].map(([base, forms]) => ({ base, forms: [...forms] }));
}

// Splits on paragraph breaks and bullets first (PDF/HTML text), then on sentence ends.
function splitSentences(text) {
  return String(text || '')
    .split(/\n\s*\n|\n(?=\s*(?:[•*\u2022-]|\d+[.)])\s)/)
    .flatMap(block => block.replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"'(•])/))
    .map(s => s.replace(/^[•*\u2022-]\s*/, '').trim())
    .filter(s => s.length > 20 && s.length < 600);
}

function includesAny(text, phrases) {
  const t = String(text || '').toLowerCase();
  return phrases.some(p => (p instanceof RegExp ? p.test(t) : t.includes(p)));
}

module.exports = { tokenize, queryTerms, queryGroups, splitSentences, stem, includesAny, STOPWORDS };
