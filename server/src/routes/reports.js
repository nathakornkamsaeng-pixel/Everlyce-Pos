const express = require('express');
const { coll } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { itemLineTotal, parsedModifiers } = require('../orderTotals');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier', 'kds'));

const ROUND2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const dayKey = (iso) => new Date(iso).toLocaleDateString('en-CA');

function settledOrders() {
  return coll('orders').filter((order) => ['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus));
}

function netTotal(order) {
  return Math.max(0, (Number(order.total) || 0) - (Number(order.refundedAmount) || 0));
}

function range(req) {
  const from = req.query.from ? new Date(`${req.query.from}T00:00:00`) : null;
  const to = req.query.to ? new Date(`${req.query.to}T23:59:59.999`) : null;
  return (order) => (!from || new Date(order.createdAt) >= from) && (!to || new Date(order.createdAt) <= to);
}

// branchId=all (or absent) reports on the whole store; a number narrows it to
// one branch so a manager can compare locations.
function branchFilter(req) {
  const wanted = req.query.branchId;
  if (!wanted || wanted === 'all') return () => true;
  return (order) => Number(order.branchId) === Number(wanted);
}

function withBranch(req) {
  const inRange = range(req);
  const inBranch = branchFilter(req);
  return (order) => inRange(order) && inBranch(order);
}

function dateOrders(req) {
  return settledOrders().filter(withBranch(req));
}

function itemStats(orders) {
  const stats = {};
  for (const order of orders) {
    for (const item of coll('orderItems')) {
      if (Number(item.orderId) !== Number(order.id) || item.status === 'cancelled') continue;
      const quantity = Math.max(0, (Number(item.quantity) || 0) - (Number(item.refundedQuantity) || 0));
      if (!quantity) continue;
      const key = item.productName;
      if (!stats[key]) stats[key] = { name: key, qty: 0, revenue: 0 };
      stats[key].qty += quantity;
      const line = itemLineTotal({ ...item, quantity });
      stats[key].revenue += line;
    }
  }
  return Object.values(stats).sort((a, b) => b.revenue - a.revenue).map((item) => ({ ...item, revenue: ROUND2(item.revenue) }));
}

router.get('/dashboard', (req, res) => {
  const inBranch = branchFilter(req);
  const orders = coll('orders').filter((order) => order.draft !== true && inBranch(order));
  const paid = settledOrders().filter(inBranch);
  const today = new Date().toLocaleDateString('en-CA');
  const todayPaid = paid.filter((order) => dayKey(order.createdAt) === today);
  const totalRevenue = ROUND2(paid.reduce((sum, order) => sum + netTotal(order), 0));
  const methods = {};
  for (const payment of coll('payments')) {
    const order = orders.find((candidate) => Number(candidate.id) === Number(payment.orderId));
    if (!order || !['paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) continue;
    const amount = Math.max(0, (Number(payment.amount) || 0) - (Number(payment.refundedAmount) || 0));
    methods[payment.method] = ROUND2((methods[payment.method] || 0) + amount);
  }
  const statusBreakdown = {};
  for (const order of orders) statusBreakdown[order.status] = (statusBreakdown[order.status] || 0) + 1;
  res.json({
    totalRevenue,
    totalDiscount: ROUND2(paid.reduce((sum, order) => sum + (Number(order.discount) || 0), 0)),
    totalTax: ROUND2(paid.reduce((sum, order) => sum + (Number(order.tax) || 0), 0)),
    totalTips: ROUND2(paid.reduce((sum, order) => sum + (Number(order.tip) || 0), 0)),
    activeOrders: orders.filter((order) => order.paymentStatus === 'pending' && order.status !== 'cancelled').length,
    completedOrders: paid.filter((order) => netTotal(order) > 0).length,
    voidedOrders: orders.filter((order) => order.paymentStatus === 'voided').length,
    todayRevenue: ROUND2(todayPaid.reduce((sum, order) => sum + netTotal(order), 0)),
    todayOrderCount: todayPaid.length,
    avgOrderValue: paid.length ? ROUND2(totalRevenue / paid.length) : 0,
    statusBreakdown,
    topItems: itemStats(paid).slice(0, 8),
    paymentMethods: methods,
    recentOrders: orders.slice().sort((a, b) => b.id - a.id).slice(0, 10).map((order) => ({ ...order, tableName: (coll('tables').find((table) => Number(table.id) === Number(order.tableId)) || {}).name || null })),
  });
});

router.get('/reports/sales', (req, res) => {
  const orders = dateOrders(req);
  const totalRevenue = ROUND2(orders.reduce((sum, order) => sum + netTotal(order), 0));
  const byDay = {};
  const methods = {};
  for (const order of orders) {
    const key = dayKey(order.createdAt);
    byDay[key] = byDay[key] || { revenue: 0, count: 0 };
    byDay[key].revenue = ROUND2(byDay[key].revenue + netTotal(order));
    byDay[key].count += 1;
    if (order.paymentMethod) methods[order.paymentMethod] = ROUND2((methods[order.paymentMethod] || 0) + netTotal(order));
  }
  res.json({ totalRevenue, totalDiscounts: ROUND2(orders.reduce((sum, order) => sum + (Number(order.discount) || 0), 0)), totalTax: ROUND2(orders.reduce((sum, order) => sum + (Number(order.tax) || 0), 0)), totalTips: ROUND2(orders.reduce((sum, order) => sum + (Number(order.tip) || 0), 0)), avgOrderValue: orders.length ? ROUND2(totalRevenue / orders.length) : 0, orderCount: orders.length, byDay, paymentMethods: methods });
});

router.get('/reports/top-items', (req, res) => res.json(itemStats(dateOrders(req))));

module.exports = router;
