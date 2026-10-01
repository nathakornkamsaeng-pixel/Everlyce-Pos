const express = require('express');
const { coll } = require('../db');
const { requireAuth, requireRole } = require('../middleware');
const registry = require('../payments/registry');
const { PaymentError } = require('../payments/thaiqr');

const router = express.Router();
router.use(requireAuth);

/**
 * What this shop can accept right now, and why not.
 *
 * The till asks before drawing the payment screen, so a cashier sees a real
 * answer rather than a method that turns out to be unconfigured once the
 * customer has their card out.
 */
router.get('/capabilities', (req, res) => {
  const settings = coll('settings') || {};
  const providers = registry.capabilities(settings);
  // Cashiers get the same list without the account-level detail.
  const safe = req.user.role === 'admin'
    ? providers
    : providers.map((p) => ({ ...p, requires: undefined }));
  res.json({ currency: settings.currency || 'THB', providers: safe });
});

module.exports = router;
module.exports.PaymentError = PaymentError;
module.exports.requireRole = requireRole;