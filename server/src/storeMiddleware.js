const express = require('express');
const { runWithStore, currentStore } = require('./storeContext');
const {
  findStoreBySlug, storeList, eachStore, coll, storeIsActive, DEFAULT_STORE_SLUG,
  contactEmail, lineOpenChatUrl, PLANS, TRIAL_DAYS,
} = require('./db');

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

// A self-hosted install runs one shop and has nobody to send a key to, so
// registration and the activation gate are switched off entirely.
const SELF_HOST = String(process.env.POS_SELF_HOST || '').toLowerCase() === '1'
  || ['true', 'yes', 'on'].includes(String(process.env.POS_SELF_HOST || '').toLowerCase());

function isSelfHost() {
  return SELF_HOST;
}

// A store is treated as live when it is active, or when this install is
// self-hosted and the store is the only one.
function storeUsable(store) {
  if (storeIsActive(store)) return true;
  if (!SELF_HOST || !store) return false;
  return storeList().length === 1;
}

function headerSlug(req) {
  const raw = req.headers['x-pos-store'] || req.headers['x-store-slug'] || '';
  const value = Array.isArray(raw) ? raw[0] : raw;
  return String(value || '').trim().toLowerCase();
}

function bodyOrQuerySlug(req) {
  const value = (req.body && typeof req.body === 'object' && req.body.store) || req.query.store || '';
  return String(value || '').trim().toLowerCase();
}

// The browser sends the store on every call. A path prefix is the fallback for
// anyone hitting `/your-store/...` directly through the API.
function pathSlug(req) {
  const match = String(req.originalUrl || req.url || '').match(/^\/stores\/([a-z0-9-]{2,40})(?:\/|$|\?)/i);
  return match ? match[1].toLowerCase() : '';
}

function tokenFromRequest(req) {
  const query = String(req.query.token || '');
  if (query) return query;
  const body = req.body && typeof req.body === 'object' ? req.body.token : '';
  return body ? String(body) : '';
}

// Old customer links carry only a QR token. The token is unique per table, so
// the store can be recovered by looking it up instead of guessing a default.
function storeForToken(token) {
  const wanted = String(token || '');
  if (!wanted) return null;
  for (const store of storeList()) {
    const found = runWithStore(store, () => coll('sessions').some((session) => session.token && session.token === wanted));
    if (found) return store;
  }
  return null;
}

function storeForReceiptToken(token) {
  const wanted = String(token || '');
  if (!wanted) return null;
  for (const store of storeList()) {
    const found = runWithStore(store, () => coll('orders').some((order) => order.receiptToken && order.receiptToken === wanted));
    if (found) return store;
  }
  return null;
}

function resolve(req) {
  const explicit = headerSlug(req) || pathSlug(req) || bodyOrQuerySlug(req);
  if (explicit) {
    if (!SLUG_RE.test(explicit)) return { error: 'invalid_slug' };
    const store = findStoreBySlug(explicit);
    if (!store) return { error: 'unknown_store' };
    return { store };
  }
  const token = tokenFromRequest(req);
  if (token) {
    const bySession = storeForToken(token);
    if (bySession) return { store: bySession };
    const byReceipt = storeForReceiptToken(token);
    if (byReceipt) return { store: byReceipt };
  }
  return { store: null };
}

// Everything under /api except /api/platform and /api/health runs inside a
// store. A missing store is an error, never a silent fall back to shop one.
function storeContext() {
  return (req, res, next) => {
    const { store, error } = resolve(req);
    if (error === 'invalid_slug') return res.status(400).json({ detail: 'Invalid store URL' });
    if (error === 'unknown_store') return res.status(404).json({ detail: 'Store not found' });
    if (!store) {
      return res.status(400).json({ detail: 'Store not specified', code: 'store_required' });
    }
    req.store = store;
    req.storeSlug = store.slug;
    runWithStore(store, () => next());
  };
}

// Endpoints an unactivated store may still reach. Sign-in and activation have
// to work before a key exists; everything that touches real shop data does not.
const PRE_ACTIVATION_PATHS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/me',
  '/auth/language',
  '/auth/reauth',
  '/branches',
]);

function requireActiveStore(req, res, next) {
  if (!req.store) return res.status(400).json({ detail: 'Store not specified' });
  if (storeUsable(req.store)) return next();
  if (SELF_HOST) {
    return res.status(403).json({
      detail: 'This install is running in single-store self-hosted mode.',
      code: 'self_host_single_store',
    });
  }
  if (PRE_ACTIVATION_PATHS.has(req.path)) return next();

  const suspended = req.store.status === 'suspended';
  return res.status(403).json({
    detail: suspended
      ? `This store is suspended. Please contact ${contactEmail()}.`
      : `Your store is not active yet. Please contact ${contactEmail()} to get your activation key.`,
    code: suspended ? 'store_suspended' : 'store_not_active',
    status: req.store.status,
    contactEmail: contactEmail(),
    // Lets the app show the activation screen rather than a bare error.
    activationRequired: !suspended,
    store: { slug: req.store.slug, name: req.store.name, status: req.store.status },
  });
}

function currentStoreOrThrow() {
  const store = currentStore();
  if (!store) throw new Error('No store in context');
  return store;
}

// Scans every store. Only used by platform-level endpoints.
function acrossStores(fn) {
  return eachStore(fn);
}

function publicStoreInfo(req) {
  const store = req.store;
  if (!store) return null;
  // The countdown is public because the shop standing at the activation
  // screen is the person who needs to know how long they have, and it is not
  // sensitive: it is the same deadline the server enforces.
  const { trialDaysLeft } = require('./trial');
  return {
    slug: store.slug,
    name: store.name,
    status: store.status,
    plan: store.plan,
    onTrial: Boolean(store.onTrial && store.trialEndsAt),
    trialDaysLeft: store.status === 'suspended' && store.suspensionReason === 'trial_expired'
      ? 0
      : trialDaysLeft(store),
    trialEnded: store.status === 'suspended' && store.suspensionReason === 'trial_expired',
  };
}

// The bits a signed-out visitor needs in order to get a key: who to email, and
// where to message us. Nothing here is sensitive.
function publicConfig() {
  return {
    contactEmail: contactEmail(),
    lineOpenChatUrl: lineOpenChatUrl(),
    // Both are hard facts about the install rather than marketing copy, and the
    // page reads them instead of remembering them: a page that invites people to
    // register on an install where registration is switched off is worse than
    // saying nothing at all.
    trialDays: 0,
    registrationOpen: false,
    // Whether this install has no shop yet and is waiting to be set up. The
    // public page needs it to decide which half of the entry panel to show, and
    // it is the only honest signal available: registrationOpen is false on every
    // self-hosted install whether or not it has been set up, so the page cannot
    // tell "nothing here yet" from "already running" without it.
    setupRequired: isSelfHost() && storeList().length === 0,
    // No plan list. This build has no billing: the plans table in db.js still
    // exists because it carries the limits every shop runs under, but publishing
    // priceTHB to a browser on an install that cannot charge anybody would be a
    // number on screen that means nothing.
  };
}

module.exports = {
  storeContext, requireActiveStore, currentStoreOrThrow, acrossStores,
  publicStoreInfo, publicConfig, storeForToken, storeForReceiptToken, resolve, headerSlug,
  isSelfHost, storeUsable, DEFAULT_STORE_SLUG,
};
