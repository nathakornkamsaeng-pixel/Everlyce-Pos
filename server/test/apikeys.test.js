// Store API keys and the /api/v1 integration surface.
//
// The point of this test is the negative cases. It is easy to add a key system
// that works; the risk is that something reachable without one, or reachable
// with the wrong store's key, or reachable with a browser session that should
// not work either.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const { isolatedData } = require('./helpers/isolated-data');
const { createStore } = require('./helpers/create-store');
const DATA_DIR = isolatedData();
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const STORE = process.env.TEST_STORE || 'myrestaurant';
const OTHER = 'other-cafe';
const PORT = Number(process.env.TEST_PORT || 19300);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

// Started before the first spawn so the process under test finds a working
// mailbox at boot, which it verifies and logs a line about.
function shutdown() { killAll(); }
const children = new Set();
function launch() {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      POS_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      POS_DEFAULT_STORE_SLUG: STORE,
      POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: PASSWORD,
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      },
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
process.on('exit', shutdown);
process.on('uncaughtException', (e) => { console.error(e); shutdown(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); shutdown(); process.exit(1); });

const child = launch();
let serverLog = '';
child.child.stdout.on('data', (d) => { serverLog += d; });
child.child.stderr.on('data', (d) => { serverLog += d; });

async function call(method, p, { body, token, store, key, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (store) h['X-POS-Store'] = store;
  if (key) h.Authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, text, ct: res.headers.get('content-type') };
}

(async () => {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const login = await call('POST', '/api/auth/login', { body: { store: STORE, username: 'admin', password: PASSWORD }, store: STORE });
  const T = login.data && login.data.token;
  ok('the seeded store can sign in', login.status === 200 && !!T, login.status);

  // Seed something worth reading back.
  const cat = await call('POST', '/api/categories', { body: { name: 'Coffee' }, token: T, store: STORE });
  const prod = await call('POST', '/api/products', {
    body: { name: 'Latte', price: 90, categoryId: cat.data && cat.data.id, cost: 30 },
    token: T, store: STORE,
  });
  const productId = prod.data && prod.data.id;
  ok('there is a product to integrate with', !!productId, prod.data);

  console.log('\n== the integration API is not anonymous ==');
  ok('no key at all is refused', (await call('GET', '/api/v1/catalog')).status === 401);
  ok('a junk key is refused', (await call('GET', '/api/v1/catalog', { key: 'evk_1_nonsense' })).status === 401);
  ok('a key of the wrong shape is refused', (await call('GET', '/api/v1/catalog', { key: 'sk-live-abcdefghijklmnopqrstuvwxyz' })).status === 401);
  const staffJwt = await call('GET', '/api/v1/catalog', { token: T, store: STORE });
  ok('a signed-in staff session is refused on the integration API', staffJwt.status === 401, staffJwt.status);
  ok('a browser cookie cannot stand in for a key', (await call('GET', '/api/v1/catalog', { headers: { Cookie: `pos_session=${T}` } })).status === 401);
  const withStoreHeader = await call('GET', '/api/v1/catalog', { store: STORE });
  ok('a store header alone is refused', withStoreHeader.status === 401, withStoreHeader.status);

  console.log('\n== keys are only minted by an admin ==');
  const noAuth = await call('GET', '/api/api-keys', { store: STORE });
  ok('listing keys needs a sign-in', noAuth.status === 401, noAuth.status);
  const badScope = await call('POST', '/api/api-keys', { body: { label: 'x', scopes: ['everything'] }, token: T, store: STORE });
  ok('an unknown scope is rejected', badScope.status === 400, badScope.status);
  const noScope = await call('POST', '/api/api-keys', { body: { label: 'x', scopes: [] }, token: T, store: STORE });
  ok('a key with no scope is rejected', noScope.status === 400, noScope.status);

  const readKey = await call('POST', '/api/api-keys', {
    body: { label: 'Dashboard', scopes: ['catalog:read', 'orders:read'] },
    token: T, store: STORE,
  });
  const readKeyValue = readKey.data && readKey.data.key;
  ok('an admin can mint a read key', readKey.status === 201 && /^evk_\d+_/.test(String(readKeyValue)), readKey.data);

  const list = await call('GET', '/api/api-keys', { token: T, store: STORE });
  ok('the key list never contains the secret', !JSON.stringify(list.data).includes(readKeyValue), 'secret leaked in the list');
  ok('the key list never contains the hash', !/"hash"/.test(JSON.stringify(list.data)), 'hash leaked in the list');
  ok('the list shows the label and prefix', list.data.keys.some((k) => k.label === 'Dashboard' && /^evk_/.test(k.prefix)), list.data.keys);

  console.log('\n== scopes are enforced ==');
  ok('a read key reads the catalog', (await call('GET', '/api/v1/catalog', { key: readKeyValue })).status === 200);
  const createWithRead = await call('POST', '/api/v1/orders', {
    body: { items: [{ productId, quantity: 1 }] }, key: readKeyValue,
  });
  ok('a read-only key cannot create an order', createWithRead.status === 403, createWithRead.status);
  const readOrdersNoScope = await call('POST', '/api/api-keys', {
    body: { label: 'Catalog only', scopes: ['catalog:read'] }, token: T, store: STORE,
  });
  const catalogOnly = readOrdersNoScope.data.key;
  ok('a catalog-only key cannot read orders',
    (await call('GET', '/api/v1/orders', { key: catalogOnly })).status === 403);
  ok('a catalog-only key can read the catalog',
    (await call('GET', '/api/v1/catalog', { key: catalogOnly })).status === 200);

  console.log('\n== the catalog is real ==');
  const cat1 = await call('GET', '/api/v1/catalog?lang=en', { key: readKeyValue });
  ok('the catalog returns the seeded product', cat1.data.products.some((p) => Number(p.id) === Number(productId)), cat1.data.products);
  ok('the catalog does not leak password hashes', !/"passwordHash"|\$2[aby]\$/.test(cat1.text), 'hash in the catalog');
  ok('the catalog does not leak staff records', !/"users"|"pinHash"/.test(cat1.text), 'user data in the catalog');
  ok('the catalog is scoped to one store', typeof cat1.data.store.slug === 'string' && cat1.data.store.slug === STORE, cat1.data.store);

  console.log('\n== a write key can push an order in ==');
  const writeKey = (await call('POST', '/api/api-keys', {
    body: { label: 'Delivery partner', scopes: ['orders:read', 'orders:write'] }, token: T, store: STORE,
  })).data.key;
  const created = await call('POST', '/api/v1/orders', {
    body: { items: [{ productId, quantity: 2 }], orderType: 'delivery', notes: 'via API' },
    key: writeKey,
  });
  ok('the order is created', created.status === 201 && !!created.data.order.orderNumber, created.data);
  ok('the line price comes from the catalogue', Number(created.data.order.items[0].unitPrice) === 90, created.data.order.items);
  const priceProbe = await call('POST', '/api/v1/orders', {
    body: { items: [{ productId, quantity: 1, unitPrice: 1, price: 1, total: 1 }], orderType: 'takeaway' },
    key: writeKey,
  });
  ok('a payload cannot set its own price', Number(priceProbe.data.order.items[0].unitPrice) === 90 && Number(priceProbe.data.order.subtotal) === 90, priceProbe.data.order);
  ok('a dine-in order without a table is refused', (await call('POST', '/api/v1/orders', {
    body: { items: [{ productId, quantity: 1 }], orderType: 'dine_in' }, key: writeKey,
  })).status === 400);
  ok('an unknown product is refused', (await call('POST', '/api/v1/orders', {
    body: { items: [{ productId: 999999, quantity: 1 }] }, key: writeKey,
  })).status === 400);
  ok('an empty order is refused', (await call('POST', '/api/v1/orders', { body: { items: [] }, key: writeKey })).status === 400);
  const readBack = await call('GET', `/api/v1/orders/${created.data.order.orderNumber}`, { key: readKeyValue });
  ok('the order can be read back by number', readBack.status === 200 && readBack.data.order.id === created.data.order.id, readBack.status);
  ok('a missing order is a 404', (await call('GET', '/api/v1/orders/ORD-nope', { key: readKeyValue })).status === 404);

  console.log('\n== a key cannot reach another store ==');
  // A second store on the same install, so this is a real cross-tenant test.
  const otherLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  const otherStore = await createStore({
    call, token: otherLogin.data && otherLogin.data.token,
    fields: { name: 'Other Cafe', contactName: 'Owner', contactEmail: 'owner@othercafe.com', username: 'owner2', password: PASSWORD, slug: OTHER },
  });
  const registered = { status: 201, data: { store: otherStore } };
  const pending = otherStore.slug;
  ok('a second store exists to test against', !!pending, otherStore);

  if (pending) {
    const platformLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
    const PT = platformLogin.data && platformLogin.data.token;
    const otherRecord = (await call('GET', '/api/platform/stores', { token: PT })).data.stores
      .find((x) => x.slug === pending);

    // The second shop was created already active, so it is not waiting for a key
    // and must refuse one. What the suite is really testing is that an API key
    // minted here reads that shop's own catalog and not the first shop's, so the
    // shop is left live and the isolation is checked directly.
    const keyIssued = await call('POST', `/api/platform/stores/${otherRecord.id}/key`, { token: PT, body: { plan: 'professional', planMonths: 1 } });
    ok('a key is refused for a shop that is already live', keyIssued.status === 409, keyIssued.status);

    const crossCatalog = await call('GET', '/api/v1/catalog', { key: readKeyValue });
    ok("the first store's key still reads its own menu",
      crossCatalog.data.products.some((p) => Number(p.id) === Number(productId)),
      crossCatalog.data.products.length);
    const otherLogin = await call('POST', '/api/auth/login', { body: { store: pending, username: 'owner2', password: PASSWORD }, store: pending });
    const OT = otherLogin.data && otherLogin.data.token;
    const otherKey = (await call('POST', '/api/api-keys', {
      body: { label: 'Other key', scopes: ['orders:read', 'catalog:read'] }, token: OT, store: pending,
    })).data.key;
    const otherCatalog = await call('GET', '/api/v1/catalog', { key: otherKey });
    ok("the other store's key does not see the first store's menu",
      !otherCatalog.data.products.some((p) => Number(p.id) === Number(productId)),
      otherCatalog.data.products.length);
    ok("the other store's catalog reports its own slug", otherCatalog.data.store.slug === pending, otherCatalog.data.store);
    const otherSees = await call('GET', '/api/v1/orders', { key: otherKey });
    ok('the other store cannot see the first store orders', otherSees.data.orders.length === 0, otherSees.data.orders);
    ok("a store's own key cannot read the other store", (await call('GET', `/api/v1/orders/${created.data.order.orderNumber}`, { key: otherKey })).status === 404);
    ok("a store header cannot redirect a key to another store",
      (await call('GET', '/api/v1/orders', { key: otherKey, store: STORE })).data.orders.length === 0);
  }

  console.log('\n== revocation takes effect at once ==');
  const doomed = (await call('POST', '/api/api-keys', {
    body: { label: 'Doomed', scopes: ['catalog:read'] }, token: T, store: STORE,
  })).data;
  ok('a fresh key works', (await call('GET', '/api/v1/catalog', { key: doomed.key })).status === 200);
  const revoked = await call('DELETE', `/api/api-keys/${doomed.record.id}`, { token: T, store: STORE });
  ok('a key can be revoked', revoked.status === 200 && !!revoked.data.key.revokedAt, revoked.data);
  ok('a revoked key stops working immediately', (await call('GET', '/api/v1/catalog', { key: doomed.key })).status === 401);
  ok('a revoked key cannot be revoked twice', (await call('DELETE', `/api/api-keys/${doomed.record.id}`, { token: T, store: STORE })).status === 409);

  console.log('\n== the public surface leaks nothing ==');
  const live = await fetch(`${BASE}/api/health`);
  const liveBody = await live.text();
  ok('liveness does not report the store count', !/"stores"/.test(liveBody), liveBody);
  const publicStat = await call('GET', '/api/stat/health');
  ok('public health reports no store count', publicStat.data.stores === undefined, publicStat.data);
  ok('public health reports no row count', publicStat.data.rows === undefined, publicStat.data);
  ok('public health still reports the verdict for monitoring',
    publicStat.data.ok !== undefined && publicStat.data.status !== undefined, publicStat.data);
  ok('the integration API is not listed by the catch-all', (await call('GET', '/api/v1/nope', { key: readKeyValue })).status === 404);

  console.log('\n== the shop pages are reachable at the root of the host ==');
  // The shop is at /, not /{shop}. These used to be redirected into the store,
  // which is how a single-shop install worked before the app was mounted at the
  // root. Redirecting them now would bounce a guest to a path the app no longer
  // routes, so each one has to be served where it is.
  for (const page of ['/integrations', '/settings', '/login', '/orders', '/tables', '/checkout', '/kds']) {
    const r = await fetch(`${BASE}${page}`, { redirect: 'manual' });
    ok(`${page} is served, not redirected`, r.status === 200, `${r.status} ${r.headers.get('location')}`);
  }
  // The prefixed form still works, because every QR code printed before this
  // change carries the shop's name.
  const prefixed = await fetch(`${BASE}/shop/${STORE}/login`, { redirect: 'manual' });
  ok('and the old prefixed form still works for old QR codes', prefixed.status === 200, prefixed.status);

  console.log('\n== the privacy notice is readable without signing in ==');
  const anonNotice = await call('GET', '/api/public/privacy-notice');
  ok('a stranger can read the notice', anonNotice.status === 200, anonNotice.status);
  ok('the notice names a controller', !!(anonNotice.data.controller && anonNotice.data.controller.legalName), anonNotice.data.controller);
  ok('the notice lists the rights', Array.isArray(anonNotice.data.rights) && anonNotice.data.rights.length >= 4, anonNotice.data.rights);
  const noHeaderNotice = await call('GET', '/api/public/privacy-notice', { store: STORE });
  ok('it works when a store header happens to be sent', noHeaderNotice.status === 200, noHeaderNotice.status);

  console.log('\n== it is rate limited ==');
  let limited = false;
  for (let i = 0; i < 400; i += 1) {
    const r = await call('GET', '/api/v1/catalog', { key: readKeyValue });
    if (r.status === 429) { limited = true; break; }
  }
  ok('a key that hammers the API is cut off', limited, 'never limited');

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error:/.test(serverLog)) {
    console.log('\n--- server log errors ---');
    console.log(serverLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 8).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
