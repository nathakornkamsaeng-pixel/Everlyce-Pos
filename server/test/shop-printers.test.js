// A shop's printers and its payment methods.
//
// Both per store, and both only ever visible to the shop that owns them. The
// point of these two together is that neither belongs to the platform: two shops
// on one install have different machines behind the counter and take payment in
// different ways.

process.env.POS_DATA_DIR = (() => {
  const { isolatedData } = require('./helpers/isolated-data');
  return isolatedData();
})();
process.env.POS_CAPTCHA_SECRET = '';

const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { createStore } = require('./helpers/create-store');

const DATA_DIR = process.env.POS_DATA_DIR;
const BASE = 'http://127.0.0.1:8119';
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';

let pass = 0;
let fail = 0;
let serverLog = '';
const children = [];
// Declared here rather than beside its assignment: the exit handler below is
// registered at module scope, so a suite that dies during load would otherwise
// reach `smtp` before its `const` had initialised.

function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else {
    fail += 1;
    console.log(`  FAIL ${label}${extra === undefined ? '' : ` -> ${JSON.stringify(extra)}`}`);
  }
}

async function call(method, p, { body, token, store } = {}) {
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
    env: {
      ...process.env, POS_DATA_DIR: DATA_DIR, PORT: '8119',
      POS_DEFAULT_STORE_SLUG: 'myrestaurant', POS_BOOTSTRAP_USERNAME: 'admin', POS_BOOTSTRAP_PASSWORD: PASSWORD,
      POS_PLATFORM_ADMIN_USERNAME: 'admin', POS_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      POS_CAPTCHA_SECRET: '', NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  children.push(child);
  return child;
}
function shutdown() { killAll(); }
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} } }
process.on('exit', shutdown);
process.on('uncaughtException', (e) => { console.error(e); shutdown(); process.exit(1); });

(async () => {
  launch();
  for (let i = 0; i < 90; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }

  const printLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  const printStore = await createStore({
    call, token: printLogin.data && printLogin.data.token,
    fields: { name: 'Print Cafe', contactName: 'O', contactEmail: 'o@printcafe.com', username: 'owner', password: PASSWORD },
  });
  const slug = printStore.slug;
  const login = await call('POST', '/api/auth/login', { body: { username: 'owner', password: PASSWORD }, store: slug });
  const ST = login.data.token;

  console.log('\n== a shop starts with no printers, and is told what that means ==');
  const empty = await call('GET', '/api/shop-settings', { token: ST, store: slug });
  ok('it can ask what it can print to', empty.status === 200, empty.status);
  ok('with none of its own', empty.data.counts.total === 0, empty.data.counts);
  ok('and the models to choose from', Array.isArray(empty.data.catalogue) && empty.data.catalogue.length === 11, empty.data.catalogue && empty.data.catalogue.length);
  ok('it is warned a receipt will not print', empty.data.warnings.some((w) => /receipt printer/i.test(w)), empty.data.warnings);
  ok('and that kitchen tickets will not either', empty.data.warnings.some((w) => /kitchen printer/i.test(w)), empty.data.warnings);
  ok('the warnings are per job, not one blanket flag', empty.data.warnings.length === 2, empty.data.warnings);

  console.log('\n== adding a printer ==');
  const net = await call('POST', '/api/shop-settings', {
    token: ST, store: slug,
    body: { name: 'Front counter', kind: 'receipt', protocol: 'escpos-network', address: '192.168.1.80:9100', vendor: 'Epson', model: 'TM-T88VII' },
  });
  ok('it is added', net.status === 201, net);
  ok('and becomes the default receipt printer by itself', net.data.printer.isDefaultReceipt === true, net.data.printer);
  ok('the chosen model is recorded', net.data.printer.model === 'TM-T88VII', net.data.printer.model);
  ok('a supported model is not claimed to be verified', net.data.printer.verified === false, net.data.printer.verified);
  ok('80mm paper is 48 columns', net.data.printer.columns === 48, net.data.printer.columns);
  ok('the receipt warning goes away', !net.data.summary.warnings.some((w) => /receipt printer/i.test(w)), net.data.summary.warnings);
  ok('but the kitchen one stays, because no kitchen printer was added', net.data.summary.warnings.some((w) => /kitchen/i.test(w)));

  const kitchen = await call('POST', '/api/shop-settings', {
    token: ST, store: slug, body: { name: 'Kitchen', kind: 'kitchen', protocol: 'browser' },
  });
  ok('a kitchen printer can be added', kitchen.status === 201, kitchen.status);
  ok('no warnings left', kitchen.data.summary.warnings.length === 0, kitchen.data.summary.warnings);

  console.log('\n== a network printer with no address is refused ==');
  const noAddress = await call('POST', '/api/shop-settings', {
    token: ST, store: slug, body: { name: 'Ghost', kind: 'receipt', protocol: 'escpos-network' },
  });
  ok('it is refused', noAddress.status === 400, noAddress.status);
  ok('with a message that says what is missing', /IP address/i.test(noAddress.data.detail || ''), noAddress.data);
  ok('and a code', noAddress.data.code === 'address_required', noAddress.data);
  ok('a name is required too', (await call('POST', '/api/shop-settings', { token: ST, store: slug, body: { kind: 'receipt' } })).status === 400);
  ok('a browser printer needs no address', (await call('POST', '/api/shop-settings', { token: ST, store: slug, body: { name: 'Browser receipt', kind: 'label', protocol: 'browser' } })).status === 201);

  console.log('\n== one default per job ==');
  const second = await call('POST', '/api/shop-settings', {
    token: ST, store: slug, body: { name: 'Spare', kind: 'receipt', protocol: 'browser' },
  });
  ok('a second receipt printer can exist', second.data.printer.isDefaultReceipt === false, second.data.printer);
  ok('but is not the default', second.data.printer.isDefaultReceipt !== true);
  const promote = await call('POST', `/api/shop-settings/${second.data.printer.id}/default`, { token: ST, store: slug });
  ok('it can be made the default', promote.data.printer.isDefaultReceipt === true, promote.data.printer);
  const afterPromote = await call('GET', '/api/shop-settings', { token: ST, store: slug });
  ok('and only one receipt printer is the default at a time',
    afterPromote.data.printers.filter((p) => p.kind === 'receipt' && p.isDefaultReceipt).length === 1,
    afterPromote.data.printers.filter((p) => p.isDefaultReceipt));

  console.log('\n== a test print is real ESC/POS, not a friendly string ==');
  const test = await call('POST', `/api/shop-settings/${net.data.printer.id}/test`, { token: ST, store: slug });
  ok('it produces something', test.status === 200 && test.data.payload, test.status);
  const bytes = Buffer.from(test.data.payload, 'base64');
  ok('as bytes, and long enough to be a real job', bytes.length > 40, bytes.length);
  ok('it opens the printer', bytes.includes(Buffer.from([0x1b, 0x40])), bytes.slice(0, 6).toString('hex'));
  ok('and cuts the paper at the end', bytes.includes(Buffer.from([0x1d, 0x56])), 'no cut command');
  ok('a printer that does not exist is refused', (await call('POST', '/api/shop-settings/9999/test', { token: ST, store: slug })).status === 404);

  console.log('\n== removing a printer hands the job on ==');
  const gone = await call('DELETE', `/api/shop-settings/${second.data.printer.id}`, { token: ST, store: slug });
  ok('it is removed', gone.status === 200, gone.status);
  ok('and another receipt printer takes over rather than leaving none',
    gone.data.summary.printers.filter((p) => p.kind === 'receipt' && p.isDefaultReceipt).length === 1,
    gone.data.summary.printers.map((p) => [p.name, p.isDefaultReceipt]));

  console.log('\n== another shop sees none of it ==');
  const otherStore2 = await createStore({
    call, token: printLogin.data && printLogin.data.token,
    fields: { name: 'Other Cafe', slug: 'othercafe2', contactName: 'T', contactEmail: 't@othercafe.com', username: 'owner', password: PASSWORD },
  });
  const slug2 = otherStore2.slug;
  const ST2 = (await call('POST', '/api/auth/login', { body: { username: 'owner', password: PASSWORD }, store: slug2 })).data.token;
  const other = await call('GET', '/api/shop-settings', { token: ST2, store: slug2 });
  ok('the other shop has no printers', other.data.counts.total === 0, other.data.counts);
  ok('and is warned about its own', other.data.warnings.length === 2, other.data.warnings);
  ok('it cannot fetch a printer by id either', (await call('GET', `/api/shop-settings/${net.data.printer.id}`, { token: ST2, store: slug2 })).status === 404);
  ok('it cannot change them', (await call('PUT', `/api/shop-settings/${net.data.printer.id}`, { token: ST2, store: slug2, body: { name: 'stolen' } })).status === 404);
  ok('it cannot delete them', (await call('DELETE', `/api/shop-settings/${net.data.printer.id}`, { token: ST2, store: slug2 })).status === 404);
  const stillThere = await call('GET', '/api/shop-settings', { token: ST, store: slug });
  ok('and they are all still there', stillThere.data.printers.some((p) => p.name === 'Front counter'), stillThere.data.printers.map((p) => p.name));
  ok('unharmed', stillThere.data.printers.find((p) => p.name === 'Front counter').address === '192.168.1.80:9100');
  ok('and these need sign-in', (await call('GET', '/api/shop-settings', { store: slug })).status === 401);

  console.log('\n== payment methods are the shop\'s too ==');
  const methods0 = await call('GET', '/api/shop-settings/methods', { token: ST, store: slug });
  ok('cash is always there', methods0.data.methods.some((m) => m.id === 'cash'), methods0.data.methods);
  ok('it settles immediately, so a cashier can void it', methods0.data.methods.find((m) => m.id === 'cash').kind === 'immediate');
  ok('the gateways it could use are offered', methods0.data.available.some((p) => p.id === 'thaiqr'), methods0.data.available.map((p) => p.id));
  ok('a shop with no PromptPay account is not shown Thai QR as usable', methods0.data.available.find((p) => p.id === 'thaiqr') !== undefined);

  const setMethods = await call('PUT', '/api/shop-settings/methods', {
    token: ST, store: slug,
    body: { methods: [
      { id: 'cash' },
      { id: 'thaiqr', label: 'Thai QR' },
      { id: 'truemoney', label: 'TrueMoney', kind: 'immediate' },
      { id: 'banktransfer', label: 'Bank transfer', kind: 'deferred' },
    ] },
  });
  ok('a shop can choose what it takes', setMethods.status === 200, setMethods.status);
  ok('and it is in the order they gave', setMethods.data.methods.map((m) => m.id).join(',') === 'cash,thaiqr,truemoney,banktransfer', setMethods.data.methods.map((m) => m.id));
  ok('a method it invented is marked as its own', setMethods.data.methods.find((m) => m.id === 'truemoney').custom === true);
  ok('a built-in one is not', setMethods.data.methods.find((m) => m.id === 'thaiqr').custom === false);
  ok('it can say whether a method settles at once', setMethods.data.methods.find((m) => m.id === 'banktransfer').kind === 'deferred');

  const otherMethods = await call('GET', '/api/shop-settings/methods', { token: ST2, store: slug2 });
  ok('the other shop has not been given any of it', otherMethods.data.methods.length === 1, otherMethods.data.methods.map((m) => m.id));
  ok('cash, and nothing else', otherMethods.data.methods[0].id === 'cash');

  console.log('\n== cash cannot be taken away ==');
  const noCash = await call('PUT', '/api/shop-settings/methods', {
    token: ST, store: slug, body: { methods: [{ id: 'thaiqr', label: 'QR' }] },
  });
  ok('it is still offered after being left out', noCash.data.methods.some((m) => m.id === 'cash'), noCash.data.methods);
  const renamed = await call('PUT', '/api/shop-settings/methods', {
    token: ST, store: slug, body: { methods: [{ id: 'cash', label: 'Hand over the cash' }] },
  });
  ok('and it cannot be renamed into something silly', renamed.data.methods.find((m) => m.id === 'cash').label === 'Cash', renamed.data.methods.find((m) => m.id === 'cash'));

  ok('the whole thing needs sign-in', (await call('GET', '/api/shop-settings/methods', { store: slug })).status === 401);

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error/.test(serverLog)) {
    console.log('\n--- server log errors ---');
    console.log(serverLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 6).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();