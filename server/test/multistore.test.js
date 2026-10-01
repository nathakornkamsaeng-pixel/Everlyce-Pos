// End-to-end multi-store check against an isolated copy of the data.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { isolatedData } = require('./helpers/isolated-data');
const { createStore } = require('./helpers/create-store');
const DATA_DIR = isolatedData();
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const PORT = Number(process.env.TEST_PORT || 18099);
const BASE = `http://127.0.0.1:${PORT}`;

const children = new Set();
// Started before the first spawn and shared by the restart later in the suite,
// so both processes talk to the same mailbox.
function shutdown() { killAll(); }
function launch(port = PORT) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: { ...process.env, POS_DATA_DIR: DATA_DIR, PORT: String(port), POS_DEFAULT_STORE_SLUG: 'myrestaurant', POS_BOOTSTRAP_USERNAME: 'admin', POS_BOOTSTRAP_PASSWORD: PASSWORD, POS_PLATFORM_ADMIN_USERNAME: 'admin', POS_PLATFORM_ADMIN_PASSWORD: PASSWORD, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', () => children.delete(child));
  return { child, get log() { return log; } };
}
function killAll() {
  for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} }
}
process.on('exit', shutdown);
process.on('uncaughtException', (e) => { console.error(e); shutdown(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); shutdown(); process.exit(1); });

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

async function call(method, urlPath, { body, token, store, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (store) headers['X-POS-Store'] = store;
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return raw ? { status: res.status, data, text } : { status: res.status, data };
}

const first = launch();
let serverLog = '';
first.child.stdout.on('data', (d) => { serverLog += d; });
first.child.stderr.on('data', (d) => { serverLog += d; });

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  if (!await waitForServer()) {
    console.log('server did not start\n', serverLog);
    killAll();
    process.exit(1);
  }

  console.log('\n== migrated store ==');
  const health = await call('GET', '/api/health');
  // Liveness only. It used to report how many stores exist, which is free
  // reconnaissance on an unauthenticated endpoint.
  ok('health answers for monitoring', health.status === 200 && health.data.ok === true, health.data);
  ok('health leaks no store count', health.data.stores === undefined, health.data);

  console.log('\n== store isolation ==');
  const legacy = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrongpass' } });
  ok('login without a store is rejected', legacy.status === 400 && legacy.data.code === 'store_required', legacy);

  const unknown = await call('POST', '/api/auth/login', { body: { store: 'nosuchshop', username: 'a', password: 'b' } });
  ok('unknown store is 404', unknown.status === 404, unknown);

  console.log('\n== registration ==');
  // The platform admin this suite already signs in further down, obtained here so
  // the shop-creation calls above have a token. Declared under a distinct name
  // because pToken is used again later in the file.
  const earlyLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  const earlyToken = earlyLogin.data && earlyLogin.data.token;
  const ninaStore = await createStore({
    call, token: earlyToken,
    fields: {
      name: 'Test Coffee', slug: 'testcoffee', contactName: 'Nina',
      contactEmail: 'nina@testcoffee.com', username: 'nina', password: 'ninaowner12345',
    },
  });
  const reg = { status: 201, data: { store: ninaStore, owner: ninaStore.owner } };
  ok('a shop is created for an operator', reg.status === 201, reg);
  ok('and it is live immediately, with nothing to activate', ninaStore.status === 'active', ninaStore);
  ok('no trial is started, because there is no trial', ninaStore.onTrial === false && ninaStore.trialEndsAt === null, ninaStore);
  ok('slug assigned', ninaStore.slug === 'testcoffee', ninaStore);
  ok('the owner account was created with it', ninaStore.owner && ninaStore.owner.username === 'nina', ninaStore.owner);
  const ninaLogin = await call('POST', '/api/auth/login', { body: { username: 'nina', password: 'ninaowner12345' }, store: 'testcoffee' });
  ok('and that owner can sign in', ninaLogin.status === 200, { status: ninaLogin.status, detail: ninaLogin.data });

  const dupe = await call('POST', '/api/platform/stores', {
    body: { name: 'Another', slug: 'testcoffee', activate: true }, token: earlyToken,
  });
  ok('duplicate store id refused', dupe.status === 400 || dupe.status === 409, dupe);

  const blueStore = await createStore({
    call, token: earlyToken,
    fields: { name: 'Blue Spoon Café!', contactName: 'Ann', contactEmail: 'ann@bluespoon.com', username: 'ann', password: 'annowner12345' },
  });
  ok('slug derived from name', blueStore.slug === 'blue-spoon-caf', blueStore);

  // A bad owner password must not leave a half-made store behind.
  const badOwner = await call('POST', '/api/platform/stores', {
    body: {
      name: 'Bad Owner', slug: 'badowner', contactName: 'Zed',
      contactEmail: 'zed@badowner.com', username: 'zed', password: 'short', activate: true,
    },
    token: earlyToken,
  });
  ok('short owner password refused', badOwner.status === 400, badOwner);
  const orphan = await call('GET', '/api/platform/store/badowner');
  ok('refused registration left no store behind', orphan.status === 404, orphan);

  console.log('\n== the public config publishes no prices ==');
  const cfg = await call('GET', '/api/platform/config');

  // This build cannot charge anybody, so publishing a price to a browser would be
  // a number on screen that means nothing. The plan table in db.js stays, because
  // it carries the limits every shop runs under.
  ok('the public config publishes no plan list', cfg.data.plans === undefined, cfg.data.plans);
  ok('and no captcha key, because there is no captcha', cfg.data.recaptchaSiteKey === undefined, cfg.data);
  ok('it still exposes the contact address', typeof cfg.data.contactEmail === 'string' && cfg.data.contactEmail.includes('@'));
  ok('and says plainly that this install has no sign-up',
    cfg.data.registrationOpen === false && cfg.data.trialDays === 0, cfg.data);
  // Comments are stripped before matching. The page carries prose explaining why
  // there is no trial, and a raw text search would flag that explanation as the
  // thing it is explaining the absence of.
  const landingRaw = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'pages', 'Landing.jsx'), 'utf8');
  const landing = landingRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('the landing page carries no price and no plan', !/฿|priceTHB|Plans|per month/.test(landing), 'pricing is still in the page');
  ok('and no trial claim', !/free trial|days free|Start your/i.test(landing), 'a trial claim is still in the page');
  // Matched case-sensitively and whole-word, deliberately. The mock till in the
  // hero card is full of <div className="line ..."> elements, and every spelling
  // of this search that is case-insensitive matches those instead of the hosted
  // copy it is looking for.
  ok('and no hosted-service wording at all',
    !/\bLINE\b|Sign in to your store|Register your store|activation key/.test(landing), 'hosted copy is still in the page');
  // The limits still exist and still have to be sane, they are just not published.
  ok('the plan table still exists in db.js for the limits',
    /PLANS/.test(fs.readFileSync(path.join(__dirname, '..', 'src', 'db.js'), 'utf8')),
    'PLANS missing from db.js');

  console.log('\n== platform admin ==');
  const badPlatform = await call('POST', '/api/platform/login', { body: { username: 'admin', password: 'wrongpass' } });
  ok('platform login rejects bad password', badPlatform.status === 401, badPlatform);
  const pLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  ok('platform login succeeds with the migrated admin', pLogin.status === 200 && !!pLogin.data.token, pLogin);
  const pToken = pLogin.data.token;

  const noAuth = await call('GET', '/api/platform/stores');
  ok('store list needs platform auth', noAuth.status === 401, noAuth);

  const storeList = await call('GET', '/api/platform/stores', { token: pToken });
  ok('store list shows all stores', storeList.status === 200 && storeList.data.stores.length === 3, storeList.data.stores && storeList.data.stores.length);
  const target = storeList.data.stores.find((s) => s.slug === 'testcoffee');

  console.log('\n== store token cannot use the platform ==');
  const existing = await call('POST', '/api/auth/login', { body: { store: 'myrestaurant', username: 'admin', password: PASSWORD } });
  ok('migrated admin can sign in to their store', existing.status === 200 && !!existing.data.token, existing);
  const storeToken = existing.data.token;
  const escalate = await call('GET', '/api/platform/stores', { token: storeToken });
  ok('store token refused on platform API', escalate.status === 403, escalate);
  const escalateStat = await call('GET', '/api/stat/report', { token: storeToken });
  ok('store token refused on the health report', escalateStat.status === 403, escalateStat);
  const escalateStatAnon = await call('GET', '/api/stat/report');
  ok('the health report needs platform auth', escalateStatAnon.status === 401, escalateStatAnon);

  // What the original store holds before a second store exists, so later
  // checks compare like for like instead of assuming a non-empty install.
  const beforeProducts = await call('GET', '/api/products', { token: storeToken, store: 'myrestaurant' });
  const beforeOrders = await call('GET', '/api/orders', { token: storeToken, store: 'myrestaurant' });
  const baseline = {
    products: beforeProducts.status === 200 ? beforeProducts.data.length : 0,
    orders: beforeOrders.status === 200 ? beforeOrders.data.length : 0,
  };

  console.log('\n== a shop with no trial cannot be re-activated by a key ==');
  // The trial is gone from this build, so a shop is either live or waiting for a
  // key and never both. The key path is still exercised below, from the waiting
  // state, which is the only state it can be reached from now.
  const live = await call('GET', '/api/platform/store/testcoffee');
  ok('the shop went live without a key', live.data.store.status === 'active', live.data.store.status);
  ok('and is not on a trial, because there are none',
    live.data.store.onTrial === false && live.data.store.trialEndsAt === null, live.data.store);

  const earlyActivate = await call('POST', '/api/platform/activate', {
    body: { store: 'testcoffee', key: 'ACPR-AAAA-BBBB-CCCC-DDDD', username: 'owner', password: 'longenough123' },
  });
  ok('activating a shop that is already trading is refused', earlyActivate.status === 409, earlyActivate);

  const suspended = await call('POST', `/api/platform/stores/${target.id}/status`, {
    token: pToken, body: { status: 'suspend' },
  });
  ok('the platform can suspend it when the trial runs out', suspended.data.store.status === 'suspended', suspended.data.store);
  ok('and the shop is shut again', (await call('GET', '/api/settings', { store: 'testcoffee' })).status === 403);

  const noKeyYet = await call('POST', `/api/platform/stores/${target.id}/key`, { token: pToken, body: { plan: 'professional' } });
  ok('a key cannot be issued while it is merely suspended', noKeyYet.status === 409, noKeyYet);

  const resumed = await call('POST', `/api/platform/stores/${target.id}/status`, {
    token: pToken, body: { status: 'resume' },
  });
  ok('resuming a shop that never used a key leaves it awaiting activation', resumed.data.store.status === 'pending', resumed.data.store);

  console.log('\n== a store awaiting a key can sign in, but cannot trade ==');
  // The state under test: the owner exists and the password works, but the
  // till is shut. A keyless trial must never be able to reach shop data.
  const pendingLogin = await call('POST', '/api/auth/login', {
    body: { store: 'testcoffee', username: 'nina', password: 'ninaowner12345' },
  });
  ok('awaiting-activation store can sign in', pendingLogin.status === 200 && !!pendingLogin.data.token, pendingLogin);
  ok('sign-in is told activation is required', pendingLogin.data.activationRequired === true, pendingLogin.data);
  ok('sign-in names the contact address', pendingLogin.data.contactEmail === 'you@example.com', pendingLogin.data);
  const pendingToken = pendingLogin.data.token;
  const pendingMe = await call('GET', '/api/auth/me', { store: 'testcoffee', token: pendingToken });
  ok('that session works for /auth/me', pendingMe.status === 200 && pendingMe.data.user.username === 'nina', pendingMe.data);
  const pendingBranch = await call('GET', '/api/branches', { store: 'testcoffee', token: pendingToken });
  ok('branch list is readable before activation', pendingBranch.status === 200 && Array.isArray(pendingBranch.data), pendingBranch.status);
  const pendingTables = await call('GET', '/api/tables', { store: 'testcoffee', token: pendingToken });
  ok('but the shop data is still closed', pendingTables.status === 403 && pendingTables.data.code === 'store_not_active', pendingTables);
  ok('the block explains how to get a key', /you@example\.com/.test(pendingTables.data.detail || ''), pendingTables.data);
  ok('the block tells the app to show activation', pendingTables.data.activationRequired === true, pendingTables.data);
  ok('and no order can be taken', (await call('POST', '/api/orders', { body: { items: [] }, store: 'testcoffee', token: pendingToken })).status === 403);

  const wrongPwPending = await call('POST', '/api/auth/login', {
    body: { store: 'testcoffee', username: 'nina', password: 'definitely-wrong' },
  });
  ok('a wrong password is still refused before activation', wrongPwPending.status === 401, wrongPwPending);

  const issued = await call('POST', `/api/platform/stores/${target.id}/key`, {
    token: pToken, body: { plan: 'professional', planMonths: 12 },
  });
  ok('key issued', issued.status === 200 && /^ACPR-/.test(issued.data.key), issued);
  const key = issued.data.key;

  const wrongKey = await call('POST', '/api/platform/activate', {
    body: { store: 'testcoffee', key: 'ACPR-ZZZZ-ZZZZ-ZZZZ-ZZZZ', username: 'owner', password: 'longenough123' },
  });
  ok('wrong key refused', wrongKey.status === 403, wrongKey);

  const shortPw = await call('POST', '/api/platform/activate', {
    body: { store: 'testcoffee', key, username: 'owner', password: 'short' },
  });
  ok('short password refused', shortPw.status === 400, shortPw);

  const activated = await call('POST', '/api/platform/activate', {
    body: { store: 'testcoffee', key, username: 'nina', password: 'ninaowner12345', ownerName: 'Nina Owner' },
  });
  ok('activation succeeds', activated.status === 200, activated);
  ok('store is active', activated.data.store.status === 'active', activated.data.store);
  ok('plan carried over', activated.data.store.plan === 'professional', activated.data.store);

  const reuse = await call('POST', '/api/platform/activate', {
    body: { store: 'testcoffee', key, username: 'someone', password: 'longenough12345' },
  });
  ok('a used key cannot be reused', reuse.status === 400 || reuse.status === 409, reuse);
  const afterReuse = await call('GET', '/api/platform/stores', { token: pToken });
  const reuseTarget = afterReuse.data.stores.find((s) => s.slug === 'testcoffee');
  ok('reuse attempt created no second owner', reuseTarget.stats.users === 1, reuseTarget.stats);

  console.log('\n== the activated store works ==');
  const ownerLogin = await call('POST', '/api/auth/login', { body: { store: 'testcoffee', username: 'nina', password: 'ninaowner12345' } });
  ok('owner can sign in', ownerLogin.status === 200 && !!ownerLogin.data.token, ownerLogin);
  const ownerToken = ownerLogin.data.token;
  const ownerSettings = await call('GET', '/api/settings', { token: ownerToken, store: 'testcoffee' });
  ok('owner reads own settings', ownerSettings.status === 200, ownerSettings);
  ok('new store brand is its own name', ownerSettings.data.restaurantName === 'Test Coffee', ownerSettings.data.restaurantName);

  console.log('\n== data does not leak between stores ==');
  const ownerProducts = await call('GET', '/api/products', { token: ownerToken, store: 'testcoffee' });
  ok('new store sees no products', ownerProducts.status === 200 && ownerProducts.data.length === 0, ownerProducts.data);

  const legacyProducts = await call('GET', '/api/products', { token: storeToken, store: 'myrestaurant' });
  ok('original store keeps its products', legacyProducts.status === 200 && legacyProducts.data.length === baseline.products, { got: legacyProducts.data.length, expected: baseline.products });

  // Counted, not asserted as non-zero: a fresh install legitimately has no
  // orders, and the point here is that the second store did not change it.
  const legacyOrders = await call('GET', '/api/orders', { token: storeToken, store: 'myrestaurant' });
  ok('original store keeps its orders', legacyOrders.status === 200 && legacyOrders.data.length === baseline.orders, { got: legacyOrders.data.length, expected: baseline.orders });

  console.log('\n== a token is bound to its store ==');
  const crossUse = await call('GET', '/api/products', { token: ownerToken, store: 'myrestaurant' });
  ok("new store's token rejected by the original store", crossUse.status === 401, crossUse);
  const crossUse2 = await call('GET', '/api/products', { token: storeToken, store: 'testcoffee' });
  ok("original store's token rejected by the new store", crossUse2.status === 401, crossUse2);

  console.log('\n== admin data in one store does not touch the other ==');
  const uniqueName = 'Isolation-Probe-Table';
  const newTable = await call('POST', '/api/tables', { token: ownerToken, store: 'testcoffee', body: { name: uniqueName, seats: 4 } });
  ok('table created in the new store', newTable.status === 200 || newTable.status === 201, newTable);
  const legacyTables = await call('GET', '/api/tables', { token: storeToken, store: 'myrestaurant' });
  ok('original store did not gain that table', !legacyTables.data.some((tb) => tb.name === uniqueName), legacyTables.data.map((x) => x.name));
  const newTables = await call('GET', '/api/tables', { token: ownerToken, store: 'testcoffee' });
  ok('the new store has only its own table', newTables.data.length === 1 && newTables.data[0].name === uniqueName, newTables.data);
  const legacyCountBefore = legacyTables.data.length;
  const del = await call('DELETE', `/api/tables/${newTable.data.id}`, { token: ownerToken, store: 'testcoffee' });
  ok('table deleted in the new store', del.status === 200 || del.status === 204, del);
  const legacyAfter = await call('GET', '/api/tables', { token: storeToken, store: 'myrestaurant' });
  ok('original store table count unchanged', legacyAfter.data.length === legacyCountBefore, { before: legacyCountBefore, after: legacyAfter.data.length });

  console.log('\n== legacy QR links still resolve ==');
  const sessions = await call('GET', '/api/sessions/active', { token: storeToken, store: 'myrestaurant' });
  ok('active sessions readable', sessions.status === 200, sessions.status);
  const anySession = Array.isArray(sessions.data) ? sessions.data[0] : null;
  if (anySession) {
    const menuNoHeader = await call('GET', `/api/public/menu?token=${encodeURIComponent(anySession.token)}`);
    ok('menu resolves the store from the QR token alone', menuNoHeader.status === 200, menuNoHeader.status);
  } else {
    ok('menu resolves the store from the QR token alone (no session to test)', true);
  }

  console.log('\n== suspension ==');
  const suspend = await call('POST', `/api/platform/stores/${target.id}/status`, { token: pToken, body: { status: 'suspend' } });
  ok('suspend works', suspend.status === 200 && suspend.data.store.status === 'suspended', suspend);
  const blocked = await call('GET', '/api/settings', { token: ownerToken, store: 'testcoffee' });
  ok('suspended store is locked out', blocked.status === 403 && blocked.data.code === 'store_suspended', blocked);
  // Suspension must close sign-in too, not just the API: otherwise a suspended
  // shop could still sign in and be told it merely needs activating.
  const suspendedLogin = await call('POST', '/api/auth/login', {
    body: { store: 'testcoffee', username: 'nina', password: 'ninaowner12345' },
  });
  ok('a suspended store cannot sign in at all', suspendedLogin.status === 403 && suspendedLogin.data.code === 'store_suspended', suspendedLogin);
  ok('the refusal gives a way forward', /you@example\.com/.test(suspendedLogin.data.message || ''), suspendedLogin.data.message);
  const resume = await call('POST', `/api/platform/stores/${target.id}/status`, { token: pToken, body: { status: 'resume' } });
  ok('resume restores the store', resume.data.store.status === 'active', resume);
  const backIn = await call('GET', '/api/settings', { token: ownerToken, store: 'testcoffee' });
  ok('resumed store works again', backIn.status === 200, backIn.status);

  console.log('\n== an admin can create a store by hand ==');
  const created = await call('POST', '/api/platform/stores', {
    token: pToken,
    body: { name: 'Riverside Branch', slug: 'riverside', plan: 'enterprise', activate: true, contactName: 'River Owner' },
  });
  ok('admin created a store', created.status === 201, created);
  ok('it is live straight away', created.data.store.status === 'active', created.data.store);
  ok('its ID is the slug', created.data.store.slug === 'riverside', created.data.store);
  const dupeCreated = await call('POST', '/api/platform/stores', {
    token: pToken, body: { name: 'Clash', slug: 'riverside' },
  });
  ok('admin cannot reuse a store ID', dupeCreated.status === 409, dupeCreated);
  const noAdmin = await call('POST', '/api/platform/stores', { body: { name: 'Sneaky', slug: 'sneaky' } });
  ok('creating a store needs platform auth', noAdmin.status === 401, noAdmin);

  console.log('\n== admin can see and delete any store ==');
  const allActive = await call('GET', '/api/platform/stores', { token: pToken });
  const activeOnes = allActive.data.stores.filter((s) => s.status === 'active');
  ok('the console lists every active store', activeOnes.length >= 2, activeOnes.map((s) => s.slug));

  const noConfirm = await call('DELETE', '/api/platform/stores/' + created.data.store.id, { token: pToken });
  ok('deleting without confirmation is refused', noConfirm.status === 409 && noConfirm.data.code === 'confirmation_required', noConfirm);
  ok('the refusal says what would be lost', /order|product|table/i.test(noConfirm.data.detail || ''), noConfirm.data.detail);
  ok('the store still exists after a refused delete', (await call('GET', '/api/platform/store/riverside')).data.store.slug === 'riverside');

  const wrongConfirm = await call('DELETE', `/api/platform/stores/${created.data.store.id}?confirm=not-the-slug`, { token: pToken });
  ok('a wrong confirmation slug is refused', wrongConfirm.status === 409, wrongConfirm);

  const deleted = await call('DELETE', `/api/platform/stores/${created.data.store.id}?confirm=riverside`, { token: pToken });
  ok('a confirmed delete removes the store', deleted.status === 200 && deleted.data.action === 'deleted', deleted);
  ok('the deleted store is gone', (await call('GET', '/api/platform/store/riverside')).status === 404);
  const stillThere = await call('GET', '/api/platform/store/testcoffee');
  ok('deleting one store left the other alone', stillThere.data.store.status === 'active', stillThere.data.store);

  const storeListFinal = await call('GET', '/api/platform/stores', { token: pToken });
  ok('the original store is still listed', storeListFinal.data.stores.some((s) => s.slug === 'myrestaurant'), storeListFinal.data.stores.map((s) => s.slug));

  console.log('\n== a bogus sign-up can be rejected ==');
  const junkStore = await createStore({
    call, token: earlyToken,
    fields: { name: 'Spam Shop', slug: 'spamshop', contactName: 'Bot', contactEmail: 'bot@spamshop.com', username: 'junkowner', password: 'longenough12345' },
  });
  const junk = { status: 201, data: { store: junkStore } };
  ok('a junk shop is created first', junk.status === 201, junk);
  const junkId = junk.data.store.id;
  // ?action=suspend keeps the records and just closes the shop, which is the
  // right move for a sign-up that should not go ahead.
  const delJunk = await call('DELETE', `/api/platform/stores/${junkId}?action=suspend`, { token: pToken });
  ok('a rejected sign-up is suspended, not erased', delJunk.status === 200 && delJunk.data.store.status === 'suspended', delJunk);
  const junkLogin = await call('POST', '/api/auth/login', { body: { store: 'spamshop', username: 'x', password: 'yyyyyyyyyyyy' } });
  ok('a rejected store is refused at the door', junkLogin.status === 403 && junkLogin.data.code === 'store_suspended', junkLogin);
  const junkApi = await call('GET', '/api/settings', { store: 'spamshop' });
  ok('a rejected store API is closed', junkApi.status === 403 && junkApi.data.code === 'store_suspended', junkApi);

  // Even a never-activated store needs the typed confirmation before it goes.
  const delNoConfirm = await call('DELETE', `/api/platform/stores/${junkId}`, { token: pToken });
  ok('deleting a rejected store still needs confirmation', delNoConfirm.status === 409, delNoConfirm);
  ok('the rejected store survived that', (await call('GET', '/api/platform/store/spamshop')).data.store.status === 'suspended');

  console.log('\n== a sign-up that already went live can still be rejected ==');
  // A trial shop is switched on at verification, so a junk sign-up that answered
  // its code is trading by the time anyone looks at it. This is the case the console had no button
  // for, and the one that must not quietly skip the audit entry.
  const liveJunkStore = await createStore({
    call, token: earlyToken,
    fields: {
      name: 'Live Junk', slug: 'livejunk', contactName: 'Bot', contactEmail: 'bot2@livejunk.com',
      username: 'junkowner2', password: 'longenough12345',
    },
  });
  const liveJunk = { status: 201, data: { store: liveJunkStore } };
  ok('it is live, with no key and nothing to wait for',
    liveJunk.data.store.status === 'active' && liveJunk.data.trial !== true, liveJunk.data.store);

  // A key is only meaningful for a shop that is still waiting, and this one is
  // not, so this is the refusal that proves the two states stay distinct.
  const keyFirst = await call('POST', `/api/platform/stores/${liveJunk.data.store.id}/key`, { token: pToken, body: { plan: 'starter' } });
  ok('a key is refused for a shop that is already live', keyFirst.status === 409, keyFirst.status);

  const rejectLive = await call('DELETE', `/api/platform/stores/${liveJunk.data.store.id}?action=suspend&reason=${encodeURIComponent('duplicate of spamshop')}`, { token: pToken });
  ok('it can be rejected', rejectLive.status === 200 && rejectLive.data.store.status === 'suspended', rejectLive);
  ok('and is reported as rejected, not merely paused', rejectLive.data.action === 'rejected', rejectLive.data.action);
  ok('the key is cleared, so it cannot be walked back in', rejectLive.data.store.hasKey !== true, rejectLive.data.store.hasKey);
  ok('its owner is refused at the door', (await call('POST', '/api/auth/login', {
    body: { store: 'livejunk', username: 'junkowner', password: 'longenough12345' },
  })).status === 403);
  ok('and its data is still there, not erased', (await call('GET', '/api/platform/store/livejunk')).status === 200);

  // The reason has to be readable afterwards, or a refusal is just a shrug.
  // The store list is the authenticated view; publicStore deliberately omits
  // the note so the waiting screen cannot leak it to a signed-out visitor.
  const afterReject = await call('GET', '/api/platform/stores', { token: pToken });
  const rejectedRow = afterReject.data.stores.find((s) => s.slug === 'livejunk');
  ok('the reason is on the store, for the admin to read', /duplicate of spamshop/.test(rejectedRow.note || ''), rejectedRow.note);
  ok('and it names who did it', /rejected by platform admin/i.test(rejectedRow.note || ''), rejectedRow.note);
  ok('the rejected shop is still listed rather than vanishing', !!rejectedRow, afterReject.data.stores.map((s) => s.slug));
  const anonNote = await call('GET', '/api/platform/store/livejunk');
  ok('but a signed-out visitor is not shown the note', anonNote.data.store.note === undefined, anonNote.data.store.note);

  console.log('\n== rejecting needs platform auth, like every other admin action ==');
  const noAuthReject = await call('DELETE', `/api/platform/stores/${junkId}?action=suspend`);
  ok('a store token cannot reject a shop', noAuthReject.status === 401 || noAuthReject.status === 403, noAuthReject.status);

  // Counted here rather than hardcoded further down, so adding a store to a
  // test above does not quietly turn into a restart failure.
  const storesBeforeRestart = (await call('GET', '/api/platform/stores', { token: pToken })).data.stores.length;

  console.log('\n== persistence across a restart ==');
  killAll();
  await new Promise((r) => setTimeout(r, 800));
  const second = launch();
  let log2 = '';
  second.child.stdout.on('data', (d) => { log2 += d; });
  second.child.stderr.on('data', (d) => { log2 += d; });
  let up = false;
  for (let i = 0; i < 60; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  ok('server restarts', up, log2);
  if (up) {
    const afterRestart = await call('POST', '/api/auth/login', { body: { store: 'testcoffee', username: 'nina', password: 'ninaowner12345' } });
    ok('activated store survives a restart', afterRestart.status === 200, afterRestart);
    const list2 = await call('GET', '/api/platform/stores', { token: pToken });
    ok('all stores survive a restart', list2.status === 200 && list2.data.stores.length === storesBeforeRestart,
      { got: list2.data.stores && list2.data.stores.length, expected: storesBeforeRestart });
    ok('and the rejected one is still refused, not resurrected', (await call('POST', '/api/auth/login', {
      body: { store: 'livejunk', username: 'junkowner', password: 'longenough12345' },
    })).status === 403);
    const legacyAgain = await call('GET', '/api/products', { token: storeToken, store: 'myrestaurant' });
    ok('original store data intact after restart', legacyAgain.status === 200 && legacyAgain.data.length === baseline.products, { got: legacyAgain.data.length, expected: baseline.products });
    const emptyAgain = await call('GET', '/api/products', { token: afterRestart.data.token, store: 'testcoffee' });
    ok('new store still isolated after restart', emptyAgain.status === 200 && emptyAgain.data.length === 0, emptyAgain.data && emptyAgain.data.length);
  }
  killAll();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (serverLog.includes('Error:') || log2.includes('Error:')) {
    console.log('\n--- server log had errors ---');
    console.log((serverLog + log2).split('\n').filter((l) => /Error|error/.test(l)).slice(0, 20).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
