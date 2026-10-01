const express = require('express');
const crypto = require('crypto');
const { coll, nextId, now, touch, transaction, recalculateSession, releaseStockForOrder } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier'));

function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function dto(session) {
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(session.tableId));
  const orders = coll('orders').filter((order) => Number(order.sessionId) === Number(session.id)).sort((a, b) => a.id - b.id);
  const pending = orders.filter((order) => order.paymentStatus === 'pending' && order.status !== 'cancelled');
  const openDrafts = pending.filter((order) => order.draft === true);
  const blockers = pending.filter((order) => order.draft !== true || coll('orderItems').some((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded));
  return {
    ...session,
    tableName: table ? table.name : null,
    orders,
    pendingCount: pending.filter((order) => order.draft !== true).length,
    openDraftCount: openDrafts.length,
    canClose: blockers.length === 0,
  };
}

router.get('/', (req, res) => res.json(coll('sessions').slice().sort((a, b) => b.id - a.id).map(dto)));
router.get('/active', (req, res) => res.json(coll('sessions').filter((session) => session.status === 'open').sort((a, b) => b.id - a.id).map(dto)));

router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(body.tableId));
  if (!table) return res.status(400).json({ detail: 'Table not found' });
  if (coll('sessions').some((session) => Number(session.tableId) === Number(table.id) && session.status === 'open')) return res.status(400).json({ detail: 'Table already has an open session' });
  // A missing guest count is normal (open the table, count later), so default
  // to 1. Nonsense values are still rejected.
  const raw = body.guestCount;
  const guests = raw === undefined || raw === null || raw === '' ? 1 : Number(raw);
  if (!Number.isSafeInteger(guests) || guests < 1 || guests > 100) return res.status(400).json({ detail: 'Invalid guest count' });
  // A session inherits its branch from the table, so the two can never disagree.
  const session = { id: nextId('sessions'), tableId: table.id, branchId: table.branchId || req.branchId || null, token: genToken(), openedBy: req.user.id, guestCount: guests, openedAt: now(), closedAt: null, total: 0, orderCount: 0, status: 'open' };
  coll('sessions').push(session);
  touch();
  log(EVENTS.SESSION_OPEN, req, { table: table.name, guests, session: session.id });
  res.status(201).json(dto(session));
});

router.post('/:id/close', (req, res) => {
  const session = coll('sessions').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!session) return res.status(404).json({ detail: 'Session not found' });
  if (session.status !== 'open') return res.json(dto(session));

  const result = transaction(() => {
    const candidate = coll('sessions').find((row) => Number(row.id) === Number(req.params.id));
    const emptyDrafts = coll('orders').filter((order) => (
      Number(order.sessionId) === Number(candidate.id)
      && order.draft === true
      && order.paymentStatus === 'pending'
      && order.status !== 'cancelled'
      && !coll('orderItems').some((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded)
    ));
    const emptyDraftIds = new Set(emptyDrafts.map((order) => order.id));
    for (const id of emptyDraftIds) releaseStockForOrder(id);
    if (emptyDraftIds.size) {
      const orders = coll('orders');
      orders.splice(0, orders.length, ...orders.filter((order) => !emptyDraftIds.has(order.id)));
      const items = coll('orderItems');
      items.splice(0, items.length, ...items.filter((item) => !emptyDraftIds.has(item.orderId)));
    }

    const openOrders = coll('orders').filter((order) => Number(order.sessionId) === Number(candidate.id) && order.paymentStatus === 'pending' && order.status !== 'cancelled');
    if (!openOrders.length) {
      candidate.closedAt = now();
      candidate.status = 'closed';
      recalculateSession(candidate.id);
    }
    return { session: candidate, discardedDrafts: emptyDrafts, openOrders };
  });

  if (result.discardedDrafts.length) {
    log(EVENTS.ORDER_DISCARD, req, { session: session.id, count: result.discardedDrafts.length, reason: 'empty-on-close' });
  }
  if (result.openOrders.length) {
    const openDrafts = result.openOrders.filter((order) => order.draft === true);
    return res.status(409).json({
      detail: 'Settle or discard all open orders before closing the table',
      openOrders: result.openOrders.length,
      openDrafts: openDrafts.length,
      discardedDrafts: result.discardedDrafts.length,
      blockingOrders: result.openOrders.map((order) => ({
        id: order.id,
        orderNumber: order.orderNumber,
        draft: order.draft === true,
        activeItemCount: coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded).length,
      })),
    });
  }
  log(EVENTS.SESSION_CLOSE, req, { session: result.session.id, table: result.session.tableId, discardedDrafts: result.discardedDrafts.length });
  res.json({ ...dto(result.session), discardedDrafts: result.discardedDrafts.length });
});

module.exports = router;
