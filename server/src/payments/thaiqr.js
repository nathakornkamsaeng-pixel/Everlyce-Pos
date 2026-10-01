// EMVCo-compatible Thai QR / PromptPay payload.
//
// This is the format every Thai banking app already reads, so it is the one
// integration that needs no merchant relationship with anyone: a shop with a
// bank account or a PromptPay number can take money today, and the payer's app
// treats it as an ordinary bank transfer.
//
// Built here rather than pulled in as a dependency because the payload is a
// few dozen lines of TLV and a checksum, and because the one field that
// matters commercially, tag 62, is exactly the field a generic library leaves
// out. Tag 62 is what makes a payment show up in the payer's statement with
// the shop's reference on it, and without it every reconciliation is a manual
// match on amount and timestamp.
//
// Tag reference, EMVCo QRCPS:
//   00 payload format indicator
//   01 point of initiation method, 11 static / 12 dynamic
//   29 merchant account, PromptPay identifier scheme
//   52 merchant category code
//   53 transaction currency, 764 for Thai baht
//   54 transaction amount
//   58 country code, TH
//   59 merchant name
//   60 merchant city
//   62 additional data, the PromptPay bill number / reference
//   63 CRC, always '04'

const PROMPTPAY_SCHEME = 'A000000677010111';
const CURRENCY_THB = 764;

class PaymentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaymentError';
  }
}

function tlv(id, value) {
  const text = String(value);
  // Two-digit, zero-padded length. EMVCo caps a value at 99 characters.
  if (text.length > 99) throw new PaymentError(`QR field ${id} is too long (${text.length} characters, max 99)`);
  return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

// CRC-16/CCITT-FALSE, the checksum EMVCo specifies for the QR payload.
function crc16(text) {
  let crc = 0xffff;
  for (let i = 0; i < text.length; i += 1) {
    crc ^= text.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// A Thai tax ID is 13 digits with a check digit. Verifying it here means a
// mistyped ID is refused when the QR is built rather than discovered days later
// when a payment cannot be matched back to the shop.
function validThaiTaxId(value) {
  const digits = String(value || '').replace(/[^0-9]/g, '');
  if (digits.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (13 - i);
  return Number(digits[12]) === ((11 - (sum % 11)) % 10);
}

// PromptPay accepts a tax ID, a 13 or 15 digit billing identifier, or a phone
// number. Which one it is decides the sub-tag inside 29.
function accountTarget(type, value) {
  const account = String(value || '').trim();
  if (!account) throw new PaymentError('Configure a PromptPay account in Settings');

  if (type === 'taxid') {
    if (!validThaiTaxId(account)) throw new PaymentError('That tax ID is not a valid 13 digit Thai tax ID');
    return { subtag: '02', value: account.replace(/[^0-9]/g, '') };
  }
  if (type === 'id') {
    const id = account.replace(/[^0-9]/g, '');
    if (id.length !== 13 && id.length !== 15) throw new PaymentError('PromptPay ID must contain 13 or 15 digits');
    // 13 digits is a tax ID, 15 is a billing identifier.
    return { subtag: id.length === 13 ? '02' : '03', value: id };
  }
  if (type !== 'phone') throw new PaymentError('PromptPay account type must be phone, taxid or id');

  let phone = account.replace(/[^0-9]/g, '');
  if (phone.startsWith('66')) phone = phone.slice(2);
  else if (phone.startsWith('0')) phone = phone.slice(1);
  if (phone.length !== 9) throw new PaymentError('PromptPay phone number must contain 9 digits after the country or leading zero');
  return { subtag: '01', value: `0066${phone}` };
}

/**
 * Build a Thai QR payload.
 *
 * @param {object} options
 * @param {number} options.amount          total in baht, must be greater than zero
 * @param {object} options.account         { type, value } for the PromptPay target
 * @param {string} [options.reference]     bill number, shown as tag 62
 * @param {string} [options.merchantName]  tag 59, what the payer sees
 * @param {string} [options.merchantCity]  tag 60
 * @param {string} [options.mcc]           tag 52, four digits
 */
function buildThaiQr(options = {}) {
  const {
    amount, account, reference, merchantName, merchantCity, mcc, dynamic: isDynamic = true,
  } = options;

  const total = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(total) || total <= 0) throw new PaymentError('Payment amount must be greater than zero');
  if (total > 9999999999.99) throw new PaymentError('Payment amount is above the QR maximum');

  const target = accountTarget(account && account.type, account && account.value);

  const merchantAccount = `${tlv('00', PROMPTPAY_SCHEME)}${tlv(target.subtag, target.value)}`;
  let payload = '';
  payload += tlv('00', '01');
  // 11 static is for a printed QR that always means the same amount. 12 dynamic
  // is for one generated per order, which is what a till needs so two customers
  // never collide on the same reference.
  payload += tlv('01', isDynamic ? '12' : '11');
  if (mcc && /^[0-9]{4}$/.test(String(mcc))) payload += tlv('52', String(mcc));
  payload += tlv('29', merchantAccount);
  payload += tlv('53', String(CURRENCY_THB));
  payload += tlv('54', total.toFixed(2));
  payload += tlv('58', 'TH');
  // Name and city are what make the payer's confirmation screen say something
  // recognisable instead of an anonymous transfer.
  if (merchantName) payload += tlv('59', String(merchantName).slice(0, 25));
  if (merchantCity) payload += tlv('60', String(merchantCity).slice(0, 15));
  // Tag 62 is the reference the payer sees and the shop reconciles against.
  if (reference) payload += tlv('62', String(reference).slice(0, 25));

  const checksum = `${payload}6304`;
  return `${checksum}${crc16(checksum)}`;
}

// Reads a payload back out. Used by the tests to prove the fields landed where
// they were meant to, rather than trusting the string that came out.
function readThaiQr(payload) {
  const text = String(payload || '');

  // Parsed by walking the length prefixes, not by searching for a tag number.
  // A string search finds "29" inside an amount, a reference or the checksum,
  // which is how a parser starts disagreeing with the payload it is reading.
  const tags = {};
  let i = 0;
  while (i + 4 <= text.length) {
    const id = text.slice(i, i + 2);
    if (!/^[0-9]{2}$/.test(id)) break;
    const length = Number(text.slice(i + 2, i + 4));
    if (!Number.isFinite(length)) break;
    const value = text.slice(i + 4, i + 4 + length);
    if (value.length !== length) break;
    if (id !== '63') tags[id] = value;
    i += 4 + length;
  }

  // Tag 29 holds its own nested TLV: a scheme, then the account sub-tag and
  // value. Parsed with the same walk, at the real offset.
  let scheme = null;
  let subtag = null;
  let accountValue = null;
  let inner = tags['29'];
  if (inner !== undefined) {
    let j = 0;
    while (j + 4 <= inner.length) {
      const id = inner.slice(j, j + 2);
      const length = Number(inner.slice(j + 2, j + 4));
      if (!Number.isFinite(length)) break;
      const value = inner.slice(j + 4, j + 4 + length);
      if (value.length !== length) break;
      if (id === '00') scheme = value;
      if (id === '01' || id === '02' || id === '03') { subtag = id; accountValue = value; }
      j += 4 + length;
    }
  }

  const stated = text.slice(-4);
  return {
    tags,
    merchantAccountScheme: scheme,
    merchantAccountSubtag: subtag,
    merchantAccountValue: accountValue,
    // Recomputed over everything up to but excluding the four checksum
    // characters, which is what a scanning app does before it trusts a payload.
    checksumValid: stated === crc16(text.slice(0, -4)),
    statedChecksum: stated,
  };
}

module.exports = {
  buildThaiQr, readThaiQr, crc16, tlv, validThaiTaxId, accountTarget,
  PROMPTPAY_SCHEME, CURRENCY_THB, PaymentError,
};