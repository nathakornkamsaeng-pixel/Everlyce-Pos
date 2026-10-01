const express = require('express');
const { coll } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier', 'kds'));

const ACTIVE = ['pending', 'preparing'];
const DONE = ['ready', 'served'];

function kdsDto(order) {
  const items = coll('orderItems')
    .filter((i) => i.orderId === order.id && i.status !== 'cancelled' && !i.refunded)
    .map((i) => {
      let modifiers = [];
      try { modifiers = i.modifiers ? JSON.parse(i.modifiers) : []; } catch (e) {}
      return { ...i, modifiers };
    });
  const table = coll('tables').find((t) => t.id === order.tableId);
  const started = order.startedAt || order.createdAt;
  return {
    ...order,
    items,
    tableName: table ? table.name : null,
    startedAt: started,
    elapsedMs: Math.max(0, Date.now() - new Date(started).getTime()),
    prepMs: order.prepMs,
  };
}

function isReal(order) {
  return !order.draft && order.paymentStatus !== 'voided';
}

// Two states only: preparing (in the kitchen) and done (finished).
// A finished order is dropped from the feed entirely and only lives in the statistics.
router.get('/orders', (req, res) => {
  const active = coll('orders')
    .filter((o) => isReal(o) && ACTIVE.includes(o.status))
    .sort((a, b) => new Date(a.startedAt || a.createdAt) - new Date(b.startedAt || b.createdAt))
    .map(kdsDto);
  res.json({ active, overdueMinutes: Number(coll('settings').kdsOverdueMinutes) || 15 });
});

// Preparation-time statistics saved from the in/out timers.
router.get('/stats', (req, res) => {
  const done = coll('orders').filter((o) => isReal(o) && DONE.includes(o.status) && o.prepMs != null);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const times = done.map((o) => Number(o.prepMs)).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : 0);
  const today = done.filter((o) => new Date(o.completedAt || o.updatedAt) >= startOfToday).map((o) => Number(o.prepMs));
  const last7 = [...new Set(done.map((o) => (o.completedAt || o.updatedAt || '').slice(0, 10)))]
    .sort()
    .slice(-7)
    .map((day) => {
      const rows = done.filter((o) => (o.completedAt || o.updatedAt || '').startsWith(day)).map((o) => Number(o.prepMs));
      return { day, count: rows.length, avgMs: avg(rows) };
    });

  const itemTimes = {};
  for (const o of done) {
    for (const i of coll('orderItems').filter((x) => x.orderId === o.id)) {
      const key = i.productName;
      if (!itemTimes[key]) itemTimes[key] = { name: key, count: 0, totalMs: 0 };
      itemTimes[key].count += 1;
      itemTimes[key].totalMs += Number(o.prepMs) || 0;
    }
  }

  res.json({
    completed: done.length,
    averageMs: avg(times),
    todayCount: today.length,
    todayAverageMs: avg(today),
    fastestMs: times.length ? times[0] : 0,
    slowestMs: times.length ? times[times.length - 1] : 0,
    byDay: last7,
    topItems: Object.values(itemTimes)
      .map((x) => ({ name: x.name, count: x.count, avgMs: Math.round(x.totalMs / x.count) }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
  });
});

module.exports = router;
