const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { rejectIfOverLimit } = require('../planLimits');
const { validateExternalUrl } = require('../urlSafety');

const router = express.Router();
router.use(requireAuth);

function replaceInPlace(name, pred) {
  const arr = coll(name);
  arr.splice(0, arr.length, ...arr.filter(pred));
}

function dto(p) {
  return {
    ...p,
    modifierGroups: coll('modifierGroups')
      .filter((g) => (g.productIds || []).includes(p.id))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((g) => ({
        ...g,
        options: coll('modifierOptions')
          .filter((o) => o.groupId === g.id)
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)),
      })),
  };
}

router.get('/', (req, res) => {
  let list = coll('products').sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  res.json(list.map(dto));
});

function resolveCategory(id) {
  if (id === null || id === undefined || id === '') return null;
  const cat = coll('categories').find((c) => c.id === Number(id));
  return cat ? cat.id : null;
}

function applyModifierGroups(productId, groupIds) {
  const wanted = new Set((groupIds || []).map(Number).filter(Number.isInteger));
  for (const g of coll('modifierGroups')) {
    const current = Array.isArray(g.productIds) ? g.productIds : [];
    const should = wanted.has(g.id);
    const has = current.includes(productId);
    if (should && !has) g.productIds = [...current, productId];
    else if (!should && has) g.productIds = current.filter((pid) => pid !== productId);
  }
}

// A product image is rendered on the unauthenticated customer menu, so it goes
// through the same external-URL rule as the LINE link. Blank is allowed; a
// javascript: or data: payload is not.
function externalImage(value) {
  const checked = validateExternalUrl(value, { field: 'The image address' });
  if (checked.error) throw Object.assign(new Error(checked.error), { status: 400 });
  return checked.value || null;
}

router.post('/', requireRole('admin'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ detail: 'name is required' });
  if (!resolveCategory(b.categoryId)) {
    return res.status(400).json({ detail: 'A valid category is required so the item shows on the customer menu' });
  }
  const overLimit = rejectIfOverLimit(req, res, 'maxProducts', coll('products').length);
  if (overLimit) return overLimit;
  const p = {
    id: nextId('products'),
    categoryId: resolveCategory(b.categoryId),
    name: String(b.name),
    description: b.description || '',
    price: Number(b.price) || 0,
    cost: Number(b.cost) || 0,
    imageUrl: externalImage(b.imageUrl),
    available: b.available !== false,
    sortOrder: Number(b.sortOrder) || 0,
    trackStock: !!b.trackStock,
    stockCount: Number(b.stockCount) || 0,
    lowStockThreshold: Number(b.lowStockThreshold) || 5,
    allergens: b.allergens || '',
    sku: b.sku || '',
    barcode: b.barcode || '',
    createdAt: now(),
  };
  coll('products').push(p);
  if (Array.isArray(b.modifierGroupIds)) applyModifierGroups(p.id, b.modifierGroupIds);
  if (Array.isArray(b.modifierGroups)) {
    for (const g of b.modifierGroups) {
      const gid = nextId('modifierGroups');
      coll('modifierGroups').push({
        id: gid,
        productIds: [p.id],
        name: g.name || 'Options',
        type: g.type === 'multiple' ? 'multiple' : 'single',
        required: !!g.required,
        sortOrder: Number(g.sortOrder) || 0,
        createdAt: now(),
      });
      for (const o of g.options || []) {
        coll('modifierOptions').push({
          id: nextId('modifierOptions'),
          groupId: gid,
          name: o.name,
          priceAdj: Number(o.priceAdj) || 0,
          sortOrder: Number(o.sortOrder) || 0,
          createdAt: now(),
        });
      }
    }
  }
  touch();
  res.status(201).json(dto(p));
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const p = coll('products').find((x) => x.id === Number(req.params.id));
  if (!p) return res.status(404).json({ detail: 'Product not found' });
  const b = req.body || {};
  if (b.imageUrl !== undefined) {
    const checked = validateExternalUrl(b.imageUrl, { field: 'The image address' });
    if (checked.error) return res.status(400).json({ detail: checked.error });
    p.imageUrl = checked.value || null;
  }
  ['name', 'description', 'allergens', 'sku', 'barcode'].forEach((k) => {
    if (b[k] !== undefined) p[k] = b[k] === null ? null : String(b[k]);
  });
  ['price', 'cost', 'sortOrder', 'stockCount', 'lowStockThreshold'].forEach((k) => {
    if (b[k] !== undefined) p[k] = Number(b[k]);
  });
  if (b.categoryId !== undefined) {
    const cat = resolveCategory(b.categoryId);
    if (!cat) return res.status(400).json({ detail: 'A valid category is required so the item shows on the customer menu' });
    p.categoryId = cat;
  }
  if (b.available !== undefined) p.available = !!b.available;
  if (b.trackStock !== undefined) p.trackStock = !!b.trackStock;
  if (Array.isArray(b.modifierGroupIds)) applyModifierGroups(p.id, b.modifierGroupIds);
  touch();
  res.json(dto(p));
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const idx = coll('products').findIndex((x) => x.id === id);
  if (idx === -1) return res.status(404).json({ detail: 'Product not found' });
  coll('products').splice(idx, 1);
  let dirty = false;
  for (const g of coll('modifierGroups')) {
    if (Array.isArray(g.productIds) && g.productIds.includes(id)) {
      g.productIds = g.productIds.filter((pid) => pid !== id);
      dirty = true;
    }
  }
  if (dirty) touch();
  res.json({ ok: true });
});

module.exports = router;