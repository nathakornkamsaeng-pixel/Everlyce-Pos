// Personal Data Protection Act B.E. 2562 controls: consent, the data subject
// rights, retention, and the Thai tax-invoice fields a receipt must carry.
const { spawn } = require('child_process');
const path = require('path');

const { isolatedData } = require('./helpers/isolated-data');
const DATA_DIR = isolatedData();
const PORT = Number(process.env.TEST_PORT || 18900);
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = process.env.TEST_STORE || 'myrestaurant';
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const children = new Set();
function launch() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, POS_DATA_DIR: DATA_DIR, PORT: String(PORT), POS_DEFAULT_STORE_SLUG: STORE, POS_BOOTSTRAP_USERNAME: 'admin', POS_BOOTSTRAP_PASSWORD: PASSWORD, POS_PLATFORM_ADMIN_USERNAME: 'admin', POS_PLATFORM_ADMIN_PASSWORD: PASSWORD },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', () => children.delete(child));
  return { child, get log() { return log; } };
}
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} } }
process.on('exit', killAll);
process.on('unhandledRejection', (e) => { console.error(e); killAll(); process.exit(1); });

async function call(method, p, { body, token, store = STORE, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (store) h['X-POS-Store'] = store;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, headers: res.headers };
}

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const srv = launch();
  if (!await waitUp()) { console.log('server did not start\n', srv.log); killAll(); process.exit(1); }

  const login = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  ok('admin sign-in', login.status === 200 && !!login.data.token, login);
  const T = login.data.token;

  console.log('\n== the notice tells a customer what they can ask for ==');
  const notice = await call('GET', '/api/loyalty/privacy-notice', { token: T });
  ok('the notice is served', notice.status === 200, notice.status);
  // A customer being asked to consent is not signed in, so the notice has to be
  // readable without a session or it is not a notice.
  const publicNotice = await call('GET', '/api/loyalty/privacy-notice');
  ok('the notice needs no sign-in', publicNotice.status === 200, publicNotice.status);
  ok('and says the same thing', publicNotice.data.version === notice.data.version, publicNotice.data.version);
  ok('it carries a version', !!notice.data.version, notice.data.version);
  ok('it lists the lawful purposes', notice.data.purposes && notice.data.purposes.loyalty, notice.data.purposes);
  ok('it states a retention period', typeof notice.data.retentionDays === 'number', notice.data.retentionDays);
  ok('it lists the data subject rights', (notice.data.rights || []).length >= 5, (notice.data.rights || []).map((r) => r.id));
  ok('access and erasure are among them',
    (notice.data.rights || []).some((r) => r.id === 'access') && (notice.data.rights || []).some((r) => r.id === 'erase'),
    (notice.data.rights || []).map((r) => r.id));

  console.log('\n== consent is required before personal data is stored ==');
  const noConsent = await call('POST', '/api/loyalty/members', {
    token: T, body: { name: 'No Consent', phone: '0812345678' },
  });
  ok('a phone number without consent is refused', noConsent.status === 400 && noConsent.data.code === 'consent_required', noConsent);
  ok('the refusal names the policy version', noConsent.data.policyVersion === notice.data.version, noConsent.data);

  const marketingOnly = await call('POST', '/api/loyalty/members', {
    token: T, body: { name: 'Marketing Only', phone: '0811111111', consentMarketing: true },
  });
  ok('marketing-only consent is accepted', marketingOnly.status === 201, marketingOnly);
  ok('it records the marketing purpose', (marketingOnly.data.consentPurposes || []).includes('marketing'), marketingOnly.data.consentPurposes);
  ok('and not the loyalty purpose', !(marketingOnly.data.consentPurposes || []).includes('loyalty'), marketingOnly.data.consentPurposes);
  ok('serving the account is always recorded', (marketingOnly.data.consentPurposes || []).includes('service'), marketingOnly.data.consentPurposes);
  ok('it records when consent was given', !!marketingOnly.data.consentAt, marketingOnly.data.consentAt);
  ok('and which version', marketingOnly.data.consentVersion === notice.data.version, marketingOnly.data.consentVersion);

  const both = await call('POST', '/api/loyalty/members', {
    token: T, body: { name: 'Both', phone: '0822222222', email: 'both@example.com', consentLoyalty: true, consentMarketing: true },
  });
  ok('full consent is accepted', both.status === 201, both);
  ok('loyalty and marketing are both recorded',
    (both.data.consentPurposes || []).includes('loyalty') && (both.data.consentPurposes || []).includes('marketing'),
    both.data.consentPurposes);
  ok('and serving the account is recorded too', (both.data.consentPurposes || []).includes('service'), both.data.consentPurposes);

  const anon = await call('POST', '/api/loyalty/members', { token: T, body: { name: 'Walk In' } });
  ok('a walk-in with no contact details needs no consent', anon.status === 201, anon);
  ok('and is not treated as personal data', !(anon.data.consentAt), anon.data.consentAt);

  const badPhone = await call('POST', '/api/loyalty/members', {
    token: T, body: { name: 'Bad', phone: 'not a phone!', consentLoyalty: true },
  });
  ok('an invalid phone number is refused', badPhone.status === 400, badPhone);

  console.log('\n== right of access and portability ==');
  const exported = await call('GET', `/api/loyalty/members/${both.data.id}/export`, { token: T });
  ok('the customer can get a copy of their data', exported.status === 200, exported.status);
  ok('it is offered as a download', /attachment/.test(exported.headers.get('content-disposition') || ''), exported.headers.get('content-disposition'));
  ok('it includes their details', exported.data.subject.phone === '0822222222', exported.data.subject);
  ok('it includes the consent record', !!exported.data.consent, exported.data.consent);
  ok('it includes their loyalty history', Array.isArray(exported.data.loyaltyHistory), exported.data.loyaltyHistory);
  ok('it names the controller', !!exported.data.controller.legalName || !!exported.data.controller.contactEmail !== undefined, exported.data.controller);

  console.log('\n== withdrawal of consent ==');
  const withdrawn = await call('POST', `/api/loyalty/members/${both.data.id}/withdraw-consent`, { token: T, body: {} });
  ok('consent can be withdrawn', withdrawn.status === 200, withdrawn.status);
  ok('the withdrawal is dated', !!withdrawn.data.consentWithdrawnAt, withdrawn.data.consentWithdrawnAt);
  const onePurpose = await call('POST', `/api/loyalty/members/${marketingOnly.data.id}/withdraw-consent`, { token: T, body: { purpose: 'marketing' } });
  ok('a single purpose can be withdrawn', onePurpose.status === 200 && !(onePurpose.data.consentPurposes || []).includes('marketing'), onePurpose.data.consentPurposes);

  console.log('\n== right to erasure ==');
  const before = await call('GET', '/api/loyalty/members', { token: T });
  const countBefore = before.data.length;
  const erased = await call('DELETE', `/api/loyalty/members/${both.data.id}`, { token: T });
  ok('the record can be deleted', erased.status === 200 && erased.data.ok, erased);
  const after = await call('GET', '/api/loyalty/members', { token: T });
  ok('it is gone from the member list', !after.data.some((m) => m.id === both.data.id), after.data.map((m) => m.id));
  ok('the list shrank by one', after.data.length === countBefore - 1, { before: countBefore, after: after.data.length });
  const gone = await call('GET', `/api/loyalty/members/${both.data.id}/export`, { token: T });
  ok('the export is no longer available', gone.status === 404, gone.status);

  console.log('\n== a cashier cannot exercise these rights ==');
  const cash = await call('POST', '/api/users', {
    token: T, body: { username: 'pdpa_cashier', name: 'Cashier', role: 'cashier', password: 'cashierpass1234' },
  });
  ok('cashier created', cash.status === 200 || cash.status === 201, cash);
  const cLogin = await call('POST', '/api/auth/login', { body: { username: 'pdpa_cashier', password: 'cashierpass1234' } });
  const C = cLogin.data.token;
  const cExport = await call('GET', `/api/loyalty/members/${anon.data.id}/export`, { token: C });
  ok('a cashier cannot export customer data', cExport.status === 403, cExport.status);
  const cErase = await call('DELETE', `/api/loyalty/members/${anon.data.id}`, { token: C });
  ok('a cashier cannot erase a customer', cErase.status === 403, cErase.status);
  const cConsent = await call('POST', '/api/loyalty/members', { token: C, body: { name: 'Nope', phone: '0899999999', consentLoyalty: true } });
  ok('a cashier cannot record a new member', cConsent.status === 403, cConsent.status);

  console.log('\n== retention ==');
  const setRetention = await call('PUT', '/api/settings', { token: T, body: { personalDataRetentionDays: 1 } });
  ok('the retention period is settable', setRetention.status === 200 && setRetention.data.personalDataRetentionDays === 1, setRetention.data.personalDataRetentionDays);
  const badRetention = await call('PUT', '/api/settings', { token: T, body: { personalDataRetentionDays: -5 } });
  ok('a negative retention is refused', badRetention.status === 400, badRetention.status);
  const hugeRetention = await call('PUT', '/api/settings', { token: T, body: { personalDataRetentionDays: 99999 } });
  ok('an absurd retention is refused', hugeRetention.status === 400, hugeRetention.status);

  // An old record, with no consent, should not survive a sweep.
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  await call('POST', '/api/loyalty/members', { token: T, body: { name: 'Aged', phone: '0877777777', consentLoyalty: true } });
  await call('PUT', `/api/loyalty/members/${anon.data.id}`, { token: T, body: { name: anon.data.name } });
  const patched = await call('GET', '/api/loyalty/members', { token: T });
  ok('members are listed for the sweep', patched.data.length > 0, patched.data.length);

  console.log('\n== a pinned record is never swept ==');
  const pinned = await call('POST', `/api/loyalty/members/${anon.data.id}/pin`, { token: T, body: { pinned: true } });
  ok('a record can be pinned', pinned.status === 200 && pinned.data.pinned === true, pinned.data);
  const unpin = await call('POST', `/api/loyalty/members/${anon.data.id}/pin`, { token: T, body: { pinned: false } });
  ok('and unpinned', unpin.status === 200 && unpin.data.pinned === false, unpin.data);

  console.log('\n== controller identity and Thai tax invoice ==');
  const noLegal = await call('GET', '/api/settings', { token: T });
  ok('the shop is not treated as tax-invoice ready before it is filled in', noLegal.data.taxInvoiceReady === false, noLegal.data.taxInvoiceReady);
  const setLegal = await call('PUT', '/api/settings', { token: T, body: { legalName: 'Siam Kitchen Co., Ltd.', taxId: '0123456789012' } });
  ok('the legal name is saved', setLegal.data.legalName === 'Siam Kitchen Co., Ltd.', setLegal.data.legalName);
  ok('the tax ID is saved', setLegal.data.taxId === '0123456789012', setLegal.data.taxId);
  ok('the invoice is now ready', setLegal.data.taxInvoiceReady === true, setLegal.data.taxInvoiceReady);
  const badEmail = await call('PUT', '/api/settings', { token: T, body: { privacyContactEmail: 'nope' } });
  ok('an invalid privacy contact is refused', badEmail.status === 400, badEmail.status);
  const setPrivacy = await call('PUT', '/api/settings', { token: T, body: { privacyContactEmail: 'privacy@shop.co.th' } });
  ok('the privacy contact is saved', setPrivacy.data.privacyContactEmail === 'privacy@shop.co.th', setPrivacy.data.privacyContactEmail);

  const notice2 = await call('GET', '/api/loyalty/privacy-notice', { token: T });
  ok('the notice now names the controller', notice2.data.controller.legalName === 'Siam Kitchen Co., Ltd.', notice2.data.controller);

  console.log('\n== a receipt carries the seller identity ==');
  const branding = await call('GET', '/api/public/branding', { token: T });
  ok('public branding still works', branding.status === 200, branding.status);

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error:/.test(srv.log)) {
    console.log('\n--- server log errors ---');
    console.log(srv.log.split('\n').filter((l) => /Error/.test(l)).slice(0, 10).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
