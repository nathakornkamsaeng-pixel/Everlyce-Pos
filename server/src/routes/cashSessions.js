const express = require('express');
const { coll, nextId, now, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');

const router = express.Router();
router.use(requireAuth, requireRole('admin', 'cashier'));

function amount(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return Math.round(number * 100) / 100;
}

function cashTotal(session, at = new Date()) {
  const end = session.closedAt ? new Date(session.closedAt).getTime() : at.getTime();
  const start = new Date(session.openedAt).getTime();
  const payments = coll('payments').filter((payment) => payment.method === 'cash' && (!payment.cashSessionId || Number(payment.cashSessionId) === Number(session.id)) && new Date(payment.createdAt).getTime() >= start && new Date(payment.createdAt).getTime() <= end);
  const refunds = coll('refunds').filter((refund) => refund.method === 'cash' && new Date(refund.createdAt).getTime() >= start && new Date(refund.createdAt).getTime() <= end);
  const paymentTotal = payments.reduce((sum, payment) => sum + Math.max(0, (Number(payment.amount) || 0) - (Number(payment.refundedAmount) || 0)), 0);
  const refundTotal = refunds.reduce((sum, refund) => sum + (Number(refund.amount) || 0), 0);
  return Math.round((Number(session.openingAmount) || 0) + paymentTotal - refundTotal) * 100 / 100;
}

router.get('/', (req, res) => res.json(coll('cashSessions').slice().sort((a, b) => b.id - a.id).map((session) => ({ ...session, expectedAmount: session.status === 'open' ? cashTotal(session) : session.expectedAmount }))));

router.get('/active', (req, res) => {
  // Each branch has its own open till; the active branch decides which is shown.
  const wanted = req.query.branchId;
  const sessions = coll('cashSessions').filter((c) => c.status === 'open');
  const session = wanted && wanted !== 'all'
    ? sessions.find((candidate) => Number(candidate.branchId) === Number(wanted))
    : (sessions.find((c) => Number(c.branchId) === Number(req.branchId)) || sessions[0]);
  res.json(session ? { ...session, expectedAmount: cashTotal(session) } : null);
});

router.post('/', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const openingAmount = amount(body.openingAmount === undefined ? 0 : body.openingAmount, 'Opening amount');
  // Each branch keeps its own till, so a manager can see both drawers at once.
  if (coll('cashSessions').some((session) => session.status === 'open' && Number(session.branchId) === Number(req.branchId))) {
    return res.status(400).json({ detail: 'A cash session is already open for this branch' });
  }
  const session = { id: nextId('cashSessions'), branchId: req.branchId || null, openedBy: req.user.id, openedByUsername: req.user.username, openedAt: now(), openingAmount, closedAt: null, closingAmount: null, expectedAmount: openingAmount, varianceAmount: null, status: 'open' };
  coll('cashSessions').push(session);
  touch();
  res.status(201).json(session);
});

router.post('/:id/close', (req, res) => {
  const session = coll('cashSessions').find((candidate) => Number(candidate.id) === Number(req.params.id));
  if (!session) return res.status(404).json({ detail: 'Cash session not found' });
  if (session.status !== 'open') return res.status(400).json({ detail: 'Session already closed' });
  if (Number(req.user.id) !== Number(session.openedBy) && req.user.role !== 'admin') return res.status(403).json({ detail: 'Only the opener or an admin can close this drawer' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.closingAmount === undefined || body.closingAmount === null || body.closingAmount === '') return res.status(400).json({ detail: 'Closing amount is required' });
  const closingAmount = amount(body.closingAmount, 'Closing amount');
  const expectedAmount = cashTotal(session);
  session.closingAmount = closingAmount;
  session.expectedAmount = expectedAmount;
  session.varianceAmount = Math.round((closingAmount - expectedAmount) * 100) / 100;
  session.closedAt = now();
  session.status = 'closed';
  touch();
  res.json(session);
});

module.exports = router;
