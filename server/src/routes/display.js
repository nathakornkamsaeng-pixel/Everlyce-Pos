const express = require('express');
const { coll } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('display'));

function parseModifiers(item) {
  try { return JSON.parse(item.modifiers || '[]'); } catch (e) { return []; }
}

function getOrder(id) {
  return coll('orders').find((order) => Number(order.id) === Number(id));
}

function modifierAdj(item) {
  return parseModifiers(item).reduce((s, m) => s + (Number(m.adj) || 0), 0);
}

function orderDto(o) {
  const table = coll('tables').find((t) => t.id === o.tableId);
  const items = coll('orderItems').filter((i) => i.orderId === o.id).map((i) => ({
    id: i.id,
    name: i.productName,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
    lineTotal: Math.round((Number(i.unitPrice) + modifierAdj(i)) * i.quantity * 100) / 100,
    notes: i.notes,
    modifiers: parseModifiers(i),
  }));
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod || null,
    promptPayRequestId: o.promptPayRequestId || null,
    customerName: o.customerName,
    tableName: table ? table.name : null,
    subtotal: o.subtotal,
    tax: o.tax,
    serviceCharge: o.serviceCharge,
    discount: o.discount,
    total: o.total,
    items,
    memberId: o.memberId || null,
    memberName: o.memberName || null,
    pointsUsed: Number(o.pointsUsed) || 0,
    pointsEarned: Number(o.pointsEarned) || 0,
    pointsBalance: o.pointsBalance == null ? null : Number(o.pointsBalance),
    coupons: o.coupons || [],
    discount: o.discount,
    createdAt: o.createdAt,
  };
}

router.get('/current', (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  const user = coll('users').find((u) => u.id === req.user.id);
  const settings = coll('settings');
  const isStaff = (u) => u && u.active && ['cashier', 'admin'].includes(u.role);
  const cashierId = user ? user.cashierId : null;
  const cashier = cashierId ? coll('users').find((u) => Number(u.id) === Number(cashierId) && isStaff(u)) : null;

  if (!cashierId || !cashier) {
    return res.json({
      cashier: null,
      order: null,
      tableOrders: [],
      promptPay: null,
      receipt: null,
      lastPaid: null,
      lastPaidAt: null,
      settings: {
        restaurantName: settings.restaurantName,
        cdsLanguage: settings.cdsLanguage || 'th',
        taxRate: settings.taxRate,
        serviceChargeRate: settings.serviceChargeRate,
        currency: settings.currency,
      },
    });
  }

  const openDrafts = coll('orders')
    .filter((o) => Number(o.createdBy) === Number(cashierId) && o.draft && o.paymentStatus === 'pending' && o.status !== 'cancelled')
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  const isActive = (o) => o.paymentStatus === 'pending' && o.status !== 'cancelled';
  const hasItems = (id) => coll('orderItems').some((item) => item.orderId === id && item.status !== 'cancelled' && !item.refunded);
  const draft = openDrafts.find((order) => hasItems(order.id)) || null;

  const promptPayRequest = coll('promptPayRequests')
    .filter((request) => request.status === 'pending' && Number(request.createdBy) === Number(cashierId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
  const promptPayOrders = promptPayRequest
    ? promptPayRequest.orderIds.map((id) => getOrder(id)).filter((order) => order && isActive(order))
    : [];
  let focusTableId = draft && draft.tableId ? draft.tableId : null;
  if (!focusTableId && promptPayOrders.length) focusTableId = promptPayOrders[0].tableId || null;

  const tableOrders = focusTableId
    ? coll('orders')
        .filter((o) => !o.draft && Number(o.tableId) === Number(focusTableId) && isActive(o))
        .sort((a, b) => a.id - b.id)
        .map(orderDto)
    : [];

  const focusTable = focusTableId ? coll('tables').find((t) => Number(t.id) === Number(focusTableId)) : null;
  const focusSession = focusTableId
    ? coll('sessions').find((sess) => Number(sess.tableId) === Number(focusTableId) && sess.status === 'open')
    : null;

  const recentPaid = coll('orders')
    .filter((o) => o.paymentStatus === 'paid' && (Number(o.paidBy) === Number(cashierId) || Number(o.createdBy) === Number(cashierId)))
    .sort((a, b) => new Date(b.paidAt || b.updatedAt || b.createdAt) - new Date(a.paidAt || a.updatedAt || a.createdAt))[0] || null;

  const showPaid = recentPaid && (!draft || new Date(recentPaid.paidAt || recentPaid.updatedAt) >= new Date(draft.updatedAt || draft.createdAt));
  const receiptReady = !draft
    && !promptPayRequest
    && recentPaid
    && recentPaid.receiptToken
    && new Date(recentPaid.receiptExpiresAt || 0).getTime() > Date.now()
    && new Date(recentPaid.receiptQrUntil || 0).getTime() > Date.now();

  res.json({
    cashier: { id: cashier.id, name: cashier.name },
    order: draft ? orderDto(draft) : null,
    tableOrders,
    table: focusTable ? { id: focusTable.id, name: focusTable.name, seats: focusTable.seats } : null,
    session: focusSession ? { id: focusSession.id, openedAt: focusSession.openedAt, guestCount: focusSession.guestCount } : null,
    promptPay: !draft && promptPayRequest && promptPayOrders.length ? { ...promptPayRequest, orders: promptPayOrders.map(orderDto) } : null,
    receipt: receiptReady ? { token: recentPaid.receiptToken, orderNumber: recentPaid.orderNumber, total: recentPaid.total, paidAt: recentPaid.paidAt, expiresAt: recentPaid.receiptExpiresAt } : null,
    lastPaid: showPaid ? orderDto(recentPaid) : null,
    lastPaidAt: showPaid ? (recentPaid.paidAt || recentPaid.updatedAt) : null,
    settings: {
      restaurantName: settings.restaurantName,
      cdsLanguage: settings.cdsLanguage || 'th',
      taxRate: settings.taxRate,
      serviceChargeRate: settings.serviceChargeRate,
      currency: settings.currency,
    },
  });
});

module.exports = router;
