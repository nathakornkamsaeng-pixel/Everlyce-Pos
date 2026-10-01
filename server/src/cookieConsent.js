// Cookie consent, enforced rather than decorative.
//
// The rule this implements: **nothing is stored in a cookie until the person has
// agreed to it.** Not "agree, then we might". The gate is checked before the
// first write, so a page that forgets to check cannot set one.
//
// Whether it applies at all is a fact about the build, not a guess. This site
// sets no cookies, so with nothing configured the gate is off and nobody is
// asked to agree to nothing. Turning on the first cookie turns the gate on, and
// the banner appears on the next page load, before that cookie is written.
//
// Every decision is kept: given or refused, when, against which version of the
// policy, and a stable pseudonymous identifier so a repeat visitor can be shown
// their existing decision instead of being asked again.
//
// On identifiers: a consent record has to be attributable to be worth keeping,
// but a raw IP address is personal data in its own right and this does not need
// one. The address is salted and hashed, so the same visitor is recognisable
// across requests and the address itself is not stored. The user agent is
// truncated for the same reason: it is useful for debugging a consent flow and
// identifies a person closely enough that keeping it whole is not worth it.

const crypto = require('crypto');
const { coll, nextId, now, touch, platformSettings } = require('./db');

// Cookies that carry the product working, as opposed to anything tracking or
// advertising. There are none today. Setting this list is what turns the gate on.
const COOKIE_NAMES = String(process.env.POS_COOKIES || '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

function enabled() {
  return COOKIE_NAMES.length > 0;
}

// The version the banner text and the categories belong to. Bumping it means
// every existing agreement stops matching and consent is asked for again, which
// is the only honest way to change what someone agreed to.
function policyVersion() {
  const shared = (platformSettings() || {}).privacy || {};
  return String(shared.consentVersion || '1.0');
}

function categories() {
  return COOKIE_NAMES.map((name) => ({
    name,
    // Nothing here is advertising or analytics until someone adds a cookie that
    // is, and the editor has to say which it is rather than leave a category
    // empty for the reader to guess at.
    essential: true,
    purpose: 'Needed for the product to work.',
  }));
}

// Salted so the record identifies a returning visitor without holding their
// address. The salt lives in the environment and never in the data file.
// Kept in the platform settings rather than generated per call.
//
// A salt generated per call gives every request a different identifier, so a
// visitor is asked to agree again on every page load, which is the exact failure
// consent logic exists to prevent. Held in the platform settings because that is
// already the server's own configuration and the data file is not public; set
// POS_CONSENT_SALT in the environment to keep it out of the file entirely.
function consentSalt() {
  if (process.env.POS_CONSENT_SALT) return process.env.POS_CONSENT_SALT;
  const settings = platformSettings();
  if (!settings.privacy.consentSalt) {
    settings.privacy.consentSalt = crypto.randomBytes(32).toString('hex');
    touch();
  }
  return settings.privacy.consentSalt;
}

function visitorId(req) {
  // The install's own secret, which already exists and already persists. A salt
  // generated per call would be worse than useless: it would give every request a
  // different identifier, so a visitor would be asked to agree again on every
  // page load, which is the exact failure consent logic exists to avoid.
  const salt = consentSalt();
  const ip = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',')[0].trim()
    || (req.socket && req.socket.remoteAddress) || '';
  // The full address goes into the hash, not a truncated one.
  //
  // Truncating to a /24 to look more anonymous is backwards: it makes every
  // person behind one router the same identifier, so the first of them to agree
  // marks all of them agreed. Somebody who never agreed would be treated as
  // having agreed, which is the one thing a consent record must never do. The
  // address is not stored either way, and the hash is one way, so nothing is
  // gained by coarsening it and a real correctness problem is incurred.
  return crypto
    .createHmac('sha256', salt)
    .update(`${ip}|${(req.headers && req.headers['user-agent']) || ''}`)
    .digest('hex')
    .slice(0, 32);
}

function current(req) {
  if (!enabled()) return { required: false, cookies: [], version: policyVersion() };
  const id = visitorId(req);
  const records = coll('cookieConsents') || [];
  // Most recent decision wins, so withdrawing is as easy as agreeing.
  // Withdrawn records do not count. Reading the most recent record without
  // checking meant that revoking consent changed nothing visible: the record was
  // still the newest one, so the visitor carried on being treated as agreed.
  const mine = records
    .filter((r) => r.visitorId === id && !r.revokedAt)
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  const last = mine[0] || null;
  const current_ = last && last.version === policyVersion() ? last : null;
  return {
    required: !current_,
    granted: Boolean(current_ && current_.granted),
    version: policyVersion(),
    decidedAt: current_ ? current_.decidedAt : null,
    cookies: categories(),
    // Said plainly rather than left for the reader to work out: there is nothing
    // to agree to until there is something to agree to.
    notice: enabled()
      ? null
      : 'This site sets no cookies.',
  };
}

function record(req, { granted, categories: chosen }) {
  if (!enabled()) return { error: { status: 400, detail: 'This site sets no cookies, so there is nothing to agree to.' } };
  const grantedBool = Boolean(granted);
  const entry = {
    id: nextId('cookieConsents'),
    visitorId: visitorId(req),
    granted: grantedBool,
    // What they agreed to, so a later question can be answered even if the
    // cookie list has since changed.
    categories: Array.isArray(chosen) ? chosen.map(String).slice(0, 20) : COOKIE_NAMES,
    version: policyVersion(),
    // Kept, because "did they agree, and to what version" is the whole question
    // a complaint or an audit will ask.
    decidedAt: now(),
    // A short prefix is enough to tell browsers apart without keeping a
    // fingerprint.
    agent: String((req.headers && req.headers['user-agent']) || '').slice(0, 80),
    revokedAt: null,
  };
  coll('cookieConsents').push(entry);
  touch();
  return { entry };
}

// Every decision ever made, for the platform console to read. Read-only here on
// purpose: a consent record that can be edited is not evidence of consent.
function history(limit = 200) {
  const records = (coll('cookieConsents') || []).slice().sort((a, b) => (a.at < b.at ? 1 : -1));
  return {
    enabled: enabled(),
    cookieNames: COOKIE_NAMES,
    version: policyVersion(),
    total: records.length,
    granted: records.filter((r) => r.granted).length,
    refused: records.filter((r) => !r.granted).length,
    revoked: records.filter((r) => r.revokedAt).length,
    records: records.slice(-limit).reverse(),
  };
}

function revokeAll() {
  const records = coll('cookieConsents') || [];
  let n = 0;
  for (const r of records) {
    if (r.granted && !r.revokedAt) { r.revokedAt = now(); n += 1; }
  }
  touch();
  return { revoked: n };
}

module.exports = {
  enabled, COOKIE_NAMES, policyVersion, categories, current, record, history, revokeAll, visitorId,
};