const express = require('express');
const { coll, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier'));

function stockValue(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

router.get('/low-stock', (req, res) => res.json(coll('products').filter((product) => product.trackStock && Number(product.stockCount) <= Number(product.lowStockThreshold))));

router.put('/stock', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const product = coll('products').find((candidate) => Number(candidate.id) === Number(body.productId));
  if (!product) return res.status(404).json({ detail: 'Product not found' });
  if (!product.trackStock) return res.status(400).json({ detail: 'This product does not track stock' });
  if (body.set !== undefined) product.stockCount = stockValue(body.set, 'Stock');
  if (body.add !== undefined) product.stockCount = Math.max(0, (Number(product.stockCount) || 0) + stockValue(body.add, 'Stock adjustment'));
  touch();
  res.json(product);
});

module.exports = router;
