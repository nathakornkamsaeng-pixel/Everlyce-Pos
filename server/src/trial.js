// Ending free trials.
//
// A trial that is never enforced is not a trial, it is a free shop. So the
// clock is swept rather than checked on request: a shop whose week is up is
// paused whether anyone looks at it or not, and the data is kept so paying
// brings it straight back.
//
// What is paused, and what is not:
//
//   never activated, trial over   paused. Nothing was set up, nothing is lost.
//   activated on the trial, over   paused. They used the week, as intended.
//   activated with a paid key      untouched. trialEndsAt is cleared on a paid
//                                  activation precisely so this cannot happen.
//   self-hosted                    untouched. There is nobody to charge.
//
// "Paused" is not "deleted": the store, its menu, its orders and its customers
// are all still there, and a paid activation makes it active again.
'use strict';

const { storeList, findStoreById, touch, now, STORE_STATUS } = require('./db');
const { log, EVENTS } = require('./activityLog');

const SELF_HOST = ['1', 'true', 'yes', 'on']
  .includes(String(process.env.POS_SELF_HOST || '').toLowerCase());

// A store still inside its trial, and therefore still allowed to self-activate.
function trialLive(store) {
  if (SELF_HOST) return false;
  if (!store || !store.trialEndsAt) return false;
  const left = new Date(store.trialEndsAt).getTime() - Date.now();
  return Number.isFinite(left) && left > 0;
}

function trialExpired(store) {
  if (SELF_HOST) return false;
  if (!store || !store.trialEndsAt) return false;
  return new Date(store.trialEndsAt).getTime() <= Date.now();
}

function trialDaysLeft(store) {
  if (SELF_HOST || !store || !store.trialEndsAt) return null;
  const left = new Date(store.trialEndsAt).getTime() - Date.now();
  if (!Number.isFinite(left)) return null;
  return Math.max(0, Math.ceil(left / 86400000));
}

// Pauses every store whose trial has run out. Returns how many were paused.
function expireTrials() {
  // Self-hosted installs are never on a trial, and there is nobody to charge
  // them. The header comment above promises "self-hosted: untouched", and this is
  // where that promise is kept: without this guard a single shop that still had
  // onTrial set from an earlier hosted install would be suspended at the next
  // hourly sweep, with nobody expecting it and no way to reverse it but a manual
  // resume. The trial functions all return false under the flag, so this one had
  // been the only place that could still act.
  if (SELF_HOST) return 0;
  const nowMs = Date.now();
  let paused = 0;
  for (const candidate of storeList()) {
    // Only a shop that is explicitly on a trial. Checking the deadline alone
    // was the wrong test: a paying shop with a stale deadline left over from
    // before its upgrade would be suspended, which takes a paying customer out
    // of service. Failing to pause is recoverable; that is not.
    if (!candidate.onTrial) continue;
    if (!candidate.trialEndsAt) continue;
    if (new Date(candidate.trialEndsAt).getTime() > nowMs) continue;
    if (candidate.suspensionReason === 'trial_expired') continue;
    // A store that is already suspended for another reason keeps that reason,
    // so a manual suspension is not overwritten with "trial expired".
    if (candidate.status === STORE_STATUS.SUSPENDED && candidate.suspensionReason) continue;

    // Re-read by id and mutate in place, then touch.
    //
    // Not transaction(): transaction deep-copies the document and swaps it in,
    // so a store taken from the list before the call is a reference to the copy
    // the rollback restores from. Mutating it writes to an object that is then
    // thrown away, and the sweep reports "paused 1 store" every hour while
    // pausing nothing at all.
    const store = findStoreById(candidate.id);
    if (!store) continue;
    const wasActive = store.status === STORE_STATUS.ACTIVE;
    store.status = STORE_STATUS.SUSPENDED;
    store.suspendedAt = now();
    store.suspensionReason = 'trial_expired';
    touch();
    paused += 1;
    log(EVENTS.STORE_TRIAL_EXPIRED, { user: null }, {
      store: store.slug,
      wasActive,
      trialEndedAt: store.trialEndsAt,
    });
  }
  return paused;
}

module.exports = { expireTrials, trialLive, trialExpired, trialDaysLeft, SELF_HOST };
