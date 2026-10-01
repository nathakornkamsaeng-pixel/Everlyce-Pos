const express = require('express');
const { coll, now, touch, releaseStockForOrder } = require('../db');
const activityLog = require('../activityLog');
const { log, EVENTS } = activityLog;
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

// What an admin is allowed to wipe, and how much each target removes.
const TARGETS = {
  drafts: {
    label: 'Abandoned register tickets',
    hint: 'Empty/unpaid working tickets left behind at the register.',
    run: () => {
      const ids = new Set(coll('orders').filter((o) => o.draft && o.paymentStatus === 'pending').map((o) => o.id));
      return removeOrders(ids);
    },
  },
  completedOrders: {
    label: 'Completed orders',
    hint: 'All served/ready orders, including their items and payments.',
    run: () => {
      const ids = new Set(coll('orders').filter((o) => !o.draft && ['ready', 'served', 'cancelled'].includes(o.status)).map((o) => o.id));
      return removeOrders(ids);
    },
  },
  kitchenStats: {
    label: 'Kitchen statistics',
    hint: 'Resets the recorded in/out times and preparation durations. Orders, takings and reports of sales stay exactly as they are.',
    run: () => {
      let n = 0;
      for (const o of coll('orders')) {
        if (o.prepMs != null || o.completedAt || o.startedAt) {
          o.startedAt = null;
          o.completedAt = null;
          o.prepMs = null;
          n += 1;
        }
      }
      return n;
    },
  },
  loyaltyLedger: {
    label: 'Loyalty point history',
    hint: 'Clears the earn/redeem ledger. Members keep their current point balances and tiers.',
    run: () => {
      const n = coll('loyaltyLedger').length;
      state_replace('loyaltyLedger', []);
      return n;
    },
  },
  openOrders: {
    label: 'Open / unpaid orders',
    hint: 'Orders that are still pending payment.',
    run: () => {
      const ids = new Set(coll('orders').filter((o) => !o.draft && o.paymentStatus === 'pending' && !['ready', 'served', 'cancelled'].includes(o.status)).map((o) => o.id));
      return removeOrders(ids);
    },
  },
  sessions: {
    label: 'Table sessions & QR codes',
    hint: 'All table visits. Every QR code stops working immediately.',
    run: () => {
      const n = coll('sessions').length;
      state_replace('sessions', []);
      return n;
    },
  },
  cashSessions: {
    label: 'Cash drawer sessions',
    hint: 'Open/close history for the cash drawer.',
    run: () => {
      const n = coll('cashSessions').length;
      state_replace('cashSessions', []);
      return n;
    },
  },
  discounts: {
    label: 'Discount codes',
    hint: 'All discount codes and their settings.',
    run: () => {
      const n = coll('discounts').length;
      state_replace('discounts', []);
      return n;
    },
  },
  translations: {
    label: 'Translations',
    hint: 'Custom menu translations and saved overrides. Built-in cashier labels remain available.',
    run: () => {
      const n = coll('translations').length;
      state_replace('translations', []);
      return n;
    },
  },
};

function state_replace(name, value) {
  // coll() returns the live array reference held by the store.
  const live = coll(name);
  live.splice(0, live.length, ...value);
}

function removeOrders(ids) {
  if (!ids.size) return 0;
  for (const id of ids) {
    const order = coll('orders').find((candidate) => Number(candidate.id) === Number(id));
    if (order && order.paymentStatus === 'pending') releaseStockForOrder(id);
  }
  state_replace('orders', coll('orders').filter((o) => !ids.has(o.id)));
  state_replace('orderItems', coll('orderItems').filter((i) => !ids.has(i.orderId)));
  state_replace('payments', coll('payments').filter((p) => !ids.has(p.orderId)));
  state_replace('promptPayRequests', coll('promptPayRequests').filter((request) => !request.orderIds.some((id) => ids.has(id))));
  return ids.size;
}

// Plain log: read the tail, or wipe it.
router.get('/log', (req, res) => {
  res.json(activityLog.read({ lines: req.query.lines, includeRotated: req.query.rotated === '1' }));
});

router.delete('/log', (req, res) => {
  log(EVENTS.DATA_CLEAR, req, { targets: 'activity-log' });
  activityLog.clear();
  res.json({ ok: true });
});

router.get('/targets', (req, res) => {
  res.json(Object.entries(TARGETS).map(([id, t]) => ({ id, label: t.label, hint: t.hint })));
});

router.post('/clear', (req, res) => {
  const targets = Array.isArray((req.body || {}).targets) ? req.body.targets : [];
  const chosen = targets.filter((t) => TARGETS[t]);
  if (!chosen.length) return res.status(400).json({ detail: 'Select at least one item to clear' });

  const removed = {};
  for (const id of chosen) {
    try {
      const n = TARGETS[id].run();
      if (n) removed[id] = n;
    } catch (e) {
      return res.status(500).json({ detail: `Could not clear ${id}: ${e.message}` });
    }
  }
  log(EVENTS.DATA_CLEAR, req, { targets: chosen.join(','), counts: JSON.stringify(removed) });
  touch();
  res.json({ removed, at: now() });
});

module.exports = router;
