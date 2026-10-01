const express = require('express');
const { coll, nextId, now, transaction, withStore, storeList } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { log, EVENTS } = require('../activityLog');
const { subscriptionFor, validateRequest, SubscriptionError } = require('../subscription');

const router = express.Router();
router.use(requireAuth);

// How many months a renewal defaults to, and what the tab offers.
const MONTH_CHOICES = [1, 3, 6, 12];

/**
 * The store's own subscription.
 *
 * A shop can read this and ask for a change, but it cannot grant itself a plan:
 * a request is recorded and waits for the platform. Reading it is what the tab
 * is built from, so the page never has to work out what the shop is allowed to
 * do next.
 */
router.get('/', (req, res) => {
  const pending = coll('planRequests').find(
    (request) => request.storeId === req.store.id && request.status === 'pending',
  ) || null;
  res.json({
    subscription: subscriptionFor(req.store, { pendingRequest: pending }),
    monthChoices: MONTH_CHOICES,
  });
});

/**
 * Ask for a plan.
 *
 * Either a shop's first paid plan after a trial, a renewal of the tier it is on,
 * or a move up a tier. None of them happen here; they are recorded for the
 * platform to fulfil.
 */
router.post('/request', requireRole('admin'), (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  // One at a time. Two pending requests means the platform has to guess which
  // one was meant, and the shop has no way to tell afterwards which was which.
  const existing = coll('planRequests').find(
    (request) => request.storeId === req.store.id && request.status === 'pending',
  );
  if (existing) {
    throw new SubscriptionError(
      'A plan change is already waiting to be confirmed. We will be in touch.',
      'request_pending',
      409,
    );
  }

  const requested = validateRequest(req.store, {
    plan: body.plan, months: body.months !== undefined ? body.months : 12,
  });

  const created = transaction(() => {
    const request = {
      id: nextId('planRequests'),
      storeId: req.store.id,
      storeSlug: req.store.slug,
      plan: requested.plan,
      planMonths: requested.months,
      change: requested.change,
      fromPlan: requested.fromPlan,
      amountTHB: requested.amountTHB,
      // Kept separate from the key, because the shop asked for a plan and a key
      // is how they are given it. They are not the same thing.
      status: 'pending',
      note: String(body.note || '').trim().slice(0, 500) || null,
      requestedBy: req.user.username,
      requestedById: req.user.id,
      createdAt: now(),
      fulfilledAt: null,
      keyId: null,
    };
    coll('planRequests').push(request);
    return request;
  });

  log(EVENTS.STORE_PLAN_REQUESTED, req, {
    store: req.store.slug, plan: created.plan, change: created.change, months: created.planMonths,
    amountTHB: created.amountTHB,
  });

  res.status(201).json({
    request: created,
    subscription: subscriptionFor(req.store, { pendingRequest: created }),
    message: created.change === 'activate'
      ? 'Your plan request is in. We will confirm it and send your key.'
      : created.change === 'upgrade'
        ? `Your upgrade to ${created.plan} is requested. We will confirm it shortly.`
        : `Your ${created.plan} renewal is requested. We will confirm it shortly.`,
  });
});

/**
 * Withdraw a request the platform has not acted on.
 *
 * Only while it is still pending. Once a key has been issued against it, the
 * request is history and taking it back would leave the two disagreeing.
 */
router.delete('/request/:id', requireRole('admin'), (req, res) => {
  const request = coll('planRequests').find((r) => Number(r.id) === Number(req.params.id));
  if (!request) throw new SubscriptionError('That request does not exist', 'not_found', 404);
  if (request.storeId !== req.store.id) throw new SubscriptionError('That request belongs to another store', 'not_yours', 403);
  if (request.status !== 'pending') {
    throw new SubscriptionError('That request has already been dealt with', 'already_fulfilled', 409);
  }
  request.status = 'withdrawn';
  request.withdrawnAt = now();
  log(EVENTS.STORE_PLAN_REQUEST_WITHDRAWN, req, { store: req.store.slug, planRequestWithdrawn: request.id });
  res.json({ ok: true, subscription: subscriptionFor(req.store) });
});

/**
 * Every request this store has ever made, for the tab's history.
 */
router.get('/requests', requireRole('admin'), (req, res) => {
  const requests = coll('planRequests')
    .filter((request) => request.storeId === req.store.id)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  res.json({ requests });
});

module.exports = router;