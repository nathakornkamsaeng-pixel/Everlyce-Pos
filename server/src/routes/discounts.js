const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(coll('discounts'));
});

router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.code || !b.name) return res.status(400).json({ detail: 'code and name are required' });
  const d = {
    id: nextId('discounts'),
    code: String(b.code).toUpperCase(),
    name: String(b.name),
    type: b.type || 'percent',
    value: Number(b.value) || 0,
    active: b.active !== false,
    pointsCost: Math.max(0, Number(b.pointsCost) || 0),
    stackable: b.stackable !== false,
    createdAt: now(),
  };
  coll('discounts').push(d);
  touch();
  res.status(201).json(d);
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const d = coll('discounts').find((x) => x.id === Number(req.params.id));
  if (!d) return res.status(404).json({ detail: 'Discount not found' });
  const b = req.body || {};
  if (b.code !== undefined) d.code = String(b.code).toUpperCase();
  if (b.name !== undefined) d.name = String(b.name);
  if (b.type !== undefined) d.type = b.type;
  if (b.value !== undefined) d.value = Number(b.value);
  if (b.active !== undefined) d.active = !!b.active;
  if (b.pointsCost !== undefined) d.pointsCost = Math.max(0, Number(b.pointsCost) || 0);
  if (b.stackable !== undefined) d.stackable = !!b.stackable;
  touch();
  res.json(d);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const idx = coll('discounts').findIndex((x) => x.id === Number(req.params.id));
  if (idx === -1) return res.status(404).json({ detail: 'Discount not found' });
  coll('discounts').splice(idx, 1);
  touch();
  res.json({ ok: true });
});

module.exports = router;