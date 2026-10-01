// Thai QR payloads and the payment provider registry.
//
// The QR is the one payment integration that needs nothing from a third party,
// so it is also the one that has to be right: a malformed payload is not a
// caught exception at the counter, it is a customer whose app refuses to pay.

const { isolatedData } = require('./helpers/isolated-data');
process.env.POS_DATA_DIR = isolatedData();

const assert = require('assert');
const { buildThaiQr, readThaiQr, crc16, tlv, validThaiTaxId, PaymentError } = require('../src/payments/thaiqr');
const registry = require('../src/payments/registry');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  }
}
function throws(label, fn) {
  try { fn(); fail += 1; console.log(`  FAIL ${label} -> did not throw`); } catch (e) { pass += 1; console.log(`  ok   ${label}`); }
}

const ACCOUNT = { type: 'phone', value: '0812345678' };
const settings = {
  promptPayAccount: '0812345678',
  promptPayAccountType: 'phone',
  merchantName: 'Bangkok Coffee',
  merchantCity: 'Bangkok',
};

console.log('\n== the checksum EMVCo specifies ==');
ok('CRC of a known string matches the published value',
  crc16('123456789') === '29B1', crc16('123456789'));
ok('TLV pads the length to two digits', tlv('54', '12.50') === '540512.50', tlv('54', '12.50'));
ok('TLV refuses a value over 99 characters, rather than writing a wrong length',
  (() => { try { tlv('62', 'x'.repeat(100)); return false; } catch (e) { return e instanceof PaymentError; } })());
throws('a field over 99 characters is refused', () => tlv('62', 'x'.repeat(100)));

console.log('\n== a payload a Thai banking app can read ==');
const payload = buildThaiQr({ amount: 1250, account: ACCOUNT, reference: 'A-001', ...settings ? { merchantName: settings.merchantName, merchantCity: settings.merchantCity } : {} });
const read = readThaiQr(payload);
ok('the checksum verifies', read.checksumValid, { stated: read.statedChecksum });
ok('it is the PromptPay scheme', read.merchantAccountScheme === 'A000000677010111', read.merchantAccountScheme);
ok('the account is tag 01, a phone number', read.merchantAccountSubtag === '01', read.merchantAccountSubtag);
ok('carrying the number in international form', read.merchantAccountValue === '0066812345678', read.merchantAccountValue);
ok('the currency is Thai baht', read.tags['53'] === '764', read.tags['53']);
ok('the amount is two decimal places', read.tags['54'] === '1250.00', read.tags['54']);
ok('the country is Thailand', read.tags['58'] === 'TH', read.tags['58']);
ok('it is dynamic, because one is made per order', read.tags['01'] === '12', read.tags['01']);
ok('the CRC is in tag 63', payload.includes('6304'), payload.slice(-12));

console.log('\n== tag 62, the reference, which is what the old code left out ==');
ok('the reference is present', read.tags['62'] === 'A-001', read.tags['62']);
ok('without it the payload still builds, it just cannot be reconciled', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT })).tags['62'] === undefined);
ok('the merchant name is carried', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT, merchantName: 'Bangkok Coffee' })).tags['59'] === 'Bangkok Coffee');
ok('and the city', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT, merchantCity: 'Bangkok' })).tags['60'] === 'Bangkok');
ok('the reference is capped at 25, the field limit', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT, reference: 'R'.repeat(60) })).tags['62'].length === 25);
ok('a long merchant name is capped rather than corrupting the payload', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT, merchantName: 'N'.repeat(60) })).tags['59'].length === 25);

console.log('\n== the three kinds of PromptPay account ==');
ok('a tax ID is validated and carried as tag 02', (() => {
  const r = readThaiQr(buildThaiQr({ amount: 100, account: { type: 'taxid', value: '0105548000151' } }));
  return r.merchantAccountSubtag === '02' && r.merchantAccountValue === '0105548000151';
})());
ok('a 13 digit ID is treated as a tax ID', readThaiQr(buildThaiQr({ amount: 100, account: { type: 'id', value: '0105548000151' } })).merchantAccountSubtag === '02');
ok('a 15 digit ID is a billing identifier, tag 03', readThaiQr(buildThaiQr({ amount: 100, account: { type: 'id', value: '123456789012345' } })).merchantAccountSubtag === '03');
ok('a leading 0 on a phone number is stripped, not doubled into the country code', readThaiQr(buildThaiQr({ amount: 100, account: { type: 'phone', value: '0812345678' } })).merchantAccountValue === '0066812345678');
ok('a 66 prefix is stripped too', readThaiQr(buildThaiQr({ amount: 100, account: { type: 'phone', value: '66812345678' } })).merchantAccountValue === '0066812345678');
ok('the international form is 13 characters, country code plus nine digits', readThaiQr(buildThaiQr({ amount: 100, account: { type: 'phone', value: '0812345678' } })).merchantAccountValue.length === 13);
throws('a bad tax ID is refused, not silently encoded', () => buildThaiQr({ amount: 100, account: { type: 'taxid', value: '0105548000152' } }));
throws('a phone number of the wrong length is refused', () => buildThaiQr({ amount: 100, account: { type: 'phone', value: '0812345' } }));
throws('an account type nobody recognises is refused', () => buildThaiQr({ amount: 100, account: { type: 'nope', value: '0812345678' } }));
throws('no account at all is refused', () => buildThaiQr({ amount: 100, account: { type: 'phone', value: '' } }));

console.log('\n== the Thai tax ID checksum ==');
ok('a valid tax ID passes', validThaiTaxId('0105548000151') === true);
ok('the check digit is the one the algorithm computes, not a guess',
  validThaiTaxId('0105548000151') === true && validThaiTaxId('0105548000150') === false);
ok('one digit wrong fails', validThaiTaxId('0105548000152') === false);
ok('the wrong length fails', validThaiTaxId('010554800015') === false);
ok('non-digits are stripped first', validThaiTaxId('010-554-800-015-1') === true);
ok('an empty value fails', validThaiTaxId('') === false);

console.log('\n== amounts that cannot be paid ==');
throws('zero is refused', () => buildThaiQr({ amount: 0, account: ACCOUNT }));
throws('a negative amount is refused', () => buildThaiQr({ amount: -5, account: ACCOUNT }));
throws('an amount above the QR maximum is refused', () => buildThaiQr({ amount: 99999999999, account: ACCOUNT }));
throws('an amount that is not a number is refused', () => buildThaiQr({ amount: 'free', account: ACCOUNT }));
ok('a rounding amount is written to two places', readThaiQr(buildThaiQr({ amount: 10.005, account: ACCOUNT })).tags['54'] === '10.01', readThaiQr(buildThaiQr({ amount: 10.005, account: ACCOUNT })).tags['54']);

console.log('\n== a static QR, for printing ==');
ok('a printed code declares itself static', readThaiQr(buildThaiQr({ amount: 100, account: ACCOUNT, dynamic: false })).tags['01'] === '11');

console.log('\n== the provider registry ==');
const bare = registry.capabilities({});
ok('cash is always available', bare.find((p) => p.id === 'cash').available === true);
const qrBare = bare.find((p) => p.id === 'thaiqr');
ok('Thai QR is unavailable with no account', qrBare.available === false);
ok('and says exactly what to do about it', /PromptPay/.test(qrBare.reason), qrBare.reason);
ok('the reason is absent when it is available', registry.capabilities(settings).find((p) => p.id === 'thaiqr').reason === null);
ok('Thai QR covers PromptPay, QR and transfer', ['promptpay', 'qr', 'transfer'].every((m) => qrBare.methods.includes(m)), qrBare.methods);
ok('cash settles at the counter', bare.find((p) => p.id === 'cash').settledSynchronously === true);
ok('a transfer does not settle on its own', qrBare.settledSynchronously === false);

console.log('\n== card gateways are configured but not claimed to be ready ==');
for (const id of ['opn', 'stripe']) {
  const p = registry.capabilities({ [id === 'opn' ? 'opnSecretKey' : 'stripeSecretKey']: 'sk_live_x' }).find((x) => x.id === id);
  ok(`${id} reports available once a key is set`, p.available === true, p);
  const off = registry.capabilities({}).find((x) => x.id === id);
  ok(`${id} is unavailable with no key, and says why`, off.available === false && /Settings/.test(off.reason), off.reason);
  // The point of failing closed: a half-built gateway must not quietly take
  // the customer's money.
  throws(`${id} refuses to charge when its transport is not verified`, () => registry.createPayment(id, { orders: [{ id: 1, orderNumber: 'A-1', total: 100 }], settings: { [id === 'opn' ? 'opnSecretKey' : 'stripeSecretKey']: 'sk_live_x' } }));
  ok(`${id} says what it needs`, registry.capabilities({}).find((x) => x.id === id).requires.length > 0);
}

console.log('\n== charging through the registry ==');
const order = { id: 7, orderNumber: 'A-0007', total: 450 };
const charge = registry.createPayment('thaiqr', { orders: [order], settings });
ok('it charges the order total', charge.amount === 450, charge.amount);
ok('the reference comes from the order', charge.reference === 'A-0007', charge.reference);
ok('the payload carries that reference in tag 62', readThaiQr(charge.payload).tags['62'] === 'A-0007', readThaiQr(charge.payload).tags['62']);
ok('it is a QR, not a gateway redirect', charge.display === 'qr', charge.display);
ok('a transfer is not settled synchronously', charge.settledSynchronously === false);
ok('the customer is told how to finish', /scan/i.test(charge.instructions), charge.instructions);

console.log('\n== several orders on one bill ==');
const many = registry.createPayment('thaiqr', { orders: [order, { id: 8, orderNumber: 'A-0008', total: 250 }], settings });
ok('the total is the sum', many.amount === 700, many.amount);
ok('the reference says how many orders are on the bill, not just the first', many.reference === 'A-0007+2', many.reference);
throws('the currency is checked, not assumed', () => registry.createPayment('thaiqr', { orders: [order], settings, currency: 'USD' }));

console.log('\n== the reference cannot be set by the client ==');
// A client that could choose its own tag 62 could send a payment to an account
// and quote a reference belonging to a different shop.
const spoof = registry.createPayment('thaiqr', { orders: [order], settings });
ok('a client cannot supply its own reference', registry.createPayment('thaiqr', { orders: [order], settings, reference: 'SPOOFED' }).reference === order.orderNumber);
ok('and it comes from the order number', spoof.reference === order.orderNumber);

console.log('\n== failing closed ==');
throws('an unknown provider is refused', () => registry.createPayment('bitcoin', { orders: [order], settings }));
throws('Thai QR with no account is refused', () => registry.createPayment('thaiqr', { orders: [order], settings: { promptPayAccount: '' } }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);