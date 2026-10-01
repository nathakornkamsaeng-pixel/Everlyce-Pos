// The public privacy notice.
//
// It has to be readable by someone who has never signed in and has no store
// header, because a customer is entitled to read it before they consent to
// anything. That is why it lives here rather than inside the tenant routes: the
// store is resolved from an optional ?store= and otherwise falls back to the
// default store, so the published notice can never render blank.
//
// A blank notice is worse than none, so if no store can be resolved at all this
// returns null and the caller says so plainly rather than rendering an empty
// document with gaps where the controller's name and contact should be.

const { findStoreBySlug, DEFAULT_STORE_SLUG, storeIsActive, withStore, platformSettings } = require('./db');
const { coll } = require('./db');
const pdpa = require('./pdpa');

// The policy is the platform's; the controller is the shop's.
//
// Split because the two have different owners. The lawful bases, the version and
// the rights text are the same document for every shop, so they are written once
// by whoever runs the platform. The legal name and the contact address are the
// shop's own facts, and it cannot publish a notice that does not name it.
function noticeForStore() {
  const s = coll('settings') || {};
  const shared = (platformSettings() || {}).privacy || {};
  return {
    // The platform's version wins, because it is the platform's document. A shop
    // setting its own would let one shop publish a different policy under the
    // same page.
    version: shared.policyVersion || pdpa.policyVersion(),
    controller: {
      // The site owner, because they operate the service that collects the data.
      // Falls back to the shop only where there is no site owner: a self-hosted
      // install is its own operator and has no platform above it.
      legalName: shared.controllerLegalName || s.legalName || s.restaurantName || '',
      // Same reasoning for the address, and the shop is the last resort rather
      // than the first, so a hosted shop cannot misname its own controller.
      address: shared.controllerAddress || '',
      contactEmail: shared.contactEmail || s.privacyContactEmail || '',
      // Whether the name above came from the platform or the shop, so the notice
      // can be honest and so the console can show which fields are missing.
      controllerIsPlatform: Boolean(shared.controllerLegalName),
    },
    purposes: shared.purposes || pdpa.PURPOSES,
    operatorNotes: shared.operatorNotes || '',
    // Retention is the shop's operational choice: a supermarket keeping a year
    // of customer history has a different answer from a cafe.
    retentionDays: pdpa.retentionDays(),
    retentionIsShopSetting: true,
    rights: [
      { id: 'access', label: 'Ask for a copy of your data' },
      { id: 'correct', label: 'Ask for your data to be corrected' },
      { id: 'erase', label: 'Ask for your data to be deleted' },
      { id: 'withdraw', label: 'Withdraw consent' },
      { id: 'object', label: 'Object to processing' },
    ],
  };
}

// Resolves the store itself so this can be mounted before the tenant
// middleware, which would otherwise reject the request for having no store.
function resolveNotice(requestedSlug) {
  const slug = String(requestedSlug || '').trim().toLowerCase();
  let store = slug ? findStoreBySlug(slug) : null;
  if (!store) store = findStoreBySlug(DEFAULT_STORE_SLUG);
  if (!store) return null;
  // A suspended shop should not be publishing a notice as if it were trading,
  // but its notice must still be readable by the people who gave it data.
  return {
    slug: store.slug,
    active: storeIsActive(store),
    notice: withStore(store, () => noticeForStore()),
  };
}

module.exports = { noticeForStore, resolveNotice };
