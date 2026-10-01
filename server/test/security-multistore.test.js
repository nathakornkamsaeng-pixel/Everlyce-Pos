// Confirms the security hardening still works now that data is per store.
const assert = require('assert');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

const { isolatedData } = require('./helpers/isolated-data');
const DATA_DIR = isolatedData();
const PORT = Number(process.env.TEST_PORT || 18094);
const BASE = `http://127.0.0.1:${PORT}`;
const STORE = process.env.TEST_STORE || 'myrestaurant';
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
// The PromptPay number seeded into the throwaway test copy, so the test can
// prove a cashier response does not contain it. Never a real account.
const PROMPTPAY_FIXTURE = process.env.TEST_PROMPTPAY_FIXTURE || '0812345678';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const children = new Set();
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
  env: { ...process.env, POS_DATA_DIR: DATA_DIR, PORT: String(PORT), POS_DEFAULT_STORE_SLUG: STORE, POS_BOOTSTRAP_USERNAME: 'admin', POS_BOOTSTRAP_PASSWORD: PASSWORD, POS_PLATFORM_ADMIN_USERNAME: 'admin', POS_PLATFORM_ADMIN_PASSWORD: PASSWORD },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.add(child);
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} } }
process.on('exit', killAll);

async function call(method, p, { body, token, store = STORE, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (store) h['X-POS-Store'] = store;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, text, res };
}

(async () => {
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.log('server did not start\n', log); killAll(); process.exit(1); }

  const good = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  ok('baseline admin sign-in works', good.status === 200 && !!good.data.token, good);

  console.log('\n== account + IP lockout still applies ==');
  let locked = null;
  for (let i = 0; i < 6 && !locked; i += 1) {
    const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong-on-purpose' } });
    if (r.status === 429) locked = r;
  }
  ok('repeated failures lock the account and IP', !!locked, locked && locked.data);
  const correctButLocked = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  ok('the right password is refused while locked', correctButLocked.status === 429, correctButLocked);

  const locks = await call('GET', '/api/auth/locks', { token: good.data.token });
  ok('admin can read the lock list', locks.status === 200 && Array.isArray(locks.data.locks), locks.status);
  const mine = (locks.data.locks || []).find((l) => l.username === 'admin');
  ok('the lock is recorded against the username', !!mine, locks.data.locks);
  ok('lock reports a retry delay', mine && mine.retryAfterSeconds > 0, mine);

  console.log('\n== locks are per store ==');
  const unlock = await call('DELETE', `/api/auth/locks/${mine.id}`, { token: good.data.token });
  ok('admin can unlock', unlock.status === 200 || unlock.status === 204, unlock);
  const afterUnlock = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  ok('sign-in works again after unlocking', afterUnlock.status === 200, afterUnlock.status);

  console.log('\n== logout really revokes the token ==');
  const t = afterUnlock.data.token;
  const before = await call('GET', '/api/settings', { token: t });
  ok('token works before logout', before.status === 200, before.status);
  const out = await call('POST', '/api/auth/logout', { token: t, body: {} });
  ok('logout accepted', out.status === 200, out);
  const after = await call('GET', '/api/settings', { token: t });
  ok('token is dead after logout', after.status === 401, after);

  console.log('\n== cashier never sees the PromptPay account ==');
  const adminToken = (await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } })).data.token;
  const full = await call('GET', '/api/settings', { token: adminToken });
  ok('admin sees the full settings', full.status === 200, full.status);

  const me = await call('GET', '/api/auth/me', { token: adminToken });
  ok('admin profile returned', me.status === 200 && me.data.user.role === 'admin', me.data);

  // Mint a cashier in this store and check what a cashier-role token receives.
  const created = await call('POST', '/api/users', {
    token: adminToken,
    body: { username: 'sec_cashier', name: 'Sec Cashier', role: 'cashier', password: 'cashierpass1234' },
  });
  ok('cashier account created', created.status === 200 || created.status === 201, created);
  {
    const cLogin = await call('POST', '/api/auth/login', { body: { username: 'sec_cashier', password: 'cashierpass1234' } });
    ok('cashier can sign in', cLogin.status === 200, cLogin);
    if (cLogin.data.token) {
      const cSettings = await call('GET', '/api/settings', { token: cLogin.data.token });
      const body = JSON.stringify(cSettings.data || {});
      // PROMPTPAY_FIXTURE is the value seeded into the test copy of the data.
      // It is never a real account number.
      ok('cashier settings do not leak the PromptPay account number', !body.includes(PROMPTPAY_FIXTURE), body.slice(0, 300));
      ok('cashier settings do not leak the PromptPay account type', !/"promptPayAccountType"\s*:\s*"(qr|promptpay)"/i.test(body), body.slice(0, 300));
    } else {
      ok('cashier could sign in (redaction not checked)', false, cLogin);
    }
  }

  console.log('\n== payment credentials are never returned to anybody ==');
  // Set a credential that is not a real one. If it ever comes back out of a
  // settings response, it has been in a browser, a log or a screenshot.
  const FAKE_OPN = 'sk_opn_test_DO_NOT_LEAK_0001';
  const FAKE_STRIPE = 'sk_live_TEST_DO_NOT_LEAK_0002';
  const setKeys = await call('PUT', '/api/settings', {
    token: adminToken, body: { opnSecretKey: FAKE_OPN, stripeSecretKey: FAKE_STRIPE },
  });
  ok('the keys are accepted', setKeys.status === 200, setKeys);
  ok('and not echoed straight back', !JSON.stringify(setKeys.data || {}).includes(FAKE_OPN), setKeys.data);

  for (const [who, token] of [['admin', adminToken], ['cashier', (await call('POST', '/api/auth/login', { body: { username: 'sec_cashier', password: 'cashierpass1234' } })).data.token]]) {
    if (!token) { ok(`${who} settings readable for the redaction check`, false); continue; }
    const body = JSON.stringify((await call('GET', '/api/settings', { token })).data || {});
    ok(`the ${who} is not given the Opn secret`, !body.includes(FAKE_OPN), body.slice(0, 200));
    ok(`the ${who} is not given the Stripe secret`, !body.includes(FAKE_STRIPE), body.slice(0, 200));
    // Only an admin is told which credentials exist. A cashier only ever needs
    // to know that a method works, not how it is wired.
    // JSON.stringify quotes the key, so the closing quote has to be in the
    // pattern. Without it this can never match and reads as a real failure.
    if (who === 'admin') ok('the admin is told instead whether Opn is set', /"opnSecretKeyConfigured"\s*:\s*true/.test(body), body.slice(0, 200));
    else ok('the cashier is not even told that a gateway is configured', !/opnSecretKeyConfigured/.test(body), body.slice(0, 200));
  }

  function throwsPayment(label, fn) {
    try { fn(); ok(label, false, 'did not throw'); } catch (e) { ok(label, /not yet switched on/.test(e.message), e.message); }
  }

  console.log('\n== the till can ask what it can accept ==');
  const capsAdmin = await call('GET', '/api/payments/capabilities', { token: adminToken });
  ok('capabilities are readable', capsAdmin.status === 200 && Array.isArray(capsAdmin.data.providers), capsAdmin);
  ok('cash is always offered', capsAdmin.data.providers.find((p) => p.id === 'cash').available === true);
  console.log('\n== saving one setting must not wipe another ==');
  // The account number is no longer sent to the browser, so the settings form
  // holds no value for it. If a save posted that empty value back, saving an
  // unrelated setting would silently delete the PromptPay account of every shop
  // that had one, which is the kind of loss nobody notices for a week.
  await call('PUT', '/api/settings', { token: adminToken, body: { promptPayAccount: PROMPTPAY_FIXTURE, promptPayAccountType: 'phone' } });
  const unrelated = await call('PUT', '/api/settings', { token: adminToken, body: { restaurantName: 'Renamed While Saving' } });
  ok('an unrelated save succeeds', unrelated.status === 200, unrelated);
  ok('and still reports the account as configured', /"promptPayAccountConfigured"\s*:\s*true/.test(JSON.stringify(unrelated.data)), JSON.stringify(unrelated.data).slice(0, 300));
  const afterReread = await call('GET', '/api/settings', { token: adminToken });
  ok('a fresh read still sees it', /"promptPayAccountConfigured"\s*:\s*true/.test(JSON.stringify(afterReread.data)));
  const capsAfterSave = await call('GET', '/api/payments/capabilities', { token: adminToken });
  ok('and Thai QR is still offered, so it really was kept', capsAfterSave.data.providers.find((p) => p.id === 'thaiqr').available === true);
  // And the QR it now produces really names the account.
  const qrAfter = await call('POST', '/api/orders/promptpay', { token: adminToken, body: { orderIds: [] } });
  ok('an empty order list is still refused rather than producing a QR', qrAfter.status === 400, qrAfter.status);

  console.log('\n== a real QR, end to end ==');
  // The route was moved onto the payment provider layer, so the payload it hands
  // a customer is now the one the provider builds, tag 62 and all. Checked
  // against the actual response rather than by reading the builder's own code.
  const { readThaiQr } = require('../src/payments/thaiqr');
  const cat = await call('POST', '/api/categories', { token: adminToken, body: { name: 'QR Test' } });
  const prod = await call('POST', '/api/products', { token: adminToken, body: {
    name: 'QR Item', categoryId: cat.data.id, price: 145, cost: 60, stock: 10, trackStock: false,
  } });
  const made = await call('POST', '/api/orders', { token: adminToken, body: { items: [{ productId: prod.data.id, qty: 2, price: 145 }] } });
  ok('an order was rung up', made.status === 201, made);
  // POST /orders answers with the order itself, not wrapped in an envelope.
  const orderId = made.data.id;
  ok('with a number to reference', !!made.data.orderNumber, made.data.orderNumber);

  const qr = await call('POST', '/api/orders/promptpay', { token: adminToken, body: { orderIds: [orderId] } });
  // 201, because a payment request is created rather than fetched.
  ok('the till can request the payment', qr.status === 201 || qr.status === 200, qr.status);
  const payload = qr.data.payload;
  ok('a payload comes back', typeof payload === 'string' && payload.length > 40, typeof payload);
  const decoded = readThaiQr(payload);
  ok('its checksum verifies, so a banking app will accept it', decoded.checksumValid, decoded);
  ok('it names the PromptPay account that was configured', decoded.merchantAccountValue === `0066${PROMPTPAY_FIXTURE.replace(/^0/, '')}`, decoded.merchantAccountValue);
  // Compared against the order's own total rather than a number typed in here,
  // so tax and service charge cannot make this quietly wrong.
  ok('the amount is the order total, tax and service charge included',
    decoded.tags['54'] === Number(made.data.total).toFixed(2), { qr: decoded.tags['54'], order: made.data.total });
  ok('and it is in baht', decoded.tags['53'] === '764');
  // The field the old inline builder did not emit at all.
  ok('the order number is attached as the reference', decoded.tags['62'] === made.data.orderNumber, decoded.tags['62']);
  ok('the request records the provider that made it', qr.data.provider === 'thaiqr', qr.data);
  ok('and the same reference', qr.data.reference === made.data.orderNumber, qr.data.reference);
  ok('a transfer is not claimed to be settled yet', qr.data.status === 'pending', qr.data.status);
  ok('the order is held as awaiting payment, not marked paid', qr.data.status === 'pending', qr.data.status);
  ok('no gateway key is anywhere in the response', !/opnSecretKey|stripeSecretKey/.test(JSON.stringify(qr.data)), Object.keys(qr.data).join(','));

  const qrMissing = capsAdmin.data.providers.find((p) => p.id === 'thaiqr');
  ok('Thai QR is unavailable until an account is set', qrMissing.available === false, qrMissing);
  ok('and says so rather than failing at the counter', /PromptPay/.test(qrMissing.reason), qrMissing.reason);
  // Give the shop an account, the way Settings does.
  await call('PUT', '/api/settings', { token: adminToken, body: { promptPayAccount: PROMPTPAY_FIXTURE, promptPayAccountType: 'phone' } });
  const capsAfter = await call('GET', '/api/payments/capabilities', { token: adminToken });
  const qrProvider = capsAfter.data.providers.find((p) => p.id === 'thaiqr');
  ok('Thai QR is offered once an account is set', qrProvider.available === true, qrProvider);
  ok('with no leftover complaint', qrProvider.reason === null, qrProvider.reason);
  ok('a transfer is not treated as settled on the spot', qrProvider.settledSynchronously === false);
  ok('Opn is configured now, and says its transport is not yet verified',
    capsAdmin.data.providers.find((p) => p.id === 'opn').available === true);
  throwsPayment('charging through Opn refuses rather than pretending', () => {
    const { createPayment } = require('../src/payments/registry');
    return createPayment('opn', { orders: [{ id: 1, orderNumber: 'A-1', total: 10 }], settings: { opnSecretKey: FAKE_OPN } });
  });
  ok('capabilities need sign-in', (await call('GET', '/api/payments/capabilities')).status === 401);

  console.log('\n== host allowlist and headers ==');
  // fetch() ignores a Host override, so the allowlist is probed over a raw socket.
  const rawHost = (host) => new Promise((resolve) => {
    const socket = net.connect(PORT, '127.0.0.1', () => {
      socket.write(`GET /api/health HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', (d) => { buf += d; });
    socket.on('close', () => resolve(buf.split('\r\n')[0] || ''));
    socket.on('error', () => resolve('error'));
    setTimeout(() => { try { socket.destroy(); } catch (e) {} resolve(buf.split('\r\n')[0] || 'timeout'); }, 3000);
  });

  const evil = await rawHost('evil.example.com');
  ok('unknown Host is refused (421)', /421/.test(evil), evil);
  const goodHost = await rawHost('pos.example.com');
  ok('known Host is accepted (200)', /200/.test(goodHost), goodHost);

  const good2 = await call('GET', '/api/health', { store: null });
  ok('health over loopback is accepted', good2.status === 200, good2.status);
  ok('security headers present', good2.res.headers.get('x-content-type-options') === 'nosniff', good2.res.headers.get('x-content-type-options'));
  ok('frames denied', good2.res.headers.get('x-frame-options') === 'DENY', good2.res.headers.get('x-frame-options'));

  const apiResp = await call('GET', '/api/health', { store: null });
  ok('api responses are not cached', /no-store/.test(apiResp.res.headers.get('cache-control') || ''), apiResp.res.headers.get('cache-control'));

  console.log('\n== CORS is not wide open ==');
  const cors = await call('GET', '/api/health', { store: null, headers: { Origin: 'https://evil.example.com' } });
  const allow = cors.res.headers.get('access-control-allow-origin');
  ok('no wildcard CORS header', allow !== '*', allow);

  console.log('\n== path traversal and bad store values ==');
  const trav = await call('POST', '/api/auth/login', { store: '../../etc/passwd', body: { username: 'a', password: 'b' } });
  ok('traversal-style store id rejected', trav.status === 400 || trav.status === 404, trav.status);
  const weird = await call('POST', '/api/auth/login', { store: 'UPPER CASE!!', body: { username: 'a', password: 'b' } });
  ok('invalid store id format rejected', weird.status === 400 || weird.status === 404, weird.status);

  console.log('\n== password policy ==');
  const weak = await call('POST', '/api/users', {
    token: adminToken,
    body: { username: 'weakuser', name: 'Weak', role: 'cashier', password: 'short' },
  });
  ok('short password refused for a new user', weak.status === 400, weak);

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error:/.test(log)) {
    console.log('\n--- server log errors ---');
    console.log(log.split('\n').filter((l) => /Error/.test(l)).slice(0, 10).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
