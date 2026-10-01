const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

function dto(g) {
  return {
    ...g,
    productIds: Array.isArray(g.productIds) ? g.productIds : [],
    options: coll('modifierOptions')
      .filter((o) => o.groupId === g.id)
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
  };
}

function normalizeProductIds(value) {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0))];
}

router.get('/', (req, res) => {
  const productId = req.query.productId ? Number(req.query.productId) : null;
  let list = coll('modifierGroups');
  if (productId) list = list.filter((g) => (g.productIds || []).includes(productId));
  res.json(list.map(dto));
});

router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ detail: 'name is required' });
  const g = {
    id: nextId('modifierGroups'),
    productIds: normalizeProductIds(b.productIds),
    name: String(b.name),
    type: b.type === 'multiple' ? 'multiple' : 'single',
    required: !!b.required,
    minSelect: Number(b.minSelect) || 0,
    maxSelect: Number(b.maxSelect) || 0,
    sortOrder: Number(b.sortOrder) || 0,
    createdAt: now(),
  };
  coll('modifierGroups').push(g);
  for (const o of b.options || []) {
    coll('modifierOptions').push({
      id: nextId('modifierOptions'),
      groupId: g.id,
      name: o.name,
      priceAdj: Number(o.priceAdj) || 0,
      sortOrder: Number(o.sortOrder) || 0,
      createdAt: now(),
    });
  }
  touch();
  res.status(201).json(dto(g));
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const g = coll('modifierGroups').find((x) => x.id === Number(req.params.id));
  if (!g) return res.status(404).json({ detail: 'Modifier group not found' });
  const b = req.body || {};
  if (b.name !== undefined) g.name = String(b.name);
  if (b.productIds !== undefined) g.productIds = normalizeProductIds(b.productIds);
  if (b.type !== undefined) g.type = b.type === 'multiple' ? 'multiple' : 'single';
  if (b.required !== undefined) g.required = !!b.required;
  if (b.minSelect !== undefined) g.minSelect = Number(b.minSelect) || 0;
  if (b.maxSelect !== undefined) g.maxSelect = Number(b.maxSelect) || 0;
  if (b.sortOrder !== undefined) g.sortOrder = Number(b.sortOrder);

  const incoming = Array.isArray(b.options) ? b.options : null;
  if (incoming) {
    const existing = coll('modifierOptions').filter((o) => o.groupId === g.id);
    const existingById = new Map(existing.map((o) => [o.id, o]));
    const keep = [];
    for (const o of incoming) {
      if (o.id && existingById.has(Number(o.id))) {
        const ex = existingById.get(Number(o.id));
        if (o.name !== undefined) ex.name = String(o.name);
        if (o.priceAdj !== undefined) ex.priceAdj = Number(o.priceAdj);
        if (o.sortOrder !== undefined) ex.sortOrder = Number(o.sortOrder);
        keep.push(ex.id);
      } else if (o.name) {
        const n = {
          id: nextId('modifierOptions'),
          groupId: g.id,
          name: String(o.name),
          priceAdj: Number(o.priceAdj) || 0,
          sortOrder: Number(o.sortOrder) || 0,
          createdAt: now(),
        };
        coll('modifierOptions').push(n);
        keep.push(n.id);
      }
    }
    const keepSet = new Set(keep);
    const arr = coll('modifierOptions');
    arr.splice(0, arr.length, ...arr.filter((o) => o.groupId !== g.id || keepSet.has(o.id)));
  }
  touch();
  res.json(dto(g));
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const idx = coll('modifierGroups').findIndex((g) => g.id === id);
  if (idx === -1) return res.status(404).json({ detail: 'Modifier group not found' });
  coll('modifierGroups').splice(idx, 1);
  const arr = coll('modifierOptions');
  arr.splice(0, arr.length, ...arr.filter((o) => o.groupId !== id));
  touch();
  res.json({ ok: true });
});

module.exports = router;