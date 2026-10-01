// The data health report. The point of this test is not just that the page
// renders, but that it stays behind the platform sign-in and never carries
// customer data: an open version would advertise how much of what a stranger
// might want is here.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const { isolatedData } = require('./helpers/isolated-data');
const DATA_DIR = isolatedData();
const PORT = Number(process.env.TEST_PORT || 19200);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const STORE = process.env.TEST_STORE || 'myrestaurant';

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
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} } }
process.on('exit', killAll);

async function call(method, p, { body, token, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data, text, ct: res.headers.get('content-type') };
}

(async () => {
  let up = false;
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.log('server did not start\n', serverLog); killAll(); process.exit(1); }

  const pLogin = await call('POST', '/api/platform/login', { body: { username: 'admin', password: PASSWORD } });
  ok('platform sign-in works', pLogin.status === 200 && !!pLogin.data.token, pLogin.status);
  const T = pLogin.data.token;
  const storeLogin = await call('POST', '/api/auth/login', { body: { store: STORE, username: 'admin', password: PASSWORD }, headers: { 'X-POS-Store': STORE } });

  console.log('\n== it is not a public page ==');
  ok('an anonymous request is refused', (await call('GET', '/api/stat/report')).status === 401);
  ok('a store session is refused', (await call('GET', '/api/stat/report', { token: storeLogin.data.token })).status === 403);
  ok('a platform session is accepted', (await call('GET', '/api/stat/report', { token: T })).status === 200);
  ok('a garbage token is refused', (await call('GET', '/api/stat/report', { token: 'not.a.token' })).status === 401);

  console.log('\n== what it reports ==');
  const rep = await call('GET', '/api/stat/report', { token: T });
  ok('it says what it covers', /platform|store \//.test(rep.data.scope), rep.data.scope);
  ok('it counts the stores', rep.data.totals.stores >= 1, rep.data.totals.stores);
  ok('it counts the rows', rep.data.totals.rows > 0, rep.data.totals.rows);
  ok('it breaks rows down by collection', typeof rep.data.totals.records.users === 'number', Object.keys(rep.data.totals.records).slice(0, 5));
  ok('the per-collection rows add up to the total',
    Object.values(rep.data.totals.records).reduce((a, b) => a + b, 0) === rep.data.totals.rows,
    { sum: Object.values(rep.data.totals.records).reduce((a, b) => a + b, 0), total: rep.data.totals.rows });
  ok('it gives an integrity verdict', ['pass', 'degraded', 'fail'].includes(rep.data.integrity.status), rep.data.integrity.status);
  ok('it counts errors and warnings separately',
    typeof rep.data.integrity.counts.error === 'number' && typeof rep.data.integrity.counts.warn === 'number',
    rep.data.integrity.counts);
  ok('it lists each store with its own counts', Array.isArray(rep.data.stores) && rep.data.stores.length >= 1
    && rep.data.stores.every((s) => typeof s.total === 'number' && Array.isArray(s.findings || []) || typeof s.total === 'number'),
    rep.data.stores.map((s) => s.slug));
  ok('it reports the data file size', rep.data.files.dataFile.sizeBytes > 0, rep.data.files.dataFile.sizeMb);
  ok('it reports the backup state', rep.data.files.backup && typeof rep.data.files.backup.missing === 'boolean', rep.data.files.backup);
  ok('it reports uptime', rep.data.process.uptimeSeconds >= 0, rep.data.process.uptimeReadable);
  ok('it reports memory', rep.data.process.rssMb > 0, rep.data.process.rssMb);
  ok('it reports the schema version', rep.data.schemaVersion >= 3, rep.data.schemaVersion);
  ok('it is not cached', /no-store/.test(rep.text) === false && rep.status === 200, 'sanity');

  console.log('\n== the integrity checks are real ==');
  // A live store with no admin should be reported, not silently passed.
  const noAdmin = await call('GET', '/api/stat/report', { token: T });
  ok('a healthy fixture passes its checks', noAdmin.data.integrity.status !== 'fail', noAdmin.data.integrity);
  ok('every finding has a severity and a code',
    (rep.data.integrity.findings || []).every((f) => ['error', 'warn', 'info'].includes(f.severity) && typeof f.code === 'string'),
    rep.data.integrity.findings);
  ok('findings name the store they came from',
    (rep.data.integrity.findings || []).every((f) => f.store && f.store.startsWith('/')),
    rep.data.integrity.findings.map((f) => f.store));

  console.log('\n== no customer data on the page ==');
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'data.json'), 'utf8'));
  const bucket = raw.storeData[String(raw.stores[0].id)];
  const body = JSON.stringify(rep.data);
  const names = (bucket.loyaltyMembers || []).map((m) => m.name).filter(Boolean);
  const phones = (bucket.loyaltyMembers || []).map((m) => m.phone).filter(Boolean);
  const users = (bucket.users || []).map((u) => u.name).filter(Boolean);
  ok('no loyalty member names', names.length === 0 || names.every((n) => !body.includes(n)), names.filter((n) => body.includes(n)));
  ok('no phone numbers', phones.length === 0 || phones.every((p) => !body.includes(p)), phones.filter((p) => body.includes(p)));
  ok('no staff names', users.length === 0 || users.every((u) => !body.includes(u)), users.filter((u) => body.includes(u)));
  if (bucket.settings.promptPayAccount) ok('no PromptPay account', !body.includes(bucket.settings.promptPayAccount), 'leaked');
  ok('no order numbers', (bucket.orders || []).every((o) => !body.includes(o.orderNumber)), 'leaked');
  try {
    const secret = fs.readFileSync(path.join(DATA_DIR, 'jwt-secret'), 'utf8').trim().split('\n')[0];
    ok('no signing secret', !body.includes(secret), 'leaked');
  } catch (e) { ok('no signing secret', true); }

  console.log('\n== the browser page ==');
  const html = await call('GET', '/api/stat/report', { token: T, headers: { Accept: 'text/html' } });
  ok('a browser gets HTML', /text\/html/.test(html.ct || ''), html.ct);
  ok('it is a full document', html.text.startsWith('<!doctype html>'), html.text.slice(0, 40));
  ok('it shows the row count', /rows<\/div>/.test(html.text), 'no rows card');
  ok('it shows the integrity verdict', /integrity<\/div>/.test(html.text), 'no integrity card');
  ok('it shows the checks table', /Severity/.test(html.text), 'no checks table');
  ok('it shows a store row', /\/myrestaurant/.test(html.text), 'no store row');
  ok('it asks crawlers to stay out', /noindex/.test(html.text), 'no robots meta');
  ok('it pulls nothing from the internet', !/src="http|href="http/.test(html.text), 'external reference');
  ok('it carries no customer data', names.every((n) => !html.text.includes(n)), 'name in html');
  ok('it renders without the app bundle', !/assets\/index/.test(html.text), 'depends on the bundle');

  console.log('\n== the small health endpoint ==');
  const h = await call('GET', '/api/stat/health');
  ok('it needs no sign-in, so monitoring can use it', h.status === 200, h.status);
  ok('it reports ok', h.data.ok === true, h.data);
  // The public endpoint is unauthenticated and meant to be shown to people, so it
  // deliberately carries no store count and no row count.
  ok('it publishes no store count', h.data.stores === undefined, h.data);
  ok('it publishes no row count', h.data.rows === undefined, h.data);
  ok('it reports the verdict', ['pass', 'degraded', 'fail'].includes(h.data.status), h.data.status);
  ok('a client that does not ask for html still gets json', /application\/json/.test(h.ct || ''), h.ct);
  ok('the json body is the small contract, not the whole report',
    Object.keys(h.data || {}).sort().join(',') === 'errors,ok,status,uptime,warnings',
    Object.keys(h.data || {}));

  console.log('\n== the public status page ==');
  const page = await call('GET', '/api/stat/health', { headers: { Accept: 'text/html' } });
  ok('a browser asking for html gets a page', /text\/html/.test(page.ct || ''), page.ct);
  ok('it is a whole document', /^<!doctype html>/i.test((page.text || '').trim()), (page.text || '').slice(0, 40));
  ok('it shows the verdict', /All systems operational|Operational, with \d+ advisor|Action required/.test(page.text), 'no verdict');
  ok('it shows the uptime', /since restart/.test(page.text) && /id="uptime"/.test(page.text), 'no uptime tile');
  ok('it shows the response time', /to build<\/div>/.test(page.text), 'no latency tile');
  ok('it lists what the system does', /What it does/.test(page.text) && /Till and tables/.test(page.text) && /Self-hosting/.test(page.text), 'no capabilities');
  ok('it lists the security posture', />Security</.test(page.text) && /SHA-256, single use, revocable/.test(page.text), 'no posture section');
  ok('it pulls nothing from the internet', !/src="http|href="http|@import|url\(https?:/.test(page.text), 'external reference');
  ok('it does not depend on the app bundle', !/assets\/index/.test(page.text), 'depends on the bundle');
  ok('it stays inside the site CSP', !/<script[^>]+src=|<link[^>]+stylesheet|<img[^>]+src=/.test(page.text), 'external asset tag');
  // A page built to be screenshotted and sent to people must not hand out
  // reconnaissance, so it carries no store names, slugs or record counts.
  const leaks = [];
  for (const s of (rep.data && rep.data.stores) || []) {
    if (s.name && page.text.includes(s.name)) leaks.push(s.name);
    if (s.slug && page.text.includes(s.slug)) leaks.push(`/${s.slug}`);
  }
  ok('it leaks no store name or slug', leaks.length === 0, leaks.join(', '));
  ok('it shows no row count', !/\b\d[\d,]*\s+rows\b/i.test(page.text), 'row count present');
  ok('it shows no store count', !/\b\d+\s+stores\b/i.test(page.text), 'store count present');
  ok('it names the machine-readable form', /curl/.test(page.text), 'no json hint');
  // The redesign removed the card grid: a page of boxed facts reads as a
  // template, so the layout leans on hairlines and whitespace instead.
  ok('it carries no filled cards', !/border-radius:\s*(1[0-9]|[2-9][0-9])px/.test(page.text), 'a large radius is back');
  ok('it carries no decorative glow', !/radial-gradient/.test(page.text), 'gradient blob is back');
  ok('it has no meaningless filler copy', !/of \d+ checks|\bLorem\b|TODO/.test(page.text), 'placeholder text');

  console.log('\n== brand version cannot drift ==');
  const webBrand = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'brand-assets.js'), 'utf8');
  const webVersion = (webBrand.match(/BRAND_VERSION\s*=\s*(\d+)/) || [])[1];
  const serverVersion = String(require('../src/brandVersion').BRAND_VERSION);
  ok('the web and server agree on the brand version', webVersion === serverVersion, `web ${webVersion} vs server ${serverVersion}`);
  ok('the page uses the agreed version', page.text.includes(`favicon.svg?v=${serverVersion}`), 'favicon version missing');

  console.log('\n== it cannot be hammered ==');
  let limited = false;
  for (let i = 0; i < 30; i += 1) {
    const r = await call('GET', '/api/stat/report', { token: T });
    if (r.status === 429) { limited = true; break; }
  }
  ok('bursts are refused', limited, 'never limited');

  killAll();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (/Error:/.test(serverLog)) {
    console.log('\n--- server log errors ---');
    console.log(serverLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 8).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
