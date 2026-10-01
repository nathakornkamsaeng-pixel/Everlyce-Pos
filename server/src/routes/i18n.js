const express = require('express');
const { coll } = require('../db');
const { requireAuth } = require('../middleware');
const { builtInTranslations } = require('../i18n/engine');

const router = express.Router();

function findEntry(source) {
  const key = String(source || '').trim();
  return coll('translations').find((t) => t.source === key) || null;
}

function dto(t) {
  return {
    id: t.id,
    source: t.source,
    th: t.th,
    status: t.status,
    origin: t.origin,
    updatedAt: t.updatedAt,
    note: t.note || '',
  };
}

// Published map for any signed-in screen (cashier / kds / cds / admin review).
// One table, the shop's own: its app wording and its menu wording together,
// layered over the built-in phrasebook that ships with the software.
//
// The shop's entry wins on its own screens, because "Jasmine" on its menu means
// that shop's tea and not a word to be translated. The built-in copy is the
// fallback for anything the shop has not translated, so a shop with an empty
// table still sees the software's own Thai.
//
// The platform's own pages, the home page and the privacy notice, are not here.
// Those are served from platformContent and read from /api/platform/content.
function mapFor() {
  const map = builtInTranslations();
  const apply = (list) => {
    for (const t of list || []) {
      if (t.status !== 'published' || !t.th) continue;
      const source = String(t.source).trim().replace(/\s+/g, ' ');
      if (!source) continue;
      map[source] = t.th;
      map[source.toLowerCase()] = t.th;
    }
  };
  apply(coll('translations'));
  return map;
}

// Customers are not signed in, but their QR menu still has to speak Thai.
// This is only UI wording and menu names — the same data the public menu
// endpoint already exposes — so it needs no account.
router.get('/public', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(mapFor());
});

router.get('/', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(mapFor());
});

// Editing these strings is a platform job, not a store one: see
// routes/platformI18n.js. This file only serves them.
//
// Reading stays open to every store because every store needs them to render
// anything at all, and because they say nothing about any particular shop. A
// customer's QR menu is not signed in and must still read in Thai.
module.exports = router;
