const { PLANS, contactEmail } = require('./db');

// Hosted billing caps. A self-hosted install is not sold by the plan, so the
// caps are not applied while POS_SELF_HOST is on. They stay in this file
// because a process started with the flag off (the hosted paths the tests
// still exercise) does enforce them.
function selfHost() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.POS_SELF_HOST || '').toLowerCase());
}

// A plan can cap what a store may hold. Enterprise has no caps, which is
// represented by a 0/undefined limit rather than a huge number.
function planLimit(req, key) {
  if (selfHost()) return null;
  if (!req || !req.store) return null;
  const plan = PLANS[req.store.plan];
  if (!plan) return null;
  const value = Number(plan[key]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

function planFor(req) {
  if (!req || !req.store) return null;
  return PLANS[req.store.plan] || PLANS.starter;
}

// Returns an Express error response when a store is at its limit, else null.
function rejectIfOverLimit(req, res, key, currentCount) {
  if (selfHost()) return null;
  const limit = planLimit(req, key);
  if (limit == null || currentCount < limit) return null;
  const label = key === 'maxUsers' ? 'staff accounts' : 'menu items';
  return res.status(402).json({
    detail: `Your plan allows up to ${limit} ${label}. Contact ${contactEmail()} to upgrade.`,
    code: 'plan_limit',
    limit: key,
    value: limit,
  });
}

module.exports = { planLimit, planFor, rejectIfOverLimit, selfHost };
