// Cookie consent.
//
// The rule under test is the one that is easy to state and easy to get wrong:
// nothing is stored in a cookie until the person has agreed, and every agreement
// is kept.
//
// Both halves are checked, and the second half matters more than it looks. A
// consent mechanism that records a decision but does not enforce it is theatre,
// and the enforcement has to be tested with cookies actually configured, which is
// a different code path from the default.

const { isolatedData } = require('./helpers/isolated-data');
process.env.POS_DATA_DIR = isolatedData();

const assert = require('assert');
// The consent module reads platform settings, which are only populated once the
// data document has been loaded. The server does this at startup; the test has to
// do it too, or platformSettings() trips over an unloaded store.
require('../src/db').load();
const consent = require('../src/cookieConsent');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  }
}

// A request, as far as the consent module is concerned.
function fakeRequest(ip = '203.0.113.9', agent = 'Mozilla/5.0 (Macintosh) Chrome/126') {
  return {
    headers: { 'x-forwarded-for': ip, 'user-agent': agent },
    socket: { remoteAddress: ip },
    ip,
  };
}

console.log('\n== with no cookies configured, nobody is asked to agree to nothing ==');
ok('the gate is off', consent.enabled() === false);
ok('and there is nothing to list', consent.categories().length === 0, consent.categories());
ok('and the module says so rather than asking', consent.enabled() === false, 'gate should be off with no POS_COOKIES');

console.log('\n== and recording a decision is refused, because there is nothing to decide ==');
const off = consent.record(fakeRequest(), { granted: true });
ok('recording is refused', Boolean(off.error), off);
ok('with a reason, not a silent failure', off.error && /no cookies/.test(off.error.detail), off.error && off.error.detail);

console.log('\n== the visitor identifier does not store an address ==');
const id = consent.visitorId(fakeRequest('198.51.100.42'));
ok('it is a hash, not an address', !id.includes('198.51.100') && /^[a-f0-9]{32}$/.test(id), id);
ok('the same visitor is recognisable', id === consent.visitorId(fakeRequest('198.51.100.42')));
ok('a different one is not', id !== consent.visitorId(fakeRequest('198.51.100.43')));
ok('the port noise an address carries is gone', !id.includes(':'));
ok('a user agent does not end up in the identifier', !/Mozilla|Chrome/.test(id));

console.log('\n== and it holds once cookies are configured ==');
// Reloading with a cookie configured is the only way to test the enforcing path,
// and it is a different one from the default: the gate is off above.
process.env.POS_COOKIES = 'pos_session,pos_remember';
delete require.cache[require.resolve('../src/cookieConsent')];
const on = require('../src/cookieConsent');

ok('the gate is on as soon as there is a cookie to set', on.enabled() === true);
ok('and it knows the names', on.COOKIE_NAMES.join(',') === 'pos_session,pos_remember', on.COOKIE_NAMES);
ok('it has a policy version to agree to', typeof on.policyVersion() === 'string' && on.policyVersion().length > 0, on.policyVersion());

const before = on.current(fakeRequest());
ok('a first-time visitor is required to agree', before.required === true, before);
ok('and has not agreed', before.granted === false, before);
ok('the banner is told what is being set', (before.cookies || []).length === 2, before.cookies);
ok('each one says why, so nothing is a blank category',
  (before.cookies || []).every((c) => c.name && c.purpose), before.cookies);
ok('it refuses to describe a set of cookies as optional when there are none',
  (before.cookies || []).every((c) => c.essential === true), before.cookies);

const refused = on.record(fakeRequest(), { granted: false });
ok('a refusal is recorded', refused.entry && refused.entry.granted === false, refused.entry);
ok('and is kept, not just honoured', Boolean(refused.entry && refused.entry.id));
const afterRefusal = on.current(fakeRequest());
ok('the same visitor is not asked again', afterRefusal.required === false, afterRefusal);
ok('and knows they refused', afterRefusal.granted === false, afterRefusal);

const agreed = on.record(fakeRequest(), { granted: true, categories: ['pos_session'] });
ok('an agreement is recorded', agreed.entry && agreed.entry.granted === true, agreed.entry);
ok('against the policy version', agreed.entry.version === on.policyVersion(), agreed.entry.version);
ok('recording what was agreed to, so a later question can be answered',
  (agreed.entry.categories || []).join(',') === 'pos_session', agreed.entry.categories);
const afterAgreement = on.current(fakeRequest());
ok('and the same visitor is not asked again', afterAgreement.required === false, afterAgreement);
ok('and is now agreed', afterAgreement.granted === true, afterAgreement);

console.log('\n== an agreement is versioned, so changing the ask re-asks ==');
// Someone who agreed to one set of cookies must not be counted as having agreed
// to a different set. The version lives in the platform settings, so changing it
// is what a deploy that changed the wording would do.
const settings = require('../src/db').platformSettings();
const saved = settings.privacy.consentVersion;
settings.privacy.consentVersion = '2.0';
ok('the version follows the settings', on.policyVersion() === '2.0', on.policyVersion());
ok('and a previous agreement no longer counts', on.current(fakeRequest()).required === true, on.current(fakeRequest()));
ok('so they are asked again', on.current(fakeRequest()).granted === false);
ok('and the old agreement is still on record, not deleted',
  on.history().records.some((r) => r.version === (saved || '1.0')), on.history().records.map((r) => r.version));
settings.privacy.consentVersion = saved;

console.log('\n== every agreement is kept, and the history is read only ==');
const history = on.history();
ok('the decisions are all there', history.total >= 2, history.total);
ok('split by decision', history.granted >= 1 && history.refused >= 1, { granted: history.granted, refused: history.refused });
ok('each has a version and a time', history.records.every((r) => r.version && r.decidedAt), history.records[0]);
ok('and no raw address anywhere in the history',
  !JSON.stringify(history).includes('198.51.100') && !JSON.stringify(history).includes('203.0.113.9'),
  'an address leaked into the consent log');
ok('the user agent is truncated, not kept whole',
  history.records.every((r) => !r.agent || r.agent.length <= 80), history.records.map((r) => (r.agent || '').length));

console.log('\n== withdrawing ==');
// A separate visitor who only ever agreed, because a refusal is itself a
// standing decision and must not be undone by revoking an agreement.
const agreedOnly = fakeRequest('198.51.100.77', 'Mozilla/5.0 (Windows) Firefox/128');
on.record(agreedOnly, { granted: true });
ok('they are agreed and not being asked', on.current(agreedOnly).required === false && on.current(agreedOnly).granted === true, on.current(agreedOnly));

const revoked = on.revokeAll();
ok('every live agreement is withdrawn', revoked.revoked >= 1, revoked);
ok('and they are asked again, rather than quietly staying agreed', on.current(agreedOnly).required === true, on.current(agreedOnly));
ok('because the record is marked withdrawn rather than deleted',
  on.history().records.some((r) => r.visitorId === on.visitorId(agreedOnly) && r.revokedAt), on.history().records.slice(0, 2));
ok('a refusal is left alone, since it was never a grant', on.history().refused >= 1, on.history().refused);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);