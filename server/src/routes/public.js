const crypto = require('crypto');
const express = require('express');
const { coll, nextId, now, transaction, recalculateSession } = require('../db');
const { tr, normalizeLang } = require('../i18n/lookup');
const { buildLines, reserveLines, optionalText, ValidationError } = require('../catalog');
const { recompute, parsedModifiers, itemLineTotal } = require('../orderTotals');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();

function findSession(token) {
  return coll('sessions').find((session) => session.token && session.token === String(token || ''));
}

function orderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let value;
  do { value = `ORD-${date}-${crypto.randomInt(100000, 1000000)}`; } while (coll('orders').some((order) => order.orderNumber === value));
  return value;
}

function publicProduct(product, lang) {
  return {
    id: product.id,
    name: tr(product.name, lang),
    description: product.description ? tr(product.description, lang) : '',
    allergens: product.allergens || '',
    imageUrl: product.imageUrl || null,
    price: Number(product.price) || 0,
    modifierGroups: coll('modifierGroups')
      .filter((group) => Array.isArray(group.productIds) && group.productIds.map(Number).includes(Number(product.id)))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
      .map((group) => ({
        id: group.id,
        name: tr(group.name, lang),
        type: group.type === 'multiple' ? 'multiple' : 'single',
        required: Boolean(group.required),
        minSelect: Math.max(0, Number(group.minSelect) || 0),
        maxSelect: Math.max(0, Number(group.maxSelect) || 0),
        options: coll('modifierOptions')
          .filter((option) => Number(option.groupId) === Number(group.id))
          .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
          .map((option) => ({ id: option.id, name: tr(option.name, lang), priceAdj: Number(option.priceAdj) || 0 })),
      })),
  };
}

const publicOrderHits = new Map();
const PUBLIC_ORDER_LIMIT = 20;
const PUBLIC_ORDER_WINDOW_MS = 10 * 60 * 1000;

function allowPublicOrder(ip, token) {
  const key = crypto.createHash('sha256').update(`${ip}|${token}`).digest('hex');
  const nowMs = Date.now();
  const entry = publicOrderHits.get(key);
  if (!entry || nowMs - entry.first > PUBLIC_ORDER_WINDOW_MS) {
    publicOrderHits.set(key, { first: nowMs, count: 1 });
    return true;
  }
  entry.count += 1;
  if (publicOrderHits.size > 2000) {
    for (const [candidate, value] of publicOrderHits) {
      if (nowMs - value.first > PUBLIC_ORDER_WINDOW_MS) publicOrderHits.delete(candidate);
    }
  }
  return entry.count <= PUBLIC_ORDER_LIMIT;
}

function publicOrder(order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    subtotal: order.subtotal,
    tax: order.tax,
    serviceCharge: order.serviceCharge,
    total: order.total,
    createdAt: order.createdAt,
    items: coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded).map((item) => ({ productName: item.productName, quantity: item.quantity, unitPrice: item.unitPrice, notes: item.notes, modifiers: parsedModifiers(item) })),
  };
}

router.get('/branding', (req, res) => {
  const settings = coll('settings');
  res.set('Cache-Control', 'no-store');
  res.json({ restaurantName: settings.restaurantName || '', currency: settings.currency || 'THB' });
});

router.get('/receipt', (req, res) => {
  const token = String(req.query.token || '').trim();
  const order = token ? coll('orders').find((candidate) => candidate.receiptToken && candidate.receiptToken === token) : null;
  if (!order) return res.status(404).json({ detail: 'Receipt not found' });
  if (!order.receiptExpiresAt || new Date(order.receiptExpiresAt).getTime() <= Date.now()) return res.status(410).json({ detail: 'This receipt link has expired' });
  if (!['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) return res.status(404).json({ detail: 'Receipt not found' });
  const settings = coll('settings');
  const items = coll('orderItems')
    .filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded)
    .map((item) => {
      const quantity = Math.max(0, (Number(item.quantity) || 0) - (Number(item.refundedQuantity) || 0));
      return {
        name: item.productName,
        quantity,
        unitPrice: Number(item.unitPrice) || 0,
        lineTotal: quantity ? itemLineTotal({ ...item, quantity }) : 0,
        notes: item.notes || null,
        modifiers: parsedModifiers(item),
      };
    })
    .filter((item) => item.quantity > 0);
  res.set('Cache-Control', 'no-store');
  res.json({
    restaurantName: settings.restaurantName || 'Restaurant',
    // A Thai tax invoice has to show the seller's legal name and tax
    // identification number, and break out the VAT. These are only sent when
    // the shop has filled them in, so an incomplete invoice is not implied.
    legalName: settings.legalName || null,
    taxId: settings.taxId || null,
    taxRate: Number(settings.taxRate) || 0,
    currency: settings.currency || 'THB',
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod || null,
      paidAt: order.paidAt,
      expiresAt: order.receiptExpiresAt,
      customerName: order.customerName || null,
      tableName: (coll('tables').find((table) => Number(table.id) === Number(order.tableId)) || {}).name || null,
      subtotal: Number(order.subtotal) || 0,
      tax: Number(order.tax) || 0,
      taxLabel: 'VAT',
      serviceCharge: Number(order.serviceCharge) || 0,
      discount: Number(order.discount) || 0,
      tip: Number(order.tip) || 0,
      refundedAmount: Number(order.refundedAmount) || 0,
      total: Number(order.total) || 0,
      items,
    },
  });
});

router.get('/menu', (req, res) => {
  const session = findSession(req.query.token);
  if (!session) return res.status(404).json({ detail: 'Session not found or inactive' });
  if (session.status !== 'open') return res.status(410).json({ detail: 'Session is closed' });
  const lang = normalizeLang(req.query.lang, coll('settings').customerLanguage || 'th');
  const categories = coll('categories').slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const sellable = coll('products').filter((product) => product.available && Number(product.price) >= 0).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  const result = categories.map((category) => ({ id: category.id, name: tr(category.name, lang), sortOrder: category.sortOrder, products: sellable.filter((product) => Number(product.categoryId) === Number(category.id)).map((product) => publicProduct(product, lang)) })).filter((category) => category.products.length);
  const known = new Set(categories.map((category) => Number(category.id)));
  const orphans = sellable.filter((product) => !known.has(Number(product.categoryId)));
  if (orphans.length) result.push({ id: 0, name: tr('Other', lang), sortOrder: 9999, products: orphans.map((product) => publicProduct(product, lang)) });
  res.json(result);
});

router.get('/session', (req, res) => {
  const session = findSession(req.query.token);
  if (!session) return res.status(404).json({ detail: 'Session not found or inactive' });
  if (session.status !== 'open') return res.status(410).json({ detail: 'Session is closed' });
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(session.tableId));
  if (!table) return res.status(404).json({ detail: 'Table not found' });
  const settings = coll('settings');
  res.json({
    table: { id: table.id, name: table.name, seats: table.seats },
    session: { id: session.id, openedAt: session.openedAt, guestCount: session.guestCount },
    settings: { restaurantName: settings.restaurantName, taxRate: settings.taxRate, serviceChargeRate: settings.serviceChargeRate, currency: settings.currency, defaultLanguage: settings.customerLanguage || 'th' },
  });
});

router.get('/orders', (req, res) => {
  const session = findSession(req.query.token);
  if (!session) return res.status(404).json({ detail: 'Session not found or inactive' });
  if (session.status !== 'open') return res.status(410).json({ detail: 'Session is closed' });
  res.json(coll('orders').filter((order) => Number(order.sessionId) === Number(session.id) && order.draft !== true && order.status !== 'cancelled').sort((a, b) => a.id - b.id).map(publicOrder));
});

router.post('/order', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const session = findSession(body.token);
  if (!session) return res.status(404).json({ detail: 'Session not found or inactive' });
  if (session.status !== 'open') return res.status(410).json({ detail: 'Session is closed' });
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(session.tableId));
  if (!table) return res.status(404).json({ detail: 'Table not found' });
  if (!allowPublicOrder(String(req.ip || req.socket?.remoteAddress || 'unknown'), String(body.token || ''))) return res.status(429).json({ detail: 'Too many orders from this device; ask staff for help' });
  if (!Array.isArray(body.items) || body.items.length > 50) return res.status(400).json({ detail: 'Invalid order items' });
  const pendingCount = coll('orders').filter((order) => Number(order.sessionId) === Number(session.id) && order.paymentStatus === 'pending' && order.status !== 'cancelled').length;
  if (pendingCount >= 30) return res.status(429).json({ detail: 'This table already has too many open orders' });
  const lines = buildLines(body.items);
  const orderType = ['dine_in', 'takeaway', 'delivery'].includes(body.orderType) ? body.orderType : 'dine_in';
  const result = transaction(() => {
    const order = {
      id: nextId('orders'),
      tableId: table.id,
      sessionId: session.id,
      orderNumber: orderNumber(),
      status: 'pending',
      draft: false,
      subtotal: 0,
      tax: 0,
      serviceCharge: 0,
      discount: 0,
      tip: 0,
      total: 0,
      paymentStatus: 'pending',
      paymentMethod: null,
      notes: optionalText(body.notes, 'Notes'),
      customerName: optionalText(body.customerName, 'Customer name', 200),
      orderType,
      createdBy: null,
      createdAt: now(),
      updatedAt: now(),
      startedAt: now(),
      completedAt: null,
      prepMs: null,
    };
    coll('orders').push(order);
    reserveLines(lines, order.id);
    for (const line of lines) {
      const product = coll('products').find((candidate) => Number(candidate.id) === Number(line.productId));
      coll('orderItems').push({ id: nextId('orderItems'), orderId: order.id, productId: line.productId, productName: line.productName, quantity: line.quantity, unitPrice: line.unitPrice, notes: line.notes, modifiers: JSON.stringify(line.modifiers), status: 'pending', refunded: false, refundedQuantity: 0, stockReserved: Boolean(product && product.trackStock), stockConsumed: false, createdAt: now() });
    }
    recompute(order);
    recalculateSession(session.id);
    return { orderNumber: order.orderNumber, orderId: order.id, sessionId: order.sessionId, total: order.total, tableName: table ? table.name : null };
  });
  log(EVENTS.ORDER_SENT, { user: null }, { order: result.orderNumber, table: result.tableName, total: result.total, source: 'qr' });
  res.status(201).json({ orderNumber: result.orderNumber, orderId: result.orderId, sessionId: result.sessionId });
});

module.exports = router;
