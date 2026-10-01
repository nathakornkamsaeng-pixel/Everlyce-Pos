// Single-store self-hosted mode, end to end.
//
// This is the whole shape of the public build, so it is tested from the outside
// rather than asserted about in isolation:
//
//   the install starts with no shop, and the setup form is offered
//   setup creates the shop, an owner and an active status in one request
//   setup then refuses, so it cannot be used to add a second shop
//   the platform console is switched off, except the two public reads the
//     front page depends on
//   the shop's own API works immediately, with no key and no waiting
//
// There is no email, no code and no captcha anywhere in this flow, and that is
// the point of the build: a self-hoster is sitting at the keyboard on their own
// server, so an emailed code would prove nothing they have not already proven,
// and requiring one would make the install refuse to start without SMTP.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A genuinely empty data directory, not the shared fixture.
//
// The other suites seed a legacy single-store document on purpose, because they
// are testing an upgrade. This suite is testing the opposite: a server started
// with nothing on disk at all, which is the state every self-hoster is actually
// in, and the only state in which the setup form is offered.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'everlyce-selfhost-'));
process.on('exit', () => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
});
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const STORE = process.env.TEST_STORE || 'myrestaurant';
const PORT = Number(process.env.TEST_PORT || 19600);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER_PASSWORD = 'a-long-enough-password';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const children = new Set();
function launch(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      POS_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      POS_DEFAULT_STORE_SLUG: STORE,
      // The flag is the only mode this build has, and every assertion below
      // depends on it being on.
      POS_SELF_HOST: '1',
      POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: PASSWORD,
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      ...extraEnv,
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
function shutdown() { killAll(); }
process.on('exit', shutdown);
process.on('uncaughtException', (e) => { console.error(e); shutdown(); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); shutdown(); process.exit(1); });

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

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  // A fresh install with no data file at all, so the first run has to create
  // something from nothing. The shared helper's fixture has a seeded store, which
  // is the right starting point for the other suites and the wrong one here.
  const server = launch();
  if (!await waitUp()) { console.log(server.log); shutdown(); process.exit(1); }

  console.log('\n== a fresh install offers to be set up ==');
  const seeded = await call('GET', '/api/platform/config');
  ok('the public config says this install needs setting up', seeded.data.setupRequired === true, seeded.data);
  ok('and advertises no trial and no sign-up',
    seeded.data.trialDays === 0 && seeded.data.registrationOpen === false, seeded.data);

  const before = await call('GET', '/api/platform/store/myrestaurant');
  ok('there is no shop yet', before.status === 404, before.status);

  console.log('\n== setup creates the shop, the owner and the live status at once ==');
  const setup = await call('POST', '/api/platform/setup', {
    body: {
      storeName: 'Siam Kitchen', storeId: 'siamkitchen', contactName: 'Nina',
      username: 'owner', password: OWNER_PASSWORD,
    },
  });
  ok('setup succeeds', setup.status === 201, { status: setup.status, detail: setup.data && setup.data.detail });
  ok('and the shop is live, not waiting for anything', setup.data.store.status === 'active', setup.data.store);
  ok('it has the name that was given', setup.data.store.name === 'Siam Kitchen', setup.data.store.name);
  ok('and the address that was asked for', setup.data.store.slug === 'siamkitchen', setup.data.store.slug);
  ok('the owner account is named', setup.data.owner && setup.data.owner.username === 'owner', setup.data.owner);
  ok('and it points at the sign-in page', setup.data.signInPath === '/siamkitchen/login', setup.data.signInPath);

  console.log('\n== nothing about setup waits for an email ==');
  const cfgAfter = await call('GET', '/api/platform/config');
  ok('the install no longer needs setting up', cfgAfter.data.setupRequired === false, cfgAfter.data);
  ok('and no mailer was ever needed, so nothing is logged about one',
    !/MAIL:|SMTP/i.test(server.log), server.log.split('\n').filter((l) => /MAIL:|SMTP/i.test(l)));

  console.log('\n== the owner can sign in and trade straight away ==');
  const login = await call('POST', '/api/auth/login', {
    body: { username: 'owner', password: OWNER_PASSWORD }, store: 'siamkitchen',
  });
  ok('the owner signs in', login.status === 200, { status: login.status, detail: login.data && login.data.detail });
  ok('with no activation step demanded at sign-in', !login.data.activationRequired, login.data && login.data.activationRequired);
  const T = login.data.token;
  ok('and the shop API works immediately', (await call('GET', '/api/settings', { token: T, store: 'siamkitchen' })).status === 200);
  ok('tables are readable', (await call('GET', '/api/tables', { token: T, store: 'siamkitchen' })).status === 200);

  console.log('\n== setup is one-shot ==');
  // A fully valid body, so the refusal can only be about the install already
  // having a shop and not about the field values.
  const again = await call('POST', '/api/platform/setup', {
    body: { storeName: 'Second Shop', storeId: 'secondshop', contactName: 'X', username: 'owner2', password: OWNER_PASSWORD },
  });
  ok('a second setup is refused', again.status === 409, again.status);
  ok('with a code that says why', again.data.code === 'already_setup', again.data);
  const second = await call('GET', '/api/platform/store/secondshop');
  ok('and no second shop appeared', second.status === 404, second.status);
  ok('the first shop is untouched', (await call('GET', '/api/platform/store/siamkitchen')).data.store.name === 'Siam Kitchen');

  console.log('\n== the platform console is switched off ==');
  // The setup form made the owner the platform operator too, so this is the same
  // set of credentials rather than a second one to keep track of. There was no
  // bootstrap admin here: on an empty install there is no store to attach one to.
  const plat = await call('POST', '/api/platform/login', { body: { username: 'owner', password: OWNER_PASSWORD } });
  const PT = plat.data && plat.data.token;
  ok('the owner is also the platform operator, so there is one set of credentials',
    plat.status === 200 && !!PT, { status: plat.status, detail: plat.data && plat.data.detail });

  // The two endpoints the front page reads. Without them the public page cannot
  // render, so they are the deliberate exception to the switch-off.
  const publicConfig = await call('GET', '/api/platform/config');
  ok('GET /config still answers, for the public page', publicConfig.status === 200, publicConfig.status);
  const publicStore = await call('GET', '/api/platform/store/siamkitchen');
  ok('GET /store/:slug still answers, for the public page', publicStore.status === 200, publicStore.status);

  // Everything that can change something, or read across shops, must not.
  const closed = [
    ['GET', '/api/platform/stores'],
    ['POST', '/api/platform/stores'],
    ['POST', '/api/platform/stores/1/key'],
    ['DELETE', '/api/platform/stores/1?confirm=siamkitchen'],
    ['GET', '/api/platform/plan-requests'],
    ['POST', '/api/platform/password'],
    ['PATCH', '/api/platform/config'],
    ['GET', '/api/platform/privacy'],
    ['GET', '/api/platform/consent/history'],
    ['POST', '/api/platform/activate'],
  ];
  for (const [method, p] of closed) {
    const r = await call(method, p, { token: PT, body: method === 'GET' ? undefined : {} });
    ok(`${method} ${p.replace('/api/platform', '')} is closed`, r.status === 404, { status: r.status, detail: r.data && r.data.detail });
  }

  console.log('\n== and the one shop survived all of that ==');
  const stillThere = await call('GET', '/api/platform/store/siamkitchen');
  ok('the shop is still there', stillThere.status === 200, stillThere.status);
  ok('and still live', stillThere.data.store.status === 'active', stillThere.data.store.status);
  ok('the owner can still sign in', (await call('POST', '/api/auth/login', {
    body: { username: 'owner', password: OWNER_PASSWORD }, store: 'siamkitchen',
  })).status === 200);

  console.log('\n== the shop survives a restart ==');
  killAll();
  await new Promise((r) => setTimeout(r, 500));
  const again2 = launch();
  if (!await waitUp()) { console.log(again2.log); shutdown(); process.exit(1); }
  const afterRestart = await call('GET', '/api/platform/config');
  ok('a restarted install is still set up', afterRestart.data.setupRequired === false, afterRestart.data);
  ok('the shop is still live', (await call('GET', '/api/platform/store/siamkitchen')).data.store.status === 'active');
  ok('and the owner can still sign in', (await call('POST', '/api/auth/login', {
    body: { username: 'owner', password: OWNER_PASSWORD }, store: 'siamkitchen',
  })).status === 200);

  console.log('\n== setup input is checked, so a typo cannot half-create a shop ==');
  const badName = await call('POST', '/api/platform/setup', {
    body: { storeName: 'x', contactName: 'N', username: 'u', password: OWNER_PASSWORD },
  });
  ok('a one-character shop name is refused', badName.status === 400, badName.status);
  const badUser = await call('POST', '/api/platform/setup', {
    body: { storeName: 'Valid Name', contactName: 'N', username: 'no', password: OWNER_PASSWORD },
  });
  ok('a two-character username is refused', badUser.status === 400, badUser.status);
  const badPass = await call('POST', '/api/platform/setup', {
    body: { storeName: 'Valid Name', contactName: 'N', username: 'validuser', password: 'short' },
  });
  ok('a short password is refused', badPass.status === 400, badPass.status);
  ok('and none of them created anything', (await call('GET', '/api/platform/store/valid-name')).status === 404);

  console.log(`\n${pass} passed, ${fail} failed`);
  shutdown();
  process.exit(fail ? 1 : 0);
})();
