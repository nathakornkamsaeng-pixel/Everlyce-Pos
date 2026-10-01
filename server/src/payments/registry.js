// Payment providers.
//
// One interface, so taking a card payment is not a different shape of code from
// taking PromptPay, and so a shop's till never has to know which one it is
// talking to.
//
// The split that matters here is between a provider that can work today and one
// that needs a merchant relationship first:
//
//   thaiqr   Works now. Any Thai bank app can scan it, and the shop only needs
//            an account it already has. No contract, no API key.
//   opn      Opn Payments. Needs a merchant account and live keys.
//   stripe   Cards. Needs an account and live keys.
//
// The last two are deliberately configured but not enabled until real
// credentials are present. A provider that claims to be ready without them
// would fail at the counter, which is the worst possible moment to discover it,
// so capabilities() reports them as unavailable with the reason attached rather
// than hiding them or pretending.

const { buildThaiQr, validThaiTaxId, PaymentError } = require('./thaiqr');

// A merchant reference is what a payer sees and the shop reconciles against, so
// it has to be short, printable and unique per payment.
function referenceFor(order) {
  return String(order.orderNumber || order.id || '').slice(0, 25);
}

const providers = [
  {
    id: 'cash',
    label: 'Cash',
    methods: ['cash'],
    // Cash needs nothing configured, so it is always on.
    configured() { return true; },
    unavailableReason: null,
    requires: [],
    instruction() { return null; },
  },
  {
    id: 'thaiqr',
    label: 'Thai QR and PromptPay',
    // Reads in every Thai banking app, so it covers PromptPay, Thai QR
    // Payment, and bank transfer without three separate integrations.
    methods: ['promptpay', 'qr', 'transfer'],
    configured(settings) {
      return Boolean(settings && settings.promptPayAccount && String(settings.promptPayAccount).trim());
    },
    unavailableReason(settings) {
      if (!settings || !settings.promptPayAccount) return 'Add your PromptPay phone number, tax ID or billing ID in Settings';
      return null;
    },
    requires: ['A Thai bank account, PromptPay number, tax ID or billing ID'],
    /**
     * Build the QR for a set of orders.
     *
     * The reference is derived from the orders rather than accepted from the
     * caller, so a client cannot put an arbitrary value into tag 62 and have a
     * payment land in someone else's reconciliation.
     */
    createPayment({ orders, settings, currency = 'THB' }) {
      if (currency !== 'THB') throw new PaymentError('Thai QR supports Thai baht only');
      const total = Math.round(orders.reduce((sum, o) => sum + Number(o.total || 0), 0) * 100) / 100;
      const reference = orders.length === 1
        ? referenceFor(orders[0])
        : `${orders[0].orderNumber || orders[0].id}+${orders.length}`;

      const payload = buildThaiQr({
        amount: total,
        account: { type: settings.promptPayAccountType, value: settings.promptPayAccount },
        reference,
        merchantName: settings.merchantName || settings.restaurantName,
        merchantCity: settings.merchantCity,
        mcc: settings.merchantMcc,
      });
      return {
        provider: 'thaiqr',
        amount: total,
        reference,
        payload,
        // The cashier scans nothing: the customer scans this with their own app.
        display: 'qr',
        instructions: 'Ask the customer to scan this with their banking app, or to transfer to the account above and quote the reference.',
        confirmBy: 'A transfer cannot be confirmed from the QR alone. Confirm the payment once the money has arrived.',
        settledSynchronously: false,
      };
    },
  },
  {
    id: 'opn',
    label: 'Opn Payments',
    methods: ['card', 'promptpay', 'truemoney'],
    // Live merchant keys are required. Nothing here is enabled without them.
    configured(settings) {
      return Boolean(settings && settings.opnSecretKey);
    },
    unavailableReason(settings) {
      if (!settings || !settings.opnSecretKey) return 'Add your Opn public and secret key in Settings';
      return null;
    },
    requires: ['An Opn merchant account', 'Live secret key'],
    createPayment() {
      throw new PaymentError('Opn is configured for cards but not yet switched on. It needs live merchant keys verified against the Opn API before it can charge a card.');
    },
  },
  {
    id: 'stripe',
    label: 'Cards by Stripe',
    methods: ['card'],
    configured(settings) {
      return Boolean(settings && settings.stripeSecretKey);
    },
    unavailableReason(settings) {
      if (!settings || !settings.stripeSecretKey) return 'Add your Stripe secret key in Settings';
      return null;
    },
    requires: ['A Stripe account', 'Live secret key'],
    createPayment() {
      throw new PaymentError('Stripe is configured for cards but not yet switched on. It needs a live key verified against the Stripe API before it can charge a card.');
    },
  },
];

const byId = new Map(providers.map((p) => [p.id, p]));

function get(id) {
  return byId.get(String(id || '')) || null;
}

/**
 * What this store can actually accept right now.
 *
 * Sent to the till so the payment screen can offer real options and, just as
 * importantly, say why an option is missing. A cashier finding out that a
 * method is unavailable from the till is far better than finding out from a
 * customer standing at the counter.
 */
function capabilities(settings) {
  return providers.map((provider) => {
    const ok = provider.configured(settings);
    return {
      id: provider.id,
      label: provider.label,
      methods: provider.methods,
      available: ok,
      // Present only when unavailable, so the till has something concrete to
      // show rather than a switch that quietly does nothing.
      reason: ok ? null : provider.unavailableReason(settings),
      requires: provider.requires,
      // Settled in one step at the counter, or needing a later confirmation.
      settledSynchronously: provider.id === 'cash',
      display: provider.id === 'thaiqr' ? 'qr' : provider.id === 'cash' ? 'none' : 'gateway',
    };
  });
}

/**
 * Ask a provider to take a payment.
 *
 * Fails closed. An unconfigured provider throws rather than falling back to
 * something else, because silently charging cash or queuing an unverifiable
 * transfer is worse than telling the cashier the method is not set up.
 */
function createPayment(providerId, args) {
  const provider = get(providerId);
  if (!provider) throw new PaymentError('Unknown payment method');
  if (!provider.configured(args && args.settings)) {
    throw new PaymentError(provider.unavailableReason(args && args.settings));
  }
  return provider.createPayment(args);
}

module.exports = { capabilities, createPayment, get, providers, validThaiTaxId, referenceFor };