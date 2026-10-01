const express = require('express');
const crypto = require('crypto');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier', 'kds', 'display'));

function tableDto(table, user) {
  const session = coll('sessions').find((candidate) => Number(candidate.tableId) === Number(table.id) && candidate.status === 'open');
  const openOrders = session
    ? coll('orders').filter((order) => Number(order.sessionId) === Number(session.id) && order.paymentStatus === 'pending' && order.status !== 'cancelled')
    : [];
  const active = openOrders.filter((order) => order.draft !== true);
  const openDrafts = openOrders.filter((order) => order.draft === true).map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    total: order.total,
    itemCount: coll('orderItems').filter((item) => item.orderId === order.id && item.status !== 'cancelled' && !item.refunded).length,
    canDiscard: user && (user.role === 'admin' || Number(order.createdBy) === Number(user.id)),
  }));
  return {
    ...table,
    status: session ? 'occupied' : 'available',
    session: session ? { id: session.id, token: session.token, guestCount: session.guestCount, openedAt: session.openedAt, total: session.total, orderCount: session.orderCount } : null,
    activeOrders: active.map((order) => ({ id: order.id, orderNumber: order.orderNumber, status: order.status, total: order.total })),
    pendingOrderCount: active.length,
    pendingTotal: Math.round(active.reduce((sum, order) => sum + (Number(order.total) || 0), 0) * 100) / 100,
    openDrafts,
    canClose: active.length === 0 && openDrafts.every((order) => order.itemCount === 0),
  };
}

// Tables of every branch are returned, each tagged with its branchId, so the
// client can filter. Pass ?branchId=<id> for one branch, or branchId=all.
function inBranch(record, branchId) {
  if (branchId === 'all' || branchId === undefined || branchId === null || branchId === '') return true;
  return Number(record.branchId) === Number(branchId);
}

router.get('/', (req, res) => {
  const wanted = req.query.branchId;
  const list = coll('tables').filter((table) => inBranch(table, wanted));
  res.json(list.map((table) => tableDto(table, req.user)));
});

router.post('/', requireRole('admin'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!body.name) return res.status(400).json({ detail: 'name is required' });
  const branchId = body.branchId != null ? Number(body.branchId) : req.branchId;
  if (branchId && !coll('branches').some((b) => Number(b.id) === Number(branchId))) {
    return res.status(400).json({ detail: 'Unknown branch' });
  }
  const table = { id: nextId('tables'), name: String(body.name).trim(), token: crypto.randomBytes(8).toString('hex'), seats: Math.max(1, Number(body.seats) || 1), posX: Number(body.posX) || 0, posY: Number(body.posY) || 0, width: Math.max(1, Number(body.width) || 1), height: Math.max(1, Number(body.height) || 1), branchId: branchId || null, createdAt: now() };
  coll('tables').push(table);
  touch();
  res.status(201).json(tableDto(table, req.user));
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!table) return res.status(404).json({ detail: 'Table not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.name !== undefined) table.name = String(body.name).trim() || table.name;
  if (body.seats !== undefined) table.seats = Math.max(1, Number(body.seats) || 1);
  if (body.posX !== undefined) table.posX = Number(body.posX) || 0;
  if (body.posY !== undefined) table.posY = Number(body.posY) || 0;
  if (body.width !== undefined) table.width = Math.max(1, Number(body.width) || 1);
  if (body.height !== undefined) table.height = Math.max(1, Number(body.height) || 1);
  if (body.branchId !== undefined) {
    const branchId = Number(body.branchId);
    if (!coll('branches').some((b) => Number(b.id) === branchId)) {
      return res.status(400).json({ detail: 'Unknown branch' });
    }
    table.branchId = branchId;
  }
  touch();
  res.json(tableDto(table, req.user));
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const table = coll('tables').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!table) return res.status(404).json({ detail: 'Table not found' });
  const referenced = coll('sessions').some((session) => Number(session.tableId) === Number(table.id)) || coll('orders').some((order) => Number(order.tableId) === Number(table.id));
  if (referenced) return res.status(409).json({ detail: 'Table cannot be deleted while it has session or order history' });
  coll('tables').splice(coll('tables').indexOf(table), 1);
  touch();
  res.json({ ok: true });
});

module.exports = router;
