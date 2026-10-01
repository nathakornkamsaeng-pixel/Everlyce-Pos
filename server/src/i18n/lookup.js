const { coll } = require('../db');

const SUPPORTED = ['th', 'en'];

// Look up a published translation for a source string. Unknown strings fall back to English.
function lookup(source) {
  if (source == null) return null;
  const key = String(source).trim();
  if (!key) return null;
  const entry = coll('translations').find((t) => t.source === key && t.status === 'published' && t.th);
  return entry ? entry.th : key;
}

function normalizeLang(input, fallback = 'th') {
  const lang = String(input || '').toLowerCase();
  return SUPPORTED.includes(lang) ? lang : fallback;
}

function tr(source, lang) {
  if (lang === 'en') return source == null ? null : String(source);
  return lookup(source);
}

module.exports = { tr, lookup, normalizeLang, SUPPORTED };
