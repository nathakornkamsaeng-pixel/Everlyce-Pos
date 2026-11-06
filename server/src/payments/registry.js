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
// Opn and Stripe are not implemented. A saved key does not switch them on:
// capabilities() keeps them unavailable with the reason "not switched on yet",
// and createPayment throws rather than charging. Cash and Thai QR are the
// providers a till can actually use.

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
    // Present so a key can be stored for later. Not a payment the till can take.
    implemented: false,
    configured(settings) {
      return Boolean(settings && settings.opnSecretKey);
    },
    unavailableReason() {
      return 'not switched on yet';
    },
    requires: ['An Opn merchant account', 'Live secret key', 'A charge and webhook that do not exist in this build yet'],
    createPayment() {
      throw new PaymentError('not switched on yet');
    },
  },
  {
    id: 'stripe',
    label: 'Cards by Stripe',
    methods: ['card'],
    implemented: false,
    configured(settings) {
      return Boolean(settings && settings.stripeSecretKey);
    },
    unavailableReason() {
      return 'not switched on yet';
    },
    requires: ['A Stripe account', 'Live secret key', 'A charge and webhook that do not exist in this build yet'],
    createPayment() {
      throw new PaymentError('not switched on yet');
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
    const switchedOn = provider.implemented !== false;
    const keysPresent = provider.configured(settings);
    // A key is not an implementation. Opn and Stripe stay unavailable, with
    // the same reason whether or not a secret has been saved.
    const available = switchedOn && keysPresent;
    return {
      id: provider.id,
      label: provider.label,
      methods: provider.methods,
      available,
      switchedOn,
      // Present only when unavailable, so the till has something concrete to
      // show rather than a switch that quietly does nothing.
      reason: available ? null : provider.unavailableReason(settings),
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
  if (provider.implemented === false) {
    throw new PaymentError('not switched on yet');
  }
  if (!provider.configured(args && args.settings)) {
    throw new PaymentError(provider.unavailableReason(args && args.settings));
  }
  return provider.createPayment(args);
}

module.exports = { capabilities, createPayment, get, providers, validThaiTaxId, referenceFor };