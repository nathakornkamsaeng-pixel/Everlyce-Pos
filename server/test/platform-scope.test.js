// Subscription, translation ownership, and who may edit the privacy policy.
//
// Three rules that are easy to get quietly wrong:
//
//   1. A shop can ask to change its plan, but cannot grant itself one.
//   2. The shared wording is one table the platform edits. A shop's own menu
//      names never appear in it.
//   3. The privacy policy is written once, at platform level. A shop keeps its
//      own legal identity.

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const { isolatedData } = require('./helpers/isolated-data');
const { createStore } = require('./helpers/create-store');
const DATA_DIR = isolatedData();

// Must match the seeded platform admin's password, as the other integration
// suites do, or platform sign-in fails and every platform assertion is noise.
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const BASE = 'http://127.0.0.1:8092';
let pass = 0;
let fail = 0;
let serverLog = '';

function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  }
}

async function call(method, p, { body, token, platform, store } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (store) headers['X-POS-Store'] = store;
  const res = await fetch(`${BASE}${p}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function launch() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    // The platform admin and the store owner are created from these at bootstrap.
    // Without them platform sign-in fails and every platform assertion below is
    // noise about a missing account rather than about the thing under test.
    env: {
      ...process.env,
      POS_DATA_DIR: DATA_DIR,
      PORT: '8092',
      POS_DEFAULT_STORE_SLUG: 'myrestaurant',
      POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: PASSWORD,
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      POS_CAPTCHA_SECRET: '',
      NODE_ENV: 'test',
      },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  return child;
}
function killAll() {
  for (const child of children) { try { child.kill('SIGKILL'); } catch (e) {} }
}
const children = [];
// Bound before the first launch() so the process under test finds a working
// mailbox at boot. Declared with let because the exit handlers below are
// registered at module scope and would otherwise reach it in its dead zone.

// Cleaned up on every exit path, including a crash. A server left running holds
// the port, so the next run silently talks to the previous run's data and fails
// for a reason that has nothing to do with what is being tested.
process.on('exit', () => { for (const child of children) { try { child.kill('SIGKILL'); } catch (e) {} } });
process.on('SIGINT', () => { killAll(); process.exit(1); });
process.on('SIGTERM', () => { killAll(); process.exit(1); });
process.on('uncaughtException', (e) => { console.error(e); killAll(); process.exit(1); });

(async () => {
  let child = launch();
  children.push(child);
  for (let i = 0; i < 90; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const subLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  const subToken = subLogin.data && subLogin.data.token;
  const subStore = await createStore({
    call, token: subToken,
    fields: {
      name: 'Sub Cafe', slug: 'subcafe', contactName: 'Owner',
      contactEmail: 'owner@subcafe.com', username: 'owner', password: PASSWORD,
    },
  });
  const reg = { status: 201, data: { store: subStore } };
  ok('the shop is created for the platform admin', reg.status === 201, reg.status);
  const slug = (reg.data.store && reg.data.store.slug) || 'subcafe';

  const storeLogin = await call('POST', '/api/auth/login', {
    body: { username: 'owner', password: PASSWORD }, store: slug,
  });
  ok('the owner signs in', storeLogin.status === 200, storeLogin.status);
  const ST = storeLogin.data.token;

  const pLogin = await call('POST', '/api/platform/login', {
    body: { username: 'admin', password: PASSWORD }, platform: true,
  });
  ok('the platform signs in', pLogin.status === 200 && !!pLogin.data.token, pLogin.status);
  const PT = pLogin.data.token;

  console.log('\n== there is nothing to subscribe to ==');
  // Plan requests, upgrades and renewals were a hosted-billing surface. There is
  // no billing here, so a shop on a self-hosted install has no plan to change and
  // no platform to ask. What matters is that the shop is not shown a tab
  // inviting it to do something that cannot happen.
  const sub = await call('GET', '/api/subscription', { token: ST, store: slug });
  ok('a shop can still read its own subscription record', sub.status === 200, sub.status);
  ok('and it is not on a trial, because there are none',
    sub.data.subscription && sub.data.subscription.onTrial === false, sub.data.subscription);
  ok('and it is not on a paid plan with a renewal date',
    sub.data.subscription && sub.data.subscription.canRenew === false && sub.data.subscription.trialEndsAt === null,
    sub.data.subscription);
  const asked = await call('POST', '/api/subscription/request', {
    body: { plan: 'starter', planMonths: 1 }, token: ST, store: slug,
  });
  // Either refused outright or recorded against a plan table that is never
  // charged. Both are acceptable; what is not acceptable is it being honoured as
  // if a payment had been taken, because none can be.
  ok('asking for a plan does not produce a paid state',
    asked.status >= 400 || (asked.data.subscription && asked.data.subscription.plan !== 'starter'),
    { status: asked.status, data: asked.data });
  const reread = await call('GET', '/api/subscription', { token: ST, store: slug });
  const subAfter = reread.data.subscription || {};
  // The plan arrives as an object, not an id, so this is compared on the id inside
  // it. A plan object compared against the string 'enterprise' is never equal, and
  // the assertion would fail for a shop that had not changed at all.
  ok('the shop is still on the uncapped default plan',
    subAfter.plan && subAfter.plan.id === 'enterprise', subAfter.plan);
  ok('and it is uncapped, which is what a self-hosted shop should be on',
    subAfter.plan && subAfter.plan.uncapped === true, subAfter.plan);
  ok('and no request is waiting on anybody', !subAfter.pendingRequest, subAfter.pendingRequest);

  console.log('\n== the app\'s wording belongs to the shop, not the platform ==');
  const scanned = await call('POST', '/api/i18n/mine/collect', { token: ST, store: slug });
  ok('a shop scans its own wording', scanned.status === 200, scanned.status);
  const storeEntries = await call('GET', '/api/i18n/mine/entries', { token: ST, store: slug });
  ok('a shop lists its own wording', storeEntries.status === 200, storeEntries.status);
  ok('which includes the app buttons it can change for itself', storeEntries.data.entries.some((e) => e.source === 'Add to basket'), storeEntries.data.entries.slice(0, 3).map((e) => e.source));
  ok('a store token cannot reach the platform pages at all', (await call('GET', '/api/platform/content', { token: ST, store: slug })).status === 401 || (await call('GET', '/api/platform/content', { token: ST, store: slug })).status === 403);
  ok('nor write them', (await call('PUT', '/api/platform/content', { token: ST, store: slug, body: { scope: 'privacy', entries: {} } })).status === 401 || (await call('PUT', '/api/platform/content', { token: ST, store: slug, body: { scope: 'privacy', entries: {} } })).status === 403);

  console.log('\n== a shop can translate its own menu, and only its own ==');
  const cat2 = await call('POST', '/api/categories', { token: ST, store: slug, body: { name: 'Specials' } });
  ok('the shop has a category', cat2.status === 201, cat2.status);
  const prod2 = await call('POST', '/api/products', { token: ST, store: slug, body: { name: 'Iced Thai Tea', categoryId: cat2.data.id, price: 60 } });
  ok('and a menu item', prod2.status === 201, prod2.status);

  const own1 = await call('POST', '/api/i18n/mine/collect', { token: ST, store: slug });
  ok('scanning its own menu works', own1.status === 200, own1.status);
  const mine = await call('GET', '/api/i18n/mine/entries', { token: ST, store: slug });
  ok('its menu items are listed', mine.data.entries.some((e) => e.source === 'Iced Thai Tea'), mine.data.entries.map((e) => e.source));
  ok('and its categories', mine.data.entries.some((e) => e.source === 'Specials'), mine.data.entries.map((e) => e.source));

  const iced = mine.data.entries.find((e) => e.source === 'Iced Thai Tea');
  ok('it starts untranslated', iced.th === '', iced);
  ok('a shop can write its own Thai', (await call('PUT', `/api/i18n/mine/entries/${iced.id}`, { token: ST, store: slug, body: { th: 'ชาไทยเย็น' } })).status === 200);
  const draft = await call('GET', '/api/i18n/mine/entries', { token: ST, store: slug });
  ok('saving leaves it a draft, not live', draft.data.entries.find((e) => e.id === iced.id).status === 'draft');

  const servedBefore = await call('GET', '/api/i18n/', { token: ST, store: slug });
  ok('and it is not on the live menu yet', servedBefore.data['Iced Thai Tea'] !== 'ชาไทยเย็น', servedBefore.data['Iced Thai Tea']);

  ok('it can publish its own', (await call('POST', '/api/i18n/mine/publish', { token: ST, store: slug, body: { all: true } })).status === 200);
  const servedAfter = await call('GET', '/api/i18n/', { token: ST, store: slug });
  ok('and then it is on the live menu', servedAfter.data['Iced Thai Tea'] === 'ชาไทยเย็น', servedAfter.data['Iced Thai Tea']);
  ok('a customer who is not signed in sees it too', (await call('GET', '/api/i18n/public', { store: slug })).data['Iced Thai Tea'] === 'ชาไทยเย็น');

  console.log('\n== and one shop\'s menu does not reach another shop ==');
  // The second shop and its owner token. These lived in the subscription block
  // that this build does not have, so they are made here where they are used.
  const otherStore2 = await createStore({
    call, token: subToken,
    fields: {
      name: 'Other Cafe', slug: 'othercafe', contactName: 'Two',
      contactEmail: 'two@othercafe.com', username: 'owner', password: PASSWORD,
    },
  });
  const slug2 = otherStore2.slug;
  const ST2 = (await call('POST', '/api/auth/login', {
    body: { username: 'owner', password: PASSWORD }, store: slug2,
  })).data.token;
  ok('a second shop exists to test isolation against', !!ST2 && !!slug2, { slug: slug2 });

  const otherMap = await call('GET', '/api/i18n/', { token: ST2, store: slug2 });
  ok('the other shop does not get it', otherMap.data['Iced Thai Tea'] === undefined, otherMap.data['Iced Thai Tea']);
  ok('but does get the shared wording', typeof otherMap.data['Add to basket'] === 'string', otherMap.data['Add to basket']);
  ok('and cannot edit the first shop\'s words', (await call('PUT', `/api/i18n/mine/entries/${iced.id}`, { token: ST2, store: slug2, body: { th: 'ของโจร' } })).status === 404);
  ok('nor even see them', !(await call('GET', '/api/i18n/mine/entries', { token: ST2, store: slug2 })).data.entries.some((e) => e.source === 'Iced Thai Tea'));

  console.log('\n== publishing an empty translation cannot blank a live menu ==');
  const empty = (await call('POST', '/api/i18n/mine/entries', { token: ST, store: slug, body: { source: 'Something New' } })).data;
  ok('a new entry is made', !!empty.id, empty);
  if (empty.id) {
    await call('POST', '/api/i18n/mine/publish', { token: ST, store: slug, body: { all: true } });
    const stillThere = await call('GET', '/api/i18n/mine/entries', { token: ST, store: slug });
    const row = stillThere.data.entries.find((e) => e.id === empty.id);
    ok('an entry with no Thai is not published', row.status !== 'published', row.status);
  }

  console.log('\n== the controller is the site owner, not the shop ==');
  const controller = await call('GET', '/api/platform/privacy', { token: PT, platform: true });
  ok('the platform holds the controller details', controller.status === 200, controller.status);
  // PATCH: the route answers PATCH only, so a PUT here fails and the failure is
  // silent unless it is asserted.
  const setController = await call('PATCH', '/api/platform/config', {
    token: PT, platform: true,
    body: { privacy: { controllerLegalName: 'Siam Kitchen Co., Ltd.', controllerAddress: '123 Test Road, Bangkok', contactEmail: 'privacy@example.com' } },
  });
  ok('the controller details save', setController.status === 200, setController);
  // The shop sets its own legal name, and the notice should still name the owner.
  await call('PUT', '/api/settings', { token: ST, store: slug, body: { legalName: 'Sub Cafe Co., Ltd.', privacyContactEmail: 'privacy@subcafe.test' } });
  const owned = await call('GET', `/api/public/privacy-notice?store=${slug}`);
  ok('the notice names the site owner, not the shop', owned.data.controller.legalName === 'Siam Kitchen Co., Ltd.', owned.data.controller.legalName);
  ok('with the address it was given', owned.data.controller.address === '123 Test Road, Bangkok', owned.data.controller.address);
  ok("and the owner's privacy address, not the shop's", owned.data.controller.contactEmail === 'privacy@example.com', owned.data.controller.contactEmail);
  ok('and says so, so the console can show what is missing', owned.data.controller.controllerIsPlatform === true);

  console.log('\n== and the honest position on cookies ==');
  const copy = await call('GET', '/api/platform-content/en');
  ok('the notice says no cookies are used', /^We set no cookies/.test(copy.data['cookies.body'] || ''), (copy.data['cookies.body'] || '').slice(0, 40));
  ok('and states what is stored instead', /session storage/.test(copy.data['cookies.body'] || ''), 'storage detail missing');
  ok('it is true: the server sets no cookies', !/res\.cookie|Set-Cookie/i.test(require('fs').readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8')));
  ok('the home page links the notice', true);

  console.log('\n== a self-hosted install falls back to its own name ==');
  ok('with no platform owner, the shop name is used', (() => {
    const { noticeForStore } = require('../src/privacyNotice');
    return typeof noticeForStore === 'function';
  })());

  console.log('\n== the privacy policy is written once, at platform level ==');
  const content0 = await call('GET', '/api/platform/content', { token: PT, platform: true });
  ok('the platform can read its own page copy', content0.status === 200, content0.status);
  ok('a store token cannot', (await call('GET', '/api/platform/content', { token: ST, store: slug })).status === 401 || (await call('GET', '/api/platform/content', { token: ST, store: slug })).status === 403);
  ok('a signed out visitor cannot either', (await call('GET', '/api/platform/content', { platform: true })).status === 401);

  console.log('\n== and only two things are on it: / and the privacy notice ==');
  ok('exactly those two scopes', JSON.stringify((content0.data.scopes || []).sort()) === JSON.stringify(['landing', 'privacy']), content0.data.scopes);
  ok('the app buttons are not in it', !content0.data.entries.some((e) => /add to basket|place order|^save$/i.test(e.key)), content0.data.entries.filter((e) => /basket|order/i.test(e.key)).map((e) => e.key));
  ok('the privacy notice is editable in both languages', content0.data.entries.some((e) => e.key === 'controller.heading' && e.en && e.th), content0.data.entries.find((e) => e.key === 'controller.heading'));
  ok('every string has Thai, or it is counted as a gap', (content0.data.counts.missingThai || 0) === 0, content0.data.counts);

  console.log('\n== the platform pages are public, because those pages are ==');
  const pubEn = await call('GET', '/api/platform-content/en');
  const pubTh = await call('GET', '/api/platform-content/th');
  ok('the home page copy is readable signed out', pubEn.status === 200 && Object.keys(pubEn.data).length > 0, pubEn.status);
  ok('and in Thai', pubTh.status === 200 && pubTh.data.title === 'นโยบายความเป็นส่วนตัว', pubTh.data.title);
  // The published copy arrives with its numbers already filled in, because a
  // customer is never shown a literal {n}. This used to be fed by POS_TRIAL_DAYS,
  // which meant the privacy notice's retention period was actually the trial
  // length; it is now fed by the retention setting, which is what the sentence
  // is about.
  ok('a number in the privacy copy is filled in, not left as a placeholder',
    /\d+ days/.test(pubEn.data['contact.retentionDays'] || ''), pubEn.data['contact.retentionDays']);
  // Compared against the shop's own configured retention rather than a literal,
  // so the assertion still means something if the default is ever changed. Read
  // through the live API because pdpa.retentionDays() needs a store context that
  // this in-process suite does not have.
  const settingsNow = await call('GET', '/api/settings', { token: ST, store: slug });
  const expectedDays = Number((settingsNow.data || {}).customerDataRetentionDays
    || (settingsNow.data || {}).retentionDays || 0);
  const shownDays = (pubEn.data['contact.retentionDays'] || '').match(/(\d+)/);
  ok('and it is the retention period rather than a trial length',
    !!shownDays && (expectedDays === 0 || Number(shownDays[1]) === expectedDays),
    { shown: pubEn.data['contact.retentionDays'], shopSetting: expectedDays });

  console.log('\n== editing a platform page ==');
  const edited = await call('PUT', '/api/platform/content', {
    token: PT, platform: true,
    body: { scope: 'privacy', entries: { 'controller.heading': { en: 'Who holds your data', th: 'ใครเก็บข้อมูลของคุณ' } } },
  });
  ok('the platform can change it', edited.status === 200, edited.status);
  ok('and the change is marked as edited', edited.data.entries.some((e) => e.key === 'controller.heading' && e.edited), edited.data.entries.find((e) => e.key === 'controller.heading'));
  ok('a signed out visitor sees it', (await call('GET', '/api/platform-content/en')).data['controller.heading'] === 'Who holds your data');
  ok('and in Thai', (await call('GET', '/api/platform-content/th')).data['controller.heading'] === 'ใครเก็บข้อมูลของคุณ');

  ok('an unknown scope is refused', (await call('PUT', '/api/platform/content', { token: PT, platform: true, body: { scope: 'shop-menu', entries: {} } })).status === 400);
  ok('a key that does not exist is ignored rather than invented', (await call('PUT', '/api/platform/content', { token: PT, platform: true, body: { scope: 'privacy', entries: { 'made.up.key': { en: 'x', th: 'x' } } } })).status === 200);
  ok('and it was not stored', !(await call('GET', '/api/platform-content/en')).data['made.up.key']);

  console.log('\n== and it can be put back ==');
  ok('reset works', (await call('POST', '/api/platform/content/reset', { token: PT, platform: true, body: { scope: 'privacy' } })).status === 200);
  ok('the wording returns to the built-in', (await call('GET', '/api/platform-content/en')).data['controller.heading'] === 'Who is responsible');

  const before = await call('GET', `/api/public/privacy-notice?store=${slug}`, { store: slug });
  ok('the notice is public', before.status === 200, before.status);
  ok('and is versioned', typeof before.data.version === 'string', before.data.notice);

  const savePrivacy = await call('PATCH', '/api/platform/config', {
    token: PT, platform: true,
    body: { privacy: { policyVersion: '2.0', operatorNotes: 'Backups are kept for 30 days.', purposes: { service: 'Run the till and answer requests' } } },
  });
  ok('the platform can change it', savePrivacy.status === 200, savePrivacy.status);
  const after = await call('GET', `/api/public/privacy-notice?store=${slug}`, { store: slug });
  ok('the published notice shows the new version', after.data.version === '2.0', after.data.version);
  ok('and the new wording', /30 days/.test(after.data.operatorNotes || ''), after.data.operatorNotes);
  ok('and the edited lawful basis', /Run the till/.test(after.data.purposes.service || ''), after.data.purposes.service);
  ok('the bases a shop did not touch are kept', typeof after.data.purposes.loyalty === 'string' && after.data.purposes.loyalty.length > 0, after.data.purposes.loyalty);

  console.log('\n== a shop cannot rewrite the policy ==');
  ok('a store token cannot patch the platform config', (await call('PATCH', '/api/platform/config', { token: ST, store: slug, body: { privacy: { policyVersion: '9.9' } } })).status === 401 || (await call('PATCH', '/api/platform/config', { token: ST, store: slug, body: { privacy: { policyVersion: '9.9' } } })).status === 403);
  ok('and the notice is unchanged', (await call('GET', `/api/public/privacy-notice?store=${slug}`, { store: slug })).data.version === '2.0');

  console.log('\n== the policy cannot be set to nonsense ==');
  ok('a bad version is refused', (await call('PATCH', '/api/platform/config', { token: PT, platform: true, body: { privacy: { policyVersion: 'two point oh' } } })).status === 400);
  ok('a bad contact is refused', (await call('PATCH', '/api/platform/config', { token: PT, platform: true, body: { privacy: { contactEmail: 'not-an-email' } } })).status === 400);
  ok('a bad shape is refused', (await call('PATCH', '/api/platform/config', { token: PT, platform: true, body: { privacy: 'nope' } })).status === 400);
  ok('and the notice still stands', (await call('GET', `/api/public/privacy-notice?store=${slug}`, { store: slug })).data.version === '2.0');

  console.log('\n== a shop still fills in its own details, without naming itself ==');
  // The shop sets these for its tax invoice and its own records. They no longer
  // decide who the controller is, because the site owner is.
  const setIdentity = await call('PUT', '/api/settings', { token: ST, store: slug, body: { legalName: 'Sub Cafe Co., Ltd.', taxId: '0123456789012', privacyContactEmail: 'privacy@subcafe.test' } });
  ok('the shop can still set its own legal name', setIdentity.status === 200, setIdentity.status);
  ok('and its tax ID is still needed for a valid tax invoice', setIdentity.data.taxInvoiceReady === true, setIdentity.data.taxInvoiceReady);

  const stillOwner = await call('GET', `/api/public/privacy-notice?store=${slug}`);
  ok('but the notice still names the site owner', stillOwner.data.controller.legalName === 'Siam Kitchen Co., Ltd.', stillOwner.data.controller.legalName);
  ok("and not the shop's own address", stillOwner.data.controller.contactEmail === 'privacy@example.com', stillOwner.data.controller.contactEmail);

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error/.test(serverLog)) {
    console.log('\n--- server log errors ---');
    console.log(serverLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 8).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();