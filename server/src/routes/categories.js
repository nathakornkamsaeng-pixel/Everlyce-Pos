const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  res.json(coll('categories'));
});

router.post('/', requireRole('admin'), (req, res) => {
  const { name, sortOrder = 0 } = req.body || {};
  if (!name) return res.status(400).json({ detail: 'name is required' });
  const c = { id: nextId('categories'), name: String(name), sortOrder, createdAt: now() };
  coll('categories').push(c);
  touch();
  res.status(201).json(c);
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const c = coll('categories').find((x) => x.id === Number(req.params.id));
  if (!c) return res.status(404).json({ detail: 'Category not found' });
  const { name, sortOrder } = req.body || {};
  if (name !== undefined) c.name = String(name);
  if (sortOrder !== undefined) c.sortOrder = sortOrder;
  touch();
  res.json(c);
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const idx = coll('categories').findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ detail: 'Category not found' });
  coll('categories').splice(idx, 1);
  coll('products').forEach((p) => { if (p.categoryId === id) p.categoryId = null; });
  touch();
  res.json({ ok: true });
});

module.exports = router;