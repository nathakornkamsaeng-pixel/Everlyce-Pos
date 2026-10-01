// Taking payment for an order.
//
// Extracted out of the orders route so the money path can be tested without
// booting HTTP, which is the only way to get through a few hundred cases
// against totals, partial payments and replayed requests. The route still owns
// authentication, the response shape and the activity log; this owns the rules.
//
// Two things it is careful about, because both have cost real money before:
//
//   Idempotency. A retried request with the same key returns the original
//   result rather than taking a second payment.
//
//   All or nothing. The caller wraps this in a transaction. Every write here
//   happens inside the same one, so an order can never end up paid with no
//   payment row, or paid twice with one.
//
// One trap worth naming, because it is easy to get wrong and it fails quietly.
//
// The `order` argument must be read INSIDE the transaction, not before it:
//
//   good:  repo.transaction(() => checkout.settle({ repo, order: getOrder(id) }))
//   wrong: const o = getOrder(id); repo.transaction(() => settle({ order: o }))
//
// A transaction swaps in a copy of the document, so a reference read beforehand
// points at the pre-transaction copy. Mutating it writes to a version that the
// rollback then restores from, and the order field changes survive a rollback
// that was supposed to undo them: the payment row disappears but the order stays
// marked paid. Every route here already reads the order inside the transaction
// for exactly this reason.
'use strict';

const crypto = require('crypto');

class CheckoutError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'CheckoutError';
    this.status = status;
    this.code = 'checkout_error';
  }
}

const ROUND2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const METHODS_WITHOUT_PROMPTPAY = ['cash', 'card', 'other'];
const METHODS_WITH_PROMPTPAY = ['cash', 'card', 'other', 'promptpay'];

function activeItems(repo, order) {
  return repo.coll('orderItems')
    .filter((item) => Number(item.orderId) === Number(order.id) && item.status !== 'cancelled' && !item.refunded);
}

function setTip(order, value) {
  if (value === undefined || value === null || value === '') return;
  const tip = Number(value);
  if (!Number.isFinite(tip) || tip < 0 || tip > 1000000) throw new CheckoutError('Invalid tip');
  order.tip = tip;
}

function paymentMethod(value, allowPromptPay) {
  const method = value || 'cash';
  const allowed = allowPromptPay ? METHODS_WITH_PROMPTPAY : METHODS_WITHOUT_PROMPTPAY;
  if (!allowed.includes(method)) throw new CheckoutError('Invalid payment method');
  return method;
}

function openCashSession(repo) {
  return repo.coll('cashSessions').find((s) => s.status === 'open') || null;
}

/**
 * Settle an order.
 *
 * @param {object}   opts.repo      repository, already inside a store context
 * @param {object}   opts.order     the order, as a live record
 * @param {object}   opts.body      { method, received, tip, idempotencyKey }
 * @param {object}   opts.actor     { id } who is settling, for the audit trail
 * @param {object}   opts.deps      { recompute, recalculateSession, settleLoyalty,
 *                                    memberRequired }
 * @param {boolean}  opts.allowPromptPay
 * @returns {{ order: object, payment: object|null, idempotent: boolean }}
 */
function settle({ repo, order, body = {}, actor = {}, deps = {}, allowPromptPay = false }) {
  const { recompute, recalculateSession, settleLoyalty, memberRequired } = deps;
  const input = body && typeof body === 'object' ? body : {};

  if (order.paymentStatus !== 'pending') {
    // A retry after a dropped response is normal, not an error. Returning the
    // original result is what stops a flaky network charging someone twice.
    if (input.idempotencyKey) {
      const existing = repo.coll('payments').find((p) => (
        Number(p.orderId) === Number(order.id)
        && p.idempotencyKey
        && p.idempotencyKey === String(input.idempotencyKey)
      ));
      if (existing) return { order, payment: existing, idempotent: true };
    }
    throw new CheckoutError('Order is already closed', 409);
  }

  if (!allowPromptPay && order.promptPayRequestId) {
    const request = repo.coll('promptPayRequests')
      .find((c) => Number(c.id) === Number(order.promptPayRequestId) && c.status === 'pending');
    if (request) throw new CheckoutError('Payment is awaiting confirmation', 409);
  }

  if (activeItems(repo, order).length === 0) throw new CheckoutError('Cannot check out an empty order');
  if (input.discount !== undefined) throw new CheckoutError('Discounts must be applied through loyalty');

  setTip(order, input.tip);
  recompute(order);

  const method = paymentMethod(input.method, allowPromptPay);
  const amount = Number(order.total);
  if (!Number.isFinite(amount) || amount < 0) throw new CheckoutError('Invalid order total');

  // Cash is not a payment provider, and it stays that way: it needs a drawer,
  // because that is what makes the takings countable at close.
  const cashSession = method === 'cash' ? openCashSession(repo) : null;
  if (method === 'cash' && !cashSession) throw new CheckoutError('Open a cash drawer before taking cash', 409);

  if (memberRequired && memberRequired() && !order.memberId) {
    throw new CheckoutError('A loyalty member is required for this order');
  }

  const received = method === 'cash'
    ? (input.received === undefined || input.received === null ? amount : Number(input.received))
    : amount;
  if (!Number.isFinite(received) || received < amount || received < 0) {
    throw new CheckoutError('Payment received is less than the amount due');
  }
  const change = method === 'cash' ? ROUND2(received - amount) : 0;

  const payment = {
    id: repo.nextId('payments'),
    orderId: order.id,
    method,
    amount,
    change,
    received,
    cashSessionId: cashSession ? cashSession.id : null,
    idempotencyKey: input.idempotencyKey ? String(input.idempotencyKey).slice(0, 100) : null,
    createdBy: actor.id ?? null,
    createdAt: repo.now(),
  };
  repo.coll('payments').push(payment);

  if (settleLoyalty) settleLoyalty(order, actor);

  order.paymentStatus = 'paid';
  order.paymentMethod = method;
  order.draft = false;
  order.status = 'served';

  const paidAt = repo.now();
  order.paidAt = paidAt;
  order.paidBy = actor.id ?? null;
  order.receiptToken = crypto.randomBytes(16).toString('hex');
  order.receiptExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  order.receiptQrUntil = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  if (!order.completedAt) {
    order.completedAt = paidAt;
    const started = new Date(order.startedAt || order.createdAt).getTime();
    order.prepMs = Math.max(0, new Date(paidAt).getTime() - started);
  }

  // Stock moves from reserved to consumed at the moment of sale, not before.
  for (const item of activeItems(repo, order)) {
    item.stockReserved = false;
    item.stockConsumed = true;
  }

  if (recalculateSession && (order.sessionId || order.id)) recalculateSession(order.sessionId);
  order.updatedAt = paidAt;

  return { order, payment, idempotent: false };
}

module.exports = {
  settle, activeItems, setTip, paymentMethod, openCashSession, ROUND2, CheckoutError,
};
