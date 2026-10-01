// A shop's own wording: its menu, its categories, its modifiers, its staff.
//
// Distinct from the shared wording in routes/platformI18n.js, which is the
// software's own and is edited once for everybody. This is the shop's, and it is
// editable by the shop.
//
// Reads of the shared table are open to everyone; editing either table is
// restricted to whoever owns it. A shop cannot rewrite the software's buttons,
// and the platform cannot rewrite this shop's menu.

const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { translate, UI_STRINGS } = require('../i18n/engine');

const router = express.Router();
router.use(requireAuth);

const key = (entry) => String(entry.source || '').trim().replace(/\s+/g, ' ');

function findEntry(source) {
  const wanted = String(source || '').trim().replace(/\s+/g, ' ');
  return (coll('translations') || []).find((t) => t.source === wanted) || null;
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

router.get('/entries', requireRole('admin'), (req, res) => {
  const { status, q } = req.query;
  let list = (coll('translations') || []).slice()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (status) list = list.filter((t) => t.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((t) => key(t).toLowerCase().includes(needle) || String(t.th || '').toLowerCase().includes(needle));
  }
  const counts = (coll('translations') || []).reduce((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  res.json({ entries: list.map(dto), counts });
});

/**
 * Scan this shop and make sure every string it can see has an entry.
 *
 * Both halves, because both are this shop's: the app's own wording, which a shop
 * can reword for itself and which an install running its own server can change
 * without asking anyone, and this shop's menu content, which is nobody else's.
 *
 * What is not here is the platform's own pages. The home page and the privacy
 * notice are read before anyone is in a shop, and they belong to whoever runs the
 * platform.
 */
router.post('/collect', requireRole('admin'), async (req, res) => {
  const sources = new Set();
  const add = (v) => { const s = String(v == null ? '' : v).trim(); if (s) sources.add(s); };

  UI_STRINGS.forEach(add);
  (coll('categories') || []).forEach((c) => add(c.name));
  (coll('products') || []).forEach((p) => { add(p.name); add(p.description); });
  (coll('modifierGroups') || []).forEach((g) => add(g.name));
  (coll('modifierOptions') || []).forEach((o) => add(o.name));
  (coll('tables') || []).forEach((t) => add(t.name));

  const existing = new Set((coll('translations') || []).map((t) => t.source));
  const added = [];
  for (const source of sources) {
    if (existing.has(source)) continue;
    const entry = {
      id: nextId('translations'), source, th: '', status: 'missing',
      origin: '', note: '', createdAt: now(), updatedAt: now(),
    };
    coll('translations').push(entry);
    added.push(entry);
  }
  touch();
  res.json({ added: added.length, entries: added.map(dto) });
});

// Add one string by hand, for a menu item that was missed by a scan.
router.post('/entries', requireRole('admin'), (req, res) => {
  const source = String((req.body || {}).source || '').trim().replace(/\s+/g, ' ');
  if (!source) return res.status(400).json({ detail: 'source is required' });
  const existing = findEntry(source);
  if (existing) return res.json(dto(existing));
  const entry = {
    id: nextId('translations'), source, th: String((req.body || {}).th || '').slice(0, 500),
    // Starts unpublished even with Thai attached, so adding a word is never also
    // putting it live without being asked.
    status: 'draft', origin: 'local', note: '', createdAt: now(), updatedAt: now(),
  };
  coll('translations').push(entry);
  touch();
  res.status(201).json(dto(entry));
});

// Translate one string, or everything still missing, on request rather than on
// every save. A shop may well want to write its own Thai rather than accept a
// machine's, and a menu name is not a button.
router.post('/translate', requireRole('admin'), async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids.map(Number) : null;
  const targets = (coll('translations') || []).filter((t) => (
    ids ? ids.includes(Number(t.id)) : t.status !== 'published'
  ));
  let translated = 0;
  for (const entry of targets) {
    if (ids && ids.length && !ids.includes(Number(entry.id))) continue;
    const result = await translate(entry.source);
    const current = findEntry(entry.source);
    if (!current) continue;
    current.th = result.text;
    current.status = result.status;
    current.origin = result.origin;
    current.updatedAt = now();
    translated += 1;
  }
  touch();
  res.json({ translated });
});

// An edited translation is a draft until published, so a shop does not change
// its live menu on the strength of a typo.
router.put('/entries/:id', requireRole('admin'), (req, res) => {
  const entry = (coll('translations') || []).find((t) => Number(t.id) === Number(req.params.id));
  if (!entry) return res.status(404).json({ detail: 'Translation not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.th !== undefined) entry.th = String(body.th).slice(0, 500);
  if (body.source !== undefined && key({ source: body.source })) entry.source = key({ source: body.source });
  if (body.note !== undefined) entry.note = String(body.note).slice(0, 500);
  entry.status = 'draft';
  entry.origin = 'local';
  entry.updatedAt = now();
  touch();
  res.json(dto(entry));
});

router.post('/publish', requireRole('admin'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : null;
  const all = Boolean(body.all);
  // Only entries that actually have Thai: publishing an empty one would blank a
  // menu name that previously worked.
  const targets = (coll('translations') || []).filter((t) => t.th && (all || (ids && ids.includes(Number(t.id)))));
  for (const entry of targets) {
    entry.status = 'published';
    entry.updatedAt = now();
  }
  touch();
  res.json({ published: targets.length });
});

router.post('/unpublish/:id', requireRole('admin'), (req, res) => {
  const entry = (coll('translations') || []).find((t) => Number(t.id) === Number(req.params.id));
  if (!entry) return res.status(404).json({ detail: 'Translation not found' });
  entry.status = 'draft';
  entry.updatedAt = now();
  touch();
  res.json(dto(entry));
});

module.exports = router;
module.exports.router = router;