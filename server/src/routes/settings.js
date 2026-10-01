const express = require('express');
const { coll, touch } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const { log, EVENTS } = require('../activityLog');

const router = express.Router();
router.use(requireAuth);

function rate(value) {
  const number = Number(String(value).replace('%', '').trim());
  return Number.isFinite(number) && number >= 0 && number <= 1000;
}

function nonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

// Anything that can move money or authorise a charge is replaced with a
// yes/no before the settings leave the server.
//
// Not only for cashiers. An admin has just typed these values, so they are the
// person least likely to be trusted with a copy of them: the browser would echo
// them into a form, a screen share, a support screenshot or a bug report. The
// only question anyone actually needs answered is whether a key is set, and
// changing one is a matter of typing the new one over the old.
const SECRET_FIELDS = ['promptPayAccount', 'opnPublicKey', 'opnSecretKey', 'stripeSecretKey', 'stripePublishableKey'];

function redactSettings(settings) {
  const out = { ...settings };
  for (const field of SECRET_FIELDS) {
    // Unconditional, not "only if present". A store persisted before these
    // settings existed has the field as undefined rather than as an empty
    // string, so a presence check made the flag disappear for exactly the shops
    // that had never configured anything, which is the one case where the
    // cashier most needs to be told.
    out[`${field}Configured`] = Boolean(String(out[field] || '').trim());
    delete out[field];
  }
  return out;
}

router.get('/', (req, res) => {
  const settings = redactSettings(coll('settings'));
  if (req.user.role !== 'admin') {
    delete settings.promptPayAccountType;
    // A cashier can be told a payment method is set up without being told the
    // account it pays into.
    for (const field of SECRET_FIELDS) delete settings[`${field}Configured`];
    settings.promptPayConfigured = Boolean(coll('settings').promptPayAccount);
  }
  // Enough for the UI to explain the shop and its plan without a second call.
  settings.store = req.store
    ? { slug: req.store.slug, name: req.store.name, plan: req.store.plan, planMonths: req.store.planMonths || 0, activatedAt: req.store.activatedAt }
    : null;
  // A Thai tax invoice is only complete when the seller is identified.
  settings.taxInvoiceReady = Boolean(settings.legalName && settings.taxId);
  res.json(settings);
});

router.put('/cds-language', requireRole('admin', 'cashier'), (req, res) => {
  const language = req.body && req.body.language === 'en' ? 'en' : 'th';
  coll('settings').cdsLanguage = language;
  log(EVENTS.SETTINGS_SAVE, req, { cdsLanguage: language });
  touch();
  res.json({ cdsLanguage: language });
});

router.put('/', requireRole('admin'), (req, res) => {
  const settings = coll('settings');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.restaurantName !== undefined) settings.restaurantName = String(body.restaurantName).trim().slice(0, 200);
  if (body.legalName !== undefined) settings.legalName = String(body.legalName).trim().slice(0, 200);
  if (body.taxId !== undefined) {
    const value = String(body.taxId).replace(/[^0-9-]/g, '');
    settings.taxId = value.length <= 20 ? value : settings.taxId;
  }
  if (body.privacyContactEmail !== undefined) {
    const value = String(body.privacyContactEmail).trim().toLowerCase();
    if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return res.status(400).json({ detail: 'That does not look like a valid email address' });
    }
    settings.privacyContactEmail = value;
  }
  if (body.personalDataRetentionDays !== undefined) {
    const value = Number(body.personalDataRetentionDays);
    if (!Number.isFinite(value) || value < 0 || value > 3650) {
      return res.status(400).json({ detail: 'Retention must be between 0 and 3650 days, or 0 to keep until asked' });
    }
    settings.personalDataRetentionDays = Math.floor(value);
  }
  if (body.taxRate !== undefined) { if (!rate(body.taxRate)) return res.status(400).json({ detail: 'Invalid tax rate' }); settings.taxRate = String(Number(String(body.taxRate).replace('%', '').trim())); }
  if (body.serviceChargeRate !== undefined) { if (!rate(body.serviceChargeRate)) return res.status(400).json({ detail: 'Invalid service charge rate' }); settings.serviceChargeRate = String(Number(String(body.serviceChargeRate).replace('%', '').trim())); }
  if (body.currency !== undefined) settings.currency = String(body.currency).trim().slice(0, 10);
  if (body.customerLanguage !== undefined) settings.customerLanguage = body.customerLanguage === 'en' ? 'en' : 'th';
  if (body.promptPayAccount !== undefined) settings.promptPayAccount = String(body.promptPayAccount).trim().slice(0, 50);
  if (body.promptPayAccountType !== undefined) settings.promptPayAccountType = ['phone', 'taxid', 'id'].includes(body.promptPayAccountType) ? body.promptPayAccountType : 'phone';
  // Merchant identity, read by the payer and used for reconciliation.
  if (body.merchantName !== undefined) settings.merchantName = String(body.merchantName).trim().slice(0, 25);
  if (body.merchantCity !== undefined) settings.merchantCity = String(body.merchantCity).trim().slice(0, 15);
  if (body.merchantMcc !== undefined) {
    const value = String(body.merchantMcc).replace(/[^0-9]/g, '');
    settings.merchantMcc = value.length === 4 ? value : '';
  }
  // Gateway credentials. An empty string is how a key is cleared, and a key is
  // never accepted from the request unless it is actually present, so a form
  // round trip that never had the key in it cannot blank what is stored.
  for (const field of ['opnPublicKey', 'opnSecretKey', 'stripeSecretKey', 'stripePublishableKey']) {
    if (body[field] === undefined) continue;
    const value = String(body[field]).trim();
    if (!value) { settings[field] = ''; continue; }
    if (value.length > 200) return res.status(400).json({ detail: 'That looks too long to be a credential' });
    settings[field] = value;
  }
  if (body.kdsOverdueMinutes !== undefined) { const value = nonNegative(body.kdsOverdueMinutes); if (value === null || value < 1) return res.status(400).json({ detail: 'Invalid KDS overdue minutes' }); settings.kdsOverdueMinutes = value; }
  if (body.loyaltyEnabled !== undefined) settings.loyaltyEnabled = Boolean(body.loyaltyEnabled);
  if (body.loyaltyPrompt !== undefined) settings.loyaltyPrompt = ['always', 'optional', 'never'].includes(body.loyaltyPrompt) ? body.loyaltyPrompt : 'always';
  const numeric = { draftEmptyMinutes: 1440, draftStaleMinutes: 10080, loginLockAttempts: 100, loginLockWindowMinutes: 1440, loginLockBlockMinutes: 1440, loginLockMaxHours: 24, loyaltyPointsPerUnit: 1000000, loyaltyPointValue: 1000000, loyaltyMinRedeemPoints: 100000000, loyaltyMaxCoupons: 100, loyaltyTierGold: 100000000, loyaltyTierVip: 100000000 };
  for (const [key, maximum] of Object.entries(numeric)) {
    if (body[key] !== undefined) { const value = nonNegative(body[key]); if (value === null || value > maximum) return res.status(400).json({ detail: `Invalid ${key}` }); settings[key] = value; }
  }
  for (const key of ['loginLockAttempts', 'loginLockWindowMinutes', 'loginLockBlockMinutes', 'loginLockMaxHours']) {
    if (Number(settings[key]) < 1) return res.status(400).json({ detail: `Invalid ${key}` });
  }
  if (Number(settings.loginLockMaxHours) * 60 < Number(settings.loginLockBlockMinutes)) return res.status(400).json({ detail: 'Maximum lock time must be at least the initial lock time' });
  for (const key of ['loyaltyRequirePhone', 'loyaltyAutoRegister', 'loyaltyAllowSkip', 'loyaltyAllowStacking']) if (body[key] !== undefined) settings[key] = Boolean(body[key]);
  log(EVENTS.SETTINGS_SAVE, req, {});
  touch();
  const saved = redactSettings(settings);
  saved.taxInvoiceReady = Boolean(saved.legalName && saved.taxId);
  res.json(saved);
});

module.exports = router;
