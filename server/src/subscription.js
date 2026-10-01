// What a store's subscription is, and what it may do next.
//
// A shop's plan is not something the till needs to reason about, but somebody
// has to answer three questions honestly, and getting any of them wrong has a
// cost:
//
//   Is my trial running, and for how long?
//   What am I paying for?
//   What can I change by myself?
//
// The last one is the interesting one. A store may ask to move, but it may not
// grant itself a plan: deciding what a shop pays for is the platform's job, not
// the customer's. So a plan change is a request, held pending until somebody at
// the platform issues a key, which is the same mechanism a shop has always used
// to activate. Nothing here can raise a shop's tier on its own.
//
// Upgrades and renewals are separated because they are different promises.
// A renewal keeps the same tier and buys more time. An upgrade moves up a tier.
// A downgrade is refused rather than queued, because a shop that is over its
// new limits the moment it downgrades would break on the way down, and there is
// no useful reading of "I'll take the cheaper plan" that does not first involve
// the shop being above that plan's limits.

const { PLANS, STORE_STATUS } = require('./db');
const { trialDaysLeft } = require('./trial');

// Ordered cheapest first. Index is the tier, which is all the comparison the
// upgrade rule needs.
const PLAN_ORDER = ['starter', 'professional', 'enterprise'];

function planRank(id) {
  return PLAN_ORDER.indexOf(String(id || ''));
}

function isKnownPlan(id) {
  return Object.prototype.hasOwnProperty.call(PLANS, String(id || ''));
}

class SubscriptionError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.status = status;
  }
}

function planSummary(id) {
  const plan = PLANS[id];
  if (!plan) return null;
  const uncapped = !plan.priceTHB;
  return {
    id: plan.id,
    name: plan.name,
    priceTHB: plan.priceTHB,
    uncapped,
    maxUsers: plan.maxUsers || null,
    maxProducts: plan.maxProducts || null,
    maxBranches: plan.maxBranches || null,
    rank: planRank(plan.id),
  };
}

/**
 * The subscription view of a store.
 *
 * `canRequest` is the whole point. The tab renders from this rather than
 * deciding for itself, so the till and the platform cannot disagree about what
 * a shop is allowed to ask for.
 */
function subscriptionFor(store, { pendingRequest = null } = {}) {
  if (!store) return null;

  const plan = planSummary(store.plan) || planSummary('starter');
  const onTrial = Boolean(store.onTrial && store.trialEndsAt);
  const trialEnded = store.suspensionReason === 'trial_expired';
  const suspended = store.status === STORE_STATUS.SUSPENDED;

  // The clock the shop should believe.
  //
  // Computed here rather than read off the store, because the store record has
  // no such field: the day count only exists on the public summary. Reading it
  // from the store returns nothing, and the tab then shows a shop that is
  // demonstrably on a trial with no days left and no deadline against it.
  const daysLeft = onTrial || trialEnded ? trialDaysLeft(store) : null;

  const currentRank = planRank(store.plan);
  const upgradeTo = PLAN_ORDER.filter((id) => planRank(id) > currentRank)
    .map((id) => planSummary(id))
    .filter(Boolean);
  const canUpgrade = upgradeTo.length > 0;

  // A shop on a trial is not yet paying for anything, so its first paid plan is
  // an activation rather than an upgrade, whatever tier it picks.
  const kind = onTrial ? 'activate' : 'renew';

  // Enterprise is priced by conversation, so there is nothing for the shop to
  // request and nothing for the tab to pretend it can do.
  const canRequest = !plan.uncapped
    && store.status !== STORE_STATUS.PENDING
    && !pendingRequest;

  return {
    plan,
    status: store.status,
    onTrial,
    trialEnded,
    trialEndsAt: store.trialEndsAt || null,
    trialDaysLeft: daysLeft,
    suspended,
    suspensionReason: store.suspensionReason || null,
    activatedAt: store.activatedAt || null,
    planMonths: store.planMonths || 0,
    // What the shop may ask for next, named before it is clicked.
    nextAction: onTrial ? 'activate' : 'renew',
    canRequest,
    // Set when something is already waiting, so a shop cannot pile requests up
    // and the platform does not have to pick which one to honour.
    requestBlockedReason: pendingRequest
      ? 'A plan change is already waiting to be confirmed.'
      : plan.uncapped
        ? 'Enterprise is arranged by talking to us.'
        : store.status === STORE_STATUS.PENDING
          ? 'Activate the shop first.'
          : null,
    upgradeTo,
    canUpgrade,
    // Renewal is the same tier again; only offered when a month count is set.
    canRenew: !plan.uncapped && Number(store.planMonths || 0) > 0,
    pendingRequest: pendingRequest || null,
    plans: PLAN_ORDER.map((id) => planSummary(id)).filter(Boolean),
  };
}

/**
 * Check a plan request before anything is recorded.
 *
 * Refuses rather than corrects. Silently putting a shop on a different plan to
 * the one it asked for is how a customer discovers they are paying for
 * Enterprise when they meant Professional.
 */
function validateRequest(store, requested) {
  if (!store) throw new SubscriptionError('Store not found', 'not_found', 404);
  const plan = String((requested && requested.plan) || '');
  if (!isKnownPlan(plan)) throw new SubscriptionError('Choose a plan from the list', 'unknown_plan');

  const months = requested && requested.months !== undefined
    ? Number(requested.months)
    : 12;
  if (!Number.isFinite(months) || months < 1 || months > 36) {
    throw new SubscriptionError('Choose between 1 and 36 months', 'bad_months');
  }

  const current = planSummary(store.plan) || planSummary('starter');
  if (current.uncapped) {
    throw new SubscriptionError('Enterprise is arranged by talking to us', 'enterprise_by_conversation');
  }

  // A downgrade is refused here rather than queued. The shop is above the new
  // limits right now, and taking effect later would break it in the meantime.
  const targetRank = planRank(plan);
  const currentRank = planRank(store.plan);
  if (targetRank < currentRank) {
    throw new SubscriptionError(
      `You are on ${current.name}. Moving down is not available from here, because your shop is using more than ${current.name} allows.`,
      'downgrade_not_self_service',
    );
  }

  const target = planSummary(plan);
  if (target.uncapped) {
    throw new SubscriptionError('Enterprise is arranged by talking to us', 'enterprise_by_conversation');
  }

  const renewing = plan === store.plan;
  return {
    plan,
    months: Math.floor(months),
    // Recorded on the request so the platform can see at a glance whether it is
    // a new plan or the same one bought again.
    change: store.onTrial && store.trialEndsAt ? 'activate' : renewing ? 'renew' : 'upgrade',
    fromPlan: store.plan,
    amountTHB: target.priceTHB * Math.floor(months),
  };
}

module.exports = {
  subscriptionFor, validateRequest, planSummary, isKnownPlan, planRank,
  PLAN_ORDER, SubscriptionError,
};