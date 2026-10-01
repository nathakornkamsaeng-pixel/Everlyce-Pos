// The integration API, /api/v1.
//
// Reachable with a store API key and nothing else. There is no session-token
// path in here and no anonymous path: a browser cookie or a staff JWT is
// refused, so this surface cannot be walked into from the site, and the key
// decides which single store the request is allowed to touch.
//
// Everything here is deliberately narrow. A key is scoped, and the most
// dangerous capability, creating an order, is behind its own scope and goes
// through the same catalog and totals helpers the till uses, so an integration
// cannot invent prices or write an order the till would refuse.

const express = require('express');
const crypto = require('crypto');
const { coll, nextId, now, transaction, recalculateSession, bucketFor } = require('../db');
const { tr, normalizeLang } = require('../i18n/lookup');
const { buildLines, reserveLines, optionalText, ValidationError } = require('../catalog');
const { recompute } = require('../orderTotals');
const { requireApiKey, rateLimit, SCOPES } = require('../apiKeys');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();

router.get('/scopes', (req, res) => res.json({ scopes: SCOPES }));

function orderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let value;
  do {
    value = `ORD-${date}-${crypto.randomInt(100000, 1000000)}`;
  } while (coll('orders').some((order) => order.orderNumber === value));
  return value;
}

// The branch an integration writes to: named in the query, otherwise the
// store's default. Branches are the unit reporting is built on, so an
// integration never gets to invent one.
function branchFor(req) {
  const wanted = Number(req.query.branch || (req.body && req.body.branchId));
  const branches = coll('branches');
  if (Number.isFinite(wanted) && wanted) {
    const found = branches.find((b) => Number(b.id) === wanted);
    if (!found) throw Object.assign(new Error('Unknown branch'), { status: 400 });
    return found;
  }
  const fallback = branches.find((b) => b.isDefault) || branches[0];
  if (!fallback) throw Object.assign(new Error('This store has no branch'), { status: 409 });
  return fallback;
}

function lang(req) {
  return normalizeLang(req.query.lang || 'th');
}

router.use(rateLimit({ limit: 240, windowMs: 60 * 1000 }));

// ---------------------------------------------------------------- catalog

router.get('/catalog', requireApiKey('catalog:read'), (req, res) => {
  const language = lang(req);
  const categories = coll('categories').slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const products = coll('products').filter((p) => !p.archived).map((product) => ({
    id: product.id,
    categoryId: product.categoryId,
    name: tr(product.name, language),
    description: product.description ? tr(product.description, language) : '',
    price: Number(product.price) || 0,
    imageUrl: product.imageUrl || null,
    available: product.active !== false && product.stockOut !== true,
    modifierGroups: coll('modifierGroups')
      .filter((g) => Array.isArray(g.productIds) && g.productIds.map(Number).includes(Number(product.id)))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((g) => ({
        id: g.id,
        name: tr(g.name, language),
        type: g.type === 'multiple' ? 'multiple' : 'single',
        required: Boolean(g.required),
        minSelect: Math.max(0, Number(g.minSelect) || 0),
        maxSelect: Math.max(0, Number(g.maxSelect) || 0),
        options: coll('modifierOptions')
          .filter((o) => Number(o.groupId) === Number(g.id))
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
          .map((o) => ({ id: o.id, name: tr(o.name, language), price: Number(o.price) || 0 })),
      })),
  }));

  res.json({
    store: { slug: req.apiKeyStore.slug, name: tr((coll('settings') || {}).restaurantName, language) },
    currency: (coll('settings') || {}).currency || 'THB',
    language,
    categories: categories.map((c) => ({ id: c.id, name: tr(c.name, language), sortOrder: c.sortOrder || 0 })),
    products,
  });
});

// ------------------------------------------------------------------ orders

function orderView(order, branch) {
  const items = coll('orderItems').filter((i) => Number(i.orderId) === Number(order.id));
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    orderType: order.orderType,
    tableId: order.tableId || null,
    branchId: order.branchId || (branch ? branch.id : null),
    subtotal: order.subtotal,
    discount: order.discount,
    tax: order.tax,
    serviceCharge: order.serviceCharge,
    total: order.total,
    notes: order.notes || '',
    createdAt: order.createdAt,
    completedAt: order.completedAt || null,
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      productName: i.productName,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      notes: i.notes || '',
      modifiers: (() => { try { return JSON.parse(i.modifiers || '[]'); } catch (e) { return []; } })(),
      status: i.status,
    })),
  };
}

router.get('/orders', requireApiKey('orders:read'), (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const orders = coll('orders')
    .slice()
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, limit)
    .map((order) => orderView(order, req.branch));
  res.json({ orders });
});

router.get('/orders/:id', requireApiKey('orders:read'), (req, res) => {
  const order = coll('orders').find((o) => String(o.orderNumber) === String(req.params.id) || Number(o.id) === Number(req.params.id));
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  return res.json({ order: orderView(order, req.branch) });
});

// Push an order in from a delivery platform, a kiosk or a website.
router.post('/orders', requireApiKey('orders:write'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) {
    return res.status(400).json({ detail: 'Send between 1 and 50 items' });
  }
  const branch = branchFor(req);

  // A table is optional: an integration usually has no table, but if it names
  // one it has to be a real table in this store.
  let table = null;
  let session = null;
  if (body.tableId != null && body.tableId !== '') {
    table = coll('tables').find((t) => Number(t.id) === Number(body.tableId));
    if (!table) return res.status(400).json({ detail: 'Unknown table' });
    session = coll('sessions').find((s) => Number(s.tableId) === Number(table.id) && s.status === 'open');
    if (!session) return res.status(400).json({ detail: 'That table has no open session' });
  }

  const orderType = ['dine_in', 'takeaway', 'delivery'].includes(body.orderType) ? body.orderType : 'takeaway';
  if (orderType === 'dine_in' && !table) {
    return res.status(400).json({ detail: 'A dine-in order needs a table' });
  }

  // buildLines resolves the price from the catalogue. An integration cannot set
  // its own unit price, so a tampered payload cannot under-charge a sale.
  const lines = buildLines(body.items);
  const created = transaction(() => {
    const order = {
      id: nextId('orders'),
      orderNumber: orderNumber(),
      tableId: table ? table.id : null,
      sessionId: session ? session.id : null,
      branchId: branch.id,
      status: 'pending',
      draft: false,
      subtotal: 0, tax: 0, serviceCharge: 0, discount: 0, tip: 0, total: 0,
      paymentStatus: 'pending',
      paymentMethod: null,
      notes: optionalText(body.notes, 'Notes'),
      customerName: optionalText(body.customerName, 'Customer name', 200),
      orderType,
      createdBy: null,
      source: 'api',
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      completedAt: null,
      prepMs: null,
    };
    coll('orders').push(order);
    reserveLines(lines, order.id);
    for (const line of lines) {
      const product = coll('products').find((p) => Number(p.id) === Number(line.productId));
      coll('orderItems').push({
        id: nextId('orderItems'),
        orderId: order.id,
        productId: line.productId,
        productName: line.productName,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        notes: line.notes,
        modifiers: JSON.stringify(line.modifiers),
        status: 'pending',
        refunded: false,
        refundedQuantity: 0,
        stockReserved: Boolean(product && product.trackStock),
        stockConsumed: false,
        branchId: branch.id,
        createdAt: now(),
      });
    }
    recompute(order);
    if (session) recalculateSession(session.id);
    return order;
  });

  log(EVENTS.ORDER_SENT, { user: null }, {
    order: created.orderNumber, total: created.total, source: 'api', key: req.apiKey.label,
  });
  res.status(201).json({ order: orderView(created, branch) });
});

// ------------------------------------------------------------------ errors

router.use((req, res) => res.status(404).json({ detail: 'Not found' }));

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof ValidationError) return res.status(400).json({ detail: err.message });
  const status = Number(err && err.status) || 500;
  if (status >= 500) console.error('api v1 error', err);
  return res.status(status).json({ detail: (err && err.message) || 'Request failed' });
});

module.exports = router;
