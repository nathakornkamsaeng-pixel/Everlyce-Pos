const crypto = require('crypto');
const express = require('express');
const { coll, nextId, now, touch, transaction, recalculateSession, tierFor } = require('../db');
const { ROUND2, itemLineTotal, parsedModifiers, recompute } = require('../orderTotals');
const { log, EVENTS } = require('../activityLog');
const checkout = require('../services/checkout');
const { requireAuth, requireRole } = require('../middleware');
const { ValidationError, buildLine, buildLines, reserveLines, releaseLines, adjustStock, positiveInteger, optionalText } = require('../catalog');
const L = require('../loyaltyEngine');
const registry = require('../payments/registry');
const thaiqr = require('../payments/thaiqr');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier', 'kds'));

function genOrderNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let value;
  do { value = `ORD-${date}-${crypto.randomInt(100000, 1000000)}`; } while (coll('orders').some((order) => order.orderNumber === value));
  return value;
}

function promptPayRequestDto(request) {
  if (!request) return null;
  const orders = request.orderIds.map((id) => getOrder(id)).filter(Boolean);
  return { ...request, orders: orders.map(dto) };
}

function getOrder(id) {
  return coll('orders').find((order) => Number(order.id) === Number(id));
}

function activeItems(order) {
  return coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded);
}

// branchId rides along so an order always records where it was rung up: from
// the table's branch when it has one, otherwise the branch the till is on.
function tableAndSession(tableId, sessionId, fallbackBranchId = null) {
  const normalizedTable = tableId === null || tableId === undefined || tableId === '' ? null : Number(tableId);
  const normalizedSession = sessionId === null || sessionId === undefined || sessionId === '' ? null : Number(sessionId);
  if (normalizedTable === null) {
    if (normalizedSession !== null) throw new ValidationError('A session requires a table');
    return { tableId: null, sessionId: null, branchId: fallbackBranchId || null };
  }
  const table = coll('tables').find((candidate) => Number(candidate.id) === normalizedTable);
  if (!Number.isSafeInteger(normalizedTable) || !table) throw new ValidationError('Table not found');
  const branchId = table.branchId != null ? Number(table.branchId) : (fallbackBranchId || null);
  if (normalizedSession !== null) {
    const session = coll('sessions').find((candidate) => Number(candidate.id) === normalizedSession);
    if (!session || Number(session.tableId) !== normalizedTable || session.status !== 'open') throw new ValidationError('Open session not found for table');
    return { tableId: normalizedTable, sessionId: normalizedSession, branchId };
  }
  const session = coll('sessions').find((candidate) => Number(candidate.tableId) === normalizedTable && candidate.status === 'open');
  if (!session) throw new ValidationError('Table has no open session');
  return { tableId: normalizedTable, sessionId: Number(session.id), branchId };
}

function dto(order) {
  const items = coll('orderItems').filter((item) => item.orderId === order.id).sort((a, b) => a.id - b.id).map((item) => ({ ...item, modifiers: parsedModifiers(item) }));
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(order.tableId));
  return { ...order, items, tableName: table ? table.name : null };
}

function tierForOrder(member) {
  member.tier = tierFor(member.points);
}

function settleLoyalty(order, req) {
  const cfg = L.settings();
  if (!cfg.enabled) {
    order.loyaltySettledAt = order.loyaltySettledAt || now();
    return;
  }
  if (!order.memberId) {
    order.loyaltySettledAt = order.loyaltySettledAt || now();
    return;
  }
  if (order.loyaltySettledAt) return;
  const member = L.findById(order.memberId);
  if (!member) throw new ValidationError('Loyalty member not found');
  const spent = Math.max(0, Number(order.pointsUsed) || 0);
  if (spent > (Number(member.points) || 0)) throw new ValidationError('Not enough loyalty points', 409);
  if (spent > 0) {
    member.points = (Number(member.points) || 0) - spent;
    L.ledger({ memberId: member.id, orderId: order.id, type: 'redeem', points: -spent, sourceKey: `order:${order.id}:redeem`, note: `Order ${order.orderNumber}` });
    log(EVENTS.POINTS_REDEEM, req, { member: member.id, points: -spent, order: order.orderNumber });
  }
  const earned = cfg.pointsPerUnit > 0 ? Math.max(0, Math.floor(Number(order.total) * cfg.pointsPerUnit)) : 0;
  if (earned > 0) {
    member.points = (Number(member.points) || 0) + earned;
    L.ledger({ memberId: member.id, orderId: order.id, type: 'earn', points: earned, sourceKey: `order:${order.id}:earn`, note: `Order ${order.orderNumber}` });
    order.pointsEarned = earned;
    log(EVENTS.POINTS_EARN, req, { member: member.id, points: earned, order: order.orderNumber });
  } else {
    order.pointsEarned = 0;
  }
  tierForOrder(member);
  order.pointsBalance = member.points;
  order.memberName = member.name;
  order.loyaltySettledAt = now();
}

function reverseLoyalty(order, req) {
  if (order.loyaltyReversed || !order.memberId) return;
  const member = L.findById(order.memberId);
  if (!member) return;
  const spent = Math.max(0, Number(order.pointsUsed) || 0);
  const earned = Math.max(0, Number(order.pointsEarned) || 0);
  if (spent > 0) {
    member.points = (Number(member.points) || 0) + spent;
    L.ledger({ memberId: member.id, orderId: order.id, type: 'redeem-reversal', points: spent, sourceKey: `order:${order.id}:redeem-reversal`, note: `Refund ${order.orderNumber}` });
  }
  if (earned > 0) {
    member.points = (Number(member.points) || 0) - earned;
    L.ledger({ memberId: member.id, orderId: order.id, type: 'earn-reversal', points: -earned, sourceKey: `order:${order.id}:earn-reversal`, note: `Refund ${order.orderNumber}` });
  }
  tierForOrder(member);
  order.loyaltyReversed = true;
  log(EVENTS.POINTS_REDEEM, req, { member: member.id, order: order.orderNumber, reversal: true });
}

function memberRequired() {
  const cfg = L.settings();
  return cfg.enabled && (cfg.requirePhone || !cfg.allowSkip);
}

function openCashSession() {
  return coll('cashSessions').find((session) => session.status === 'open') || null;
}

function paymentMethod(value, allowPromptPay = false) {
  const method = value || 'cash';
  const allowed = allowPromptPay ? ['cash', 'card', 'other', 'promptpay'] : ['cash', 'card', 'other'];
  if (!allowed.includes(method)) throw new ValidationError('Invalid payment method');
  return method;
}

function setTip(order, value) {
  if (value === undefined || value === null || value === '') return;
  const tip = Number(value);
  if (!Number.isFinite(tip) || tip < 0 || tip > 1000000) throw new ValidationError('Invalid tip');
  order.tip = tip;
}

function makeItem(order, line) {
  const product = coll('products').find((candidate) => Number(candidate.id) === Number(line.productId));
  return {
    id: nextId('orderItems'),
    orderId: order.id,
    productId: Number(line.productId),
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
    createdAt: now(),
  };
}

function addItems(order, lines) {
  reserveLines(lines, order.id);
  for (const line of lines) coll('orderItems').push(makeItem(order, line));
}

function clearLoyaltyOnOrder(order) {
  order.memberId = null;
  order.memberName = null;
  order.coupons = [];
  order.pointsUsed = 0;
  order.pointsDiscount = 0;
  order.discount = 0;
  order.loyaltyAppliedAt = null;
}

// The rules live in the service so they can be tested without HTTP. This is
// the request-shaped wrapper: it supplies the repository, the clock and the
// collaborators, and it is what the routes below call.
function applyPayment(order, body, req, options = {}) {
  const result = repo.transaction(() => checkout.settle({
    repo,
    order,
    body,
    actor: req.user,
    allowPromptPay: options.allowPromptPay === true,
    deps: {
      recompute,
      recalculateSession,
      memberRequired,
      settleLoyalty: (target) => settleLoyalty(target, req),
    },
  }));
  return { order: dto(result.order), payment: result.payment, idempotent: result.idempotent };
}

function validateOrderMutation(order) {
  if (!order) throw new ValidationError('Order not found', 404);
  if (order.paymentStatus !== 'pending') throw new ValidationError('Paid or closed orders cannot be changed');
  if (order.promptPayRequestId) {
    const request = coll('promptPayRequests').find((candidate) => Number(candidate.id) === Number(order.promptPayRequestId) && candidate.status === 'pending');
    if (request) throw new ValidationError('PromptPay payment is awaiting confirmation');
  }
}

router.get('/', (req, res) => {
  let list = coll('orders').filter((order) => order.draft !== true).slice().sort((a, b) => b.id - a.id);
  const status = req.query.status;
  if (status === 'active') {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    list = list.filter((order) => order.paymentStatus === 'pending' && order.status !== 'cancelled');
  } else if (status) list = list.filter((order) => order.status === status);
  // branchId=all shows every branch; anything else narrows to one.
  const branch = req.query.branchId;
  if (branch && branch !== 'all') list = list.filter((order) => Number(order.branchId) === Number(branch));
  res.json(list.map(dto));
});

router.post('/checkout-batch', requireRole('admin', 'cashier'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const input = Array.isArray(body.orders) ? body.orders : (Array.isArray(body.orderIds) ? body.orderIds.map((id) => ({ id })) : []);
  if (!input.length || input.length > 100) throw new ValidationError('Provide between 1 and 100 orders');
  const batchKey = body.idempotencyKey ? String(body.idempotencyKey).trim().slice(0, 100) : null;
  const seen = new Set();
  const entries = input.map((entry) => {
    const id = Number(entry && entry.id);
    if (!Number.isSafeInteger(id) || seen.has(id)) throw new ValidationError('Invalid order list');
    seen.add(id);
    const order = getOrder(id);
    if (!order) throw new ValidationError('Order not found', 404);
    const existingPayment = batchKey ? coll('payments').find((payment) => payment.orderId === order.id && payment.idempotencyKey === `${batchKey}:${order.id}`) : null;
    if (existingPayment) return { id, existingPayment, tableId: order.tableId, sessionId: order.sessionId };
    if (order.paymentStatus !== 'pending') throw new ValidationError('Order is already closed');
    if (!activeItems(order).length) throw new ValidationError('Cannot check out an empty order');
    if (body.discount !== undefined) throw new ValidationError('Discounts must be applied through loyalty');
    if (memberRequired() && !order.memberId) throw new ValidationError('A loyalty member is required for this order');
    const preview = { ...order };
    setTip(preview, entry.tip);
    recompute(preview);
    return { id, tip: entry.tip, total: preview.total, tableId: order.tableId, sessionId: order.sessionId };
  });
  const firstOrder = entries[0];
  if (entries.some((entry) => Number(entry.tableId) !== Number(firstOrder.tableId) || Number(entry.sessionId) !== Number(firstOrder.sessionId))) {
    throw new ValidationError('Orders must belong to the same table session');
  }
  const existingEntries = entries.filter((entry) => entry.existingPayment);
  if (existingEntries.length) {
    if (existingEntries.length !== entries.length) throw new ValidationError('This batch payment is incomplete; refresh before retrying', 409);
    const orders = entries.map((entry) => dto(getOrder(entry.id)));
    const total = ROUND2(existingEntries.reduce((sum, entry) => sum + (Number(entry.existingPayment.amount) || 0), 0));
    const change = ROUND2(existingEntries.reduce((sum, entry) => sum + (Number(entry.existingPayment.change) || 0), 0));
    res.json({ orders, total, change, idempotent: true });
    return;
  }
  const method = paymentMethod(body.method);
  if (method === 'cash' && !openCashSession()) throw new ValidationError('Open a cash drawer before taking cash', 409);
  const total = ROUND2(entries.reduce((sum, entry) => sum + entry.total, 0));
  const received = method === 'cash' ? (body.received === undefined ? total : Number(body.received)) : total;
  if (!Number.isFinite(received) || received < total) throw new ValidationError('Payment received is less than the amount due');
  const change = method === 'cash' ? ROUND2(received - total) : 0;
  const result = transaction(() => entries.map((entry, index) => {
    const order = getOrder(entry.id);
    const orderChange = index === entries.length - 1 ? change : 0;
    return applyPayment(order, { method, received: order.total + orderChange, tip: entry.tip, idempotencyKey: batchKey ? `${batchKey}:${order.id}` : null }, req).order;
  }));
  for (const order of result) {
    log(EVENTS.ORDER_PAID, req, { order: order.orderNumber, total: order.total, method: order.paymentMethod, member: order.memberId || null });
  }
  res.json({ orders: result, total, change, idempotent: false });
});

router.post('/promptpay', requireRole('admin', 'cashier'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const input = Array.isArray(body.orderIds) ? body.orderIds : [];
  if (!input.length || input.length > 100) throw new ValidationError('Provide between 1 and 100 orders');
  const seen = new Set();
  const orderIds = input.map((value) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || seen.has(id)) throw new ValidationError('Invalid order list');
    seen.add(id);
    return id;
  });
  const idempotencyKey = body.idempotencyKey ? String(body.idempotencyKey).trim().slice(0, 100) : null;
  if (idempotencyKey) {
    const existing = coll('promptPayRequests').find((request) => request.status === 'pending' && request.createdBy === req.user.id && request.idempotencyKey === idempotencyKey);
    if (existing) return res.json(promptPayRequestDto(existing));
  }
  const orders = orderIds.map((id) => {
    const order = getOrder(id);
    if (!order) throw new ValidationError('Order not found', 404);
    return order;
  });
  const existingRequests = orders.map((order) => order.promptPayRequestId).filter(Boolean);
  if (existingRequests.length) {
    const first = coll('promptPayRequests').find((request) => Number(request.id) === Number(existingRequests[0]) && request.status === 'pending');
    if (first && existingRequests.every((id) => Number(id) === Number(first.id))) return res.json(promptPayRequestDto(first));
    throw new ValidationError('One of these orders already has a PromptPay payment request');
  }
  for (const order of orders) {
    if (order.paymentStatus !== 'pending' || order.status === 'cancelled') throw new ValidationError('Order is already closed');
    if (!activeItems(order).length) throw new ValidationError('Cannot request PromptPay for an empty order');
    if (body.discount !== undefined) throw new ValidationError('Discounts must be applied through loyalty');
    if (memberRequired() && !order.memberId) throw new ValidationError('A loyalty member is required for this order');
  }
  const firstOrder = orders[0];
  if (orders.some((order) => Number(order.tableId) !== Number(firstOrder.tableId) || Number(order.sessionId) !== Number(firstOrder.sessionId))) {
    throw new ValidationError('Orders must belong to the same table session');
  }
  const settings = coll('settings');
  // The payload is built by the payment provider layer rather than inline, so
  // the QR a customer scans carries the same fields as every other QR this shop
  // produces, including tag 62. That tag was missing entirely, which is what
  // makes a transfer show up on the payer's statement with nothing on it to
  // match against the shop's bank feed.
  const charge = registry.createPayment('thaiqr', { orders, settings, currency: 'THB' });
  const target = { account: thaiqr.accountTarget(settings.promptPayAccountType, settings.promptPayAccount).value };
  const amount = ROUND2(charge.amount);
  const payload = charge.payload;
  const request = transaction(() => {
    const created = {
      id: nextId('promptPayRequests'),
      orderIds,
      amount,
      currency: 'THB',
      account: target.account,
      accountType: settings.promptPayAccountType === 'id' ? 'id' : (settings.promptPayAccountType === 'taxid' ? 'id' : 'phone'),
      // Kept so a payment can be found again from the bank feed without
      // decoding the QR.
      reference: charge.reference,
      provider: charge.provider,
      payload,
      status: 'pending',
      idempotencyKey,
      createdBy: req.user.id,
      createdAt: now(),
      confirmedBy: null,
      confirmedAt: null,
    };
    coll('promptPayRequests').push(created);
    for (const id of orderIds) {
      const order = getOrder(id);
      order.draft = false;
      order.paymentMethod = 'promptpay';
      order.promptPayRequestId = created.id;
      if (!order.startedAt) order.startedAt = now();
      order.updatedAt = now();
    }
    return created;
  });
  log(EVENTS.PROMPTPAY_REQUEST, req, { request: request.id, amount: request.amount, orders: orderIds.length });
  res.status(201).json(promptPayRequestDto(request));
});

router.post('/promptpay/:id/confirm', requireRole('admin', 'cashier'), (req, res) => {
  const request = coll('promptPayRequests').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!request) return res.status(404).json({ detail: 'PromptPay request not found' });
  if (request.status === 'confirmed') return res.json(promptPayRequestDto(request));
  if (request.status !== 'pending') throw new ValidationError('PromptPay request is not pending');
  const orders = request.orderIds.map((id) => {
    const order = getOrder(id);
    if (!order) throw new ValidationError('Order not found', 404);
    if (order.paymentStatus !== 'pending' || order.status === 'cancelled') throw new ValidationError('Order is already closed');
    if (!activeItems(order).length) throw new ValidationError('Cannot confirm an empty order');
    return order;
  });
  const amount = ROUND2(orders.reduce((sum, order) => sum + (Number(order.total) || 0), 0));
  if (amount !== request.amount) throw new ValidationError('PromptPay amount no longer matches this order', 409);
  transaction(() => {
    const candidateRequest = coll('promptPayRequests').find((candidate) => Number(candidate.id) === Number(request.id));
    const candidateOrders = candidateRequest.orderIds.map((id) => getOrder(id));
    for (const order of candidateOrders) {
      applyPayment(order, { method: 'promptpay', received: order.total, idempotencyKey: `promptpay:${candidateRequest.id}:${order.id}` }, req, { allowPromptPay: true });
    }
    candidateRequest.status = 'confirmed';
    candidateRequest.confirmedBy = req.user.id;
    candidateRequest.confirmedAt = now();
  });
  const confirmedRequest = coll('promptPayRequests').find((candidate) => Number(candidate.id) === Number(request.id));
  const confirmedOrders = confirmedRequest.orderIds.map((id) => getOrder(id));
  for (const order of confirmedOrders) {
    log(EVENTS.ORDER_PAID, req, { order: order.orderNumber, total: order.total, method: 'promptpay', member: order.memberId || null });
  }
  log(EVENTS.PROMPTPAY_CONFIRM, req, { request: confirmedRequest.id, amount: confirmedRequest.amount, orders: confirmedOrders.length });
  res.json(promptPayRequestDto(confirmedRequest));
});

router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const draft = body.draft === true;
  if (!Array.isArray(body.items) || !body.items.length) throw new ValidationError('Order must include items');
  const clientKey = draft && body.clientKey ? String(body.clientKey).trim().slice(0, 100) : null;
  if (clientKey) {
    const existing = coll('orders').find((order) => order.draft === true && order.paymentStatus === 'pending' && order.clientKey === clientKey && Number(order.createdBy) === Number(req.user.id));
    if (existing) return res.status(200).json({ ...dto(existing), reused: true });
  }
  const lines = buildLines(body.items);
  const relation = tableAndSession(body.tableId, body.sessionId, req.branchId);
  const order = {
    id: nextId('orders'),
    tableId: relation.tableId,
    sessionId: relation.sessionId,
    branchId: relation.branchId,
    orderNumber: genOrderNumber(),
    status: 'pending',
    draft,
    clientKey,
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
    orderType: ['dine_in', 'takeaway', 'delivery'].includes(body.orderType) ? body.orderType : 'dine_in',
    createdBy: req.user.id,
    createdAt: now(),
    updatedAt: now(),
    startedAt: draft ? null : now(),
    completedAt: null,
    prepMs: null,
  };
  transaction(() => {
    coll('orders').push(order);
    addItems(order, lines);
    recompute(order);
  });
  res.status(201).json(dto(order));
});

router.get('/:id', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  res.json(dto(order));
});

router.post('/:id/sync', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.draft !== true) throw new ValidationError('Only an open register ticket can be synced');
  if (order.createdBy !== req.user.id && req.user.role !== 'admin') throw new ValidationError('You do not own this register ticket', 403);
  if (order.paymentStatus !== 'pending') throw new ValidationError('Order is already closed');
  if (['preparing', 'ready'].includes(order.status)) throw new ValidationError('Order is already sent to the kitchen');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const relation = body.tableId === undefined
    ? { tableId: order.tableId, sessionId: order.sessionId, branchId: order.branchId != null ? order.branchId : req.branchId }
    : tableAndSession(body.tableId, body.sessionId, req.branchId);
  const nextLines = Array.isArray(body.items) && body.items.length ? buildLines(body.items) : null;
  const current = coll('orderItems').filter((item) => item.orderId === order.id);
  const currentShape = current.map((item) => JSON.stringify({ productId: item.productId, quantity: item.quantity, notes: item.notes, modifiers: parsedModifiers(item) }));
  const nextShape = nextLines ? nextLines.map((line) => JSON.stringify({ productId: line.productId, quantity: line.quantity, notes: line.notes, modifiers: line.modifiers })) : null;
  const changed = nextShape && JSON.stringify(currentShape) !== JSON.stringify(nextShape);
  transaction(() => {
    const candidate = getOrder(order.id);
    if (changed) {
      const candidateItems = coll('orderItems').filter((item) => item.orderId === candidate.id);
      releaseLines(candidateItems, candidate.id);
      const all = coll('orderItems');
      all.splice(0, all.length, ...all.filter((item) => item.orderId !== candidate.id));
      addItems(candidate, nextLines);
      clearLoyaltyOnOrder(candidate);
      recompute(candidate);
      candidate.status = 'pending';
    }
    if (body.customerName !== undefined) candidate.customerName = optionalText(body.customerName, 'Customer name', 200);
    if (body.orderType !== undefined && ['dine_in', 'takeaway', 'delivery'].includes(body.orderType)) candidate.orderType = body.orderType;
    candidate.tableId = relation.tableId;
    candidate.sessionId = relation.sessionId;
    candidate.branchId = relation.branchId;
    candidate.updatedAt = now();
  });
  res.json(dto(getOrder(order.id)));
});

router.delete('/:id', (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.draft !== true) throw new ValidationError('Only a register ticket can be discarded');
  if (order.createdBy !== req.user.id && req.user.role !== 'admin') throw new ValidationError('Forbidden', 403);
  transaction(() => {
    const candidate = getOrder(order.id);
    releaseLines(coll('orderItems').filter((item) => item.orderId === candidate.id), candidate.id);
    const orders = coll('orders');
    orders.splice(orders.indexOf(candidate), 1);
    const items = coll('orderItems');
    items.splice(0, items.length, ...items.filter((item) => item.orderId !== candidate.id));
    recalculateSession(candidate.sessionId);
  });
  res.json({ ok: true });
});

router.post('/:id/items', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  validateOrderMutation(order);
  if (['preparing', 'ready'].includes(order.status)) throw new ValidationError('Order is already sent to the kitchen');
  const line = buildLine(req.body || {});
  let created;
  transaction(() => {
    const candidate = getOrder(order.id);
    addItems(candidate, [line]);
    recompute(candidate);
    candidate.updatedAt = now();
    created = coll('orderItems').filter((item) => item.orderId === candidate.id).sort((a, b) => b.id - a.id)[0];
  });
  res.status(201).json({ ...created, modifiers: parsedModifiers(created) });
});

router.put('/:id/items/:itemId', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  validateOrderMutation(order);
  const item = coll('orderItems').find((candidate) => candidate.orderId === order.id && Number(candidate.id) === Number(req.params.itemId));
  if (!item) return res.status(404).json({ detail: 'Item not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.quantity !== undefined) positiveInteger(body.quantity, 'Quantity');
  let resultItem;
  transaction(() => {
    const candidate = getOrder(order.id);
    const candidateItem = coll('orderItems').find((itemRow) => itemRow.orderId === candidate.id && Number(itemRow.id) === Number(req.params.itemId));
    if (body.quantity !== undefined) adjustStock(candidateItem, body.quantity, candidate.id);
    if (body.notes !== undefined) candidateItem.notes = optionalText(body.notes, 'Notes');
    if (body.status !== undefined && ['pending', 'preparing', 'ready', 'served', 'cancelled'].includes(body.status)) {
      if (body.status === 'cancelled' && candidateItem.status !== 'cancelled') releaseLines([candidateItem], candidate.id);
      if (candidateItem.status === 'cancelled' && body.status !== 'cancelled') throw new ValidationError('Cancelled items cannot be reopened');
      candidateItem.status = body.status;
    }
    recompute(candidate);
    if (candidate.draft !== true && !activeItems(candidate).length) {
      candidate.status = 'cancelled';
      candidate.paymentStatus = 'voided';
      recalculateSession(candidate.sessionId);
    }
    candidate.updatedAt = now();
    resultItem = candidateItem;
  });
  res.json({ ...resultItem, modifiers: parsedModifiers(resultItem) });
});

router.delete('/:id/items/:itemId', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  validateOrderMutation(order);
  const index = coll('orderItems').findIndex((item) => item.orderId === order.id && Number(item.id) === Number(req.params.itemId));
  if (index < 0) return res.status(404).json({ detail: 'Item not found' });
  transaction(() => {
    const candidate = getOrder(order.id);
    const candidateIndex = coll('orderItems').findIndex((item) => item.orderId === candidate.id && Number(item.id) === Number(req.params.itemId));
    const item = coll('orderItems')[candidateIndex];
    releaseLines([item], candidate.id);
    coll('orderItems').splice(candidateIndex, 1);
    recompute(candidate);
    if (!activeItems(candidate).length) {
      candidate.status = 'cancelled';
      candidate.paymentStatus = 'voided';
    }
    candidate.updatedAt = now();
  });
  res.json(dto(getOrder(order.id)));
});

router.put('/:id/status', requireRole('admin', 'cashier', 'kds'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.paymentStatus !== 'pending') throw new ValidationError('Paid or closed orders cannot change status');
  const status = req.body && req.body.status;
  const transitions = { pending: ['preparing', 'cancelled'], preparing: ['ready', 'cancelled'], ready: ['served', 'cancelled'], served: [], cancelled: [] };
  if (!Object.prototype.hasOwnProperty.call(transitions, order.status) || !transitions[order.status].includes(status)) throw new ValidationError('Invalid order status transition');
  transaction(() => {
    const candidate = getOrder(order.id);
    candidate.status = status;
    candidate.updatedAt = now();
    if (status === 'preparing' && !candidate.startedAt) candidate.startedAt = now();
    if (['ready', 'served', 'cancelled'].includes(status) && !candidate.completedAt) {
      candidate.completedAt = now();
      const started = new Date(candidate.startedAt || candidate.createdAt).getTime();
      candidate.prepMs = Math.max(0, new Date(candidate.completedAt).getTime() - started);
    }
    if (status === 'cancelled') {
      releaseLines(activeItems(candidate), candidate.id);
      candidate.paymentStatus = 'voided';
      recalculateSession(candidate.sessionId);
    }
  });
  log(EVENTS.ORDER_STATUS, req, { order: order.orderNumber, status });
  res.json(dto(getOrder(order.id)));
});

router.post('/:id/checkout', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  const result = transaction(() => applyPayment(getOrder(order.id), req.body && typeof req.body === 'object' ? req.body : {}, req));
  log(EVENTS.ORDER_PAID, req, {
    order: result.order.orderNumber,
    total: result.order.total,
    method: result.order.paymentMethod,
    member: result.order.memberId || null,
  });
  res.json(result.order);
});

router.post('/:id/void', requireRole('admin'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (order.paymentStatus !== 'pending') throw new ValidationError('Paid orders must be refunded');
  transaction(() => {
    const candidate = getOrder(order.id);
    releaseLines(activeItems(candidate), candidate.id);
    candidate.paymentStatus = 'voided';
    candidate.status = 'cancelled';
    candidate.updatedAt = now();
    recalculateSession(candidate.sessionId);
  });
  log(EVENTS.ORDER_VOID, req, { order: order.orderNumber, total: order.total });
  res.json(dto(getOrder(order.id)));
});

router.post('/:id/refund', requireRole('admin'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  if (!['paid', 'partially_refunded'].includes(order.paymentStatus)) throw new ValidationError('Only paid orders can be refunded');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.idempotencyKey) {
    const existing = coll('refunds').find((refund) => refund.orderId === order.id && refund.idempotencyKey === String(body.idempotencyKey));
    if (existing) return res.json({ ...existing, idempotent: true });
  }
  const candidates = activeItems(order);
  const requested = Array.isArray(body.items) && body.items.length ? body.items : candidates.map((item) => ({ itemId: item.id, quantity: item.quantity }));
  const selected = [];
  for (const request of requested) {
    const item = candidates.find((candidate) => Number(candidate.id) === Number(request.itemId));
    if (!item) throw new ValidationError('Refund item not found');
    const quantity = positiveInteger(request.quantity, 'Refund quantity');
    if (quantity > item.quantity - (Number(item.refundedQuantity) || 0)) throw new ValidationError('Refund quantity exceeds order quantity');
    selected.push({ item, quantity });
  }
  const gross = candidates.reduce((sum, item) => sum + itemLineTotal(item), 0);
  const selectedGross = selected.reduce((sum, entry) => sum + itemLineTotal({ ...entry.item, quantity: entry.quantity }), 0);
  const remaining = ROUND2(Math.max(0, Number(order.total) - (Number(order.refundedAmount) || 0)));
  const amount = body.amount === undefined ? (selected.length === candidates.length ? remaining : ROUND2(Number(order.total) * (selectedGross / Math.max(1, gross)))) : Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > remaining) throw new ValidationError('Invalid refund amount');
  transaction(() => {
    const candidate = getOrder(order.id);
    for (const entry of selected) {
      const candidateItem = coll('orderItems').find((item) => Number(item.id) === Number(entry.item.id));
      candidateItem.refundedQuantity = (Number(candidateItem.refundedQuantity) || 0) + entry.quantity;
      if (candidateItem.refundedQuantity >= candidateItem.quantity) candidateItem.refunded = true;
      if (body.returnItems === true && candidateItem.stockConsumed && !candidateItem.stockRestocked) {
        const product = coll('products').find((row) => Number(row.id) === Number(candidateItem.productId));
        if (product && product.trackStock) product.stockCount = (Number(product.stockCount) || 0) + entry.quantity;
        candidateItem.stockRestocked = true;
      }
    }
    candidate.refundedAmount = ROUND2((Number(candidate.refundedAmount) || 0) + amount);
    candidate.paymentStatus = activeItems(candidate).length ? 'partially_refunded' : 'refunded';
    if (candidate.paymentStatus === 'refunded') reverseLoyalty(candidate, req);
    const payment = coll('payments').find((row) => row.orderId === candidate.id);
    if (payment) {
      payment.refundedAmount = candidate.refundedAmount;
      payment.refunded = candidate.paymentStatus === 'refunded';
    }
    coll('refunds').push({ id: nextId('refunds'), orderId: candidate.id, amount, method: candidate.paymentMethod, items: selected.map((entry) => ({ itemId: entry.item.id, quantity: entry.quantity })), returnItems: body.returnItems === true, idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey).slice(0, 100) : null, createdBy: req.user.id, createdAt: now() });
    candidate.updatedAt = now();
    recalculateSession(candidate.sessionId);
  });
  res.json({ ...dto(getOrder(order.id)), refundAmount: amount });
});

router.put('/:id', requireRole('admin', 'cashier'), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ detail: 'Order not found' });
  validateOrderMutation(order);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.discount !== undefined) throw new ValidationError('Discounts must be applied through loyalty');
  if (body.tableId !== undefined) throw new ValidationError('Use draft sync to change a table');
  transaction(() => {
    const candidate = getOrder(order.id);
    if (body.customerName !== undefined) candidate.customerName = optionalText(body.customerName, 'Customer name', 200);
    if (body.notes !== undefined) candidate.notes = optionalText(body.notes, 'Notes');
    if (body.orderType !== undefined && ['dine_in', 'takeaway', 'delivery'].includes(body.orderType)) candidate.orderType = body.orderType;
    candidate.updatedAt = now();
  });
  res.json(dto(getOrder(order.id)));
});

module.exports = router;
