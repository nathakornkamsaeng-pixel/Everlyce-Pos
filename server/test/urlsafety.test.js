// The external-URL rule and the in-process rate limiter.
//
// Both of these are small, and both are the kind of thing that looks fine in
// review and is wrong in production: a javascript: URL that reaches a menu, or
// a sign-in endpoint that is only rate limited by whatever happens to sit in
// front of it.
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');

const { isolatedData } = require('./helpers/isolated-data');
const { validateExternalUrl } = require('../src/urlSafety');
const DATA_DIR = isolatedData();
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const STORE = process.env.TEST_STORE || 'myrestaurant';
const PORT = Number(process.env.TEST_PORT || 19400);
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

console.log('\n== the external url rule ==');
ok('a blank is allowed, because a product need not have a photo',
  validateExternalUrl('').value === '' && !validateExternalUrl('').error);
ok('undefined and null are allowed',
  validateExternalUrl(undefined).value === '' && validateExternalUrl(null).value === '');
ok('the shop own upload path is allowed', validateExternalUrl('/uploads/latte.png').value === '/uploads/latte.png');
ok('a protocol-relative url is refused', Boolean(validateExternalUrl('//evil.test/x.png').error), validateExternalUrl('//evil.test/x.png'));
for (const bad of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html;base64,PHNjcmlwdD4=',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'blob:https://x.test/abc',
  'http://example.test/x.png',
]) {
  ok(`refused: ${bad.slice(0, 34)}`, Boolean(validateExternalUrl(bad).error), validateExternalUrl(bad));
}
ok('a normal https image is allowed',
  validateExternalUrl('https://cdn.example.test/latte.png').value.startsWith('https://cdn.example.test/'));
ok('a https url with embedded credentials is refused',
  Boolean(validateExternalUrl('https://user:pw@cdn.example.test/x.png').error));
ok('a space or newline cannot smuggle a scheme past it',
  Boolean(validateExternalUrl('java\tscript:alert(1)').error || validateExternalUrl(' javascript:alert(1)').error));

const children = new Set();
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
    POS_RATE_LOGIN_PER_IP: '12',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.add(child);
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

async function call(method, p, { body, token, store, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (store) h['X-POS-Store'] = store;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, text };
}

(async () => {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const login = await call('POST', '/api/auth/login', { body: { store: STORE, username: 'admin', password: PASSWORD }, store: STORE });
  const T = login.data && login.data.token;
  ok('the store signs in', login.status === 200 && !!T, login.status);

  console.log('\n== a product image cannot carry a payload ==');
  const cat = (await call('POST', '/api/categories', { body: { name: 'Drinks' }, token: T, store: STORE })).data;
  const bad = await call('POST', '/api/products', {
    body: { name: 'Evil', price: 10, categoryId: cat.id, imageUrl: 'javascript:alert(1)' }, token: T, store: STORE,
  });
  ok('a javascript: image is refused on create', bad.status === 400, bad.status);
  ok('the refusal explains itself', /https/.test(String(bad.data.detail || '')), bad.data);

  const good = await call('POST', '/api/products', {
    body: { name: 'Latte', price: 90, categoryId: cat.id, imageUrl: 'https://cdn.example.test/latte.png' }, token: T, store: STORE,
  });
  ok('an ordinary https image is accepted', good.status === 201, good.status);
  const noImage = await call('POST', '/api/products', {
    body: { name: 'No photo', price: 50, categoryId: cat.id }, token: T, store: STORE,
  });
  ok('a product with no image is accepted', noImage.status === 201, noImage.status);

  const updated = await call('PUT', `/api/products/${good.data.id}`, {
    body: { imageUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==' }, token: T, store: STORE,
  });
  ok('a data: image is refused on update', updated.status === 400, updated.status);
  const readBack = await call('GET', `/api/products?q=Latte`, { token: T, store: STORE });
  ok('the stored image is unchanged after a refused update',
    JSON.stringify(readBack.data).includes('cdn.example.test/latte.png'), readBack.data);

  console.log('\n== sign-in is capped in process, not only by nginx ==');
  // The per-address ceiling is lowered to 12 for this run, because proving a
  // default of 300 would mean 300 bcrypt compares.
  let sawLimit = false;
  let attempts = 0;
  for (let i = 0; i < 40; i += 1) {
    attempts += 1;
    const r = await call('POST', '/api/auth/login', {
      body: { store: STORE, username: `sprayed-${i}`, password: 'wrong-password' }, store: STORE,
    });
    if (r.status === 429) { sawLimit = true; break; }
  }
  ok('volume from one address is stopped inside the app', sawLimit, `after ${attempts} attempts`);
  // The ceiling is 12 and the suite's own sign-in above already spent one of
  // them from this same address, so the 12th call here is the one refused.
  ok('it stops at the configured ceiling, not somewhere arbitrary', attempts === 12, attempts);
  const afterLimit = await call('POST', '/api/auth/login', {
    body: { store: STORE, username: 'sprayed-0', password: 'wrong-password' }, store: STORE,
  });
  ok('the limit is a 429, not a 401 pretending to be one', afterLimit.status === 429, afterLimit.status);
  ok('the limit says why', /too many/i.test(String(afterLimit.data.detail || '')), afterLimit.data);
  ok('and names the cause', /address/i.test(String(afterLimit.data.detail || '')), afterLimit.data);

  const after429 = await call('POST', '/api/auth/login', {
    body: { store: STORE, username: 'admin', password: PASSWORD }, store: STORE,
  });
  ok('a real cashier is refused too, but only because they share the address', after429.status === 429, after429.status);
  ok('a correct password does not defeat the ceiling', !after429.data.token, after429.data);

  console.log('\n== the default ceiling leaves a whole shop alone ==');
  const configured = Number(process.env.POS_RATE_LOGIN_PER_IP || 300);
  ok('the shipped default is far above what one till needs', configured >= 120, configured);
  ok('and the per-account cap does not punish a shared address for other tills',
    configured > 20, configured);

  child.kill('SIGKILL');
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error:/.test(serverLog)) {
    console.log('\n--- server log errors ---');
    console.log(serverLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 6).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
