// Renders the built app in jsdom and signs in to the platform console, which is
// what a user does first. A missing component import throws here exactly as it
// did in the browser, and used to show up only as a blank white page.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from '/opt/pos/node_modules/jsdom/lib/api.js';
import { build } from '/opt/pos/node_modules/esbuild/lib/main.js';

// jsdom cannot load ES modules, so the app is bundled as a classic script
// first. This renders the real component tree, not a stand-in.
const BUNDLE = path.join('/tmp', `pos-render-${process.pid}.js`);
await build({
  entryPoints: [path.join(process.cwd(), 'src', 'main.jsx')],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.svg': 'dataurl', '.png': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: BUNDLE,
  logLevel: 'error',
});
process.on('exit', () => { try { fs.unlinkSync(BUNDLE); } catch (e) {} });

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${String(extra).slice(0, 300)}` : ''}`); }
}

const html = '<!doctype html><html><head></head><body><div id="root"></div></body></html>';
const dom = new JSDOM(html, {
  url: 'https://pos.example.com/platform',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
});

const { window } = dom;

// The app bundle, plus a CSS shim so nothing chokes on missing styles.
const style = window.document.createElement('style');
style.textContent = '*{box-sizing:border-box}';
window.document.head.appendChild(style);
const script = window.document.createElement('script');
script.textContent = fs.readFileSync(BUNDLE, 'utf8');
window.document.head.appendChild(script);

const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
window.console.error = (...args) => errors.push(args.map(String).join(' '));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));

// The console's own API calls, so the test does not need a live server.
const STORES = {
  stores: [{
    id: 1, slug: 'siamkitchen', name: 'Siam Kitchen', status: 'active', plan: 'enterprise',
    planName: 'Enterprise', planMonths: 0, restaurantName: 'Siam Kitchen', createdAt: '2026-01-01T00:00:00.000Z',
    activatedAt: '2026-01-01T00:00:00.000Z', contactName: null, contactEmail: null, contactPhone: null,
    note: null, source: 'migration', hasKey: false, keyHint: null, keyIssuedAt: null,
    keyExpiresAt: null, keyUsedAt: null, keyRevokedAt: null,
    stats: { users: 4, products: 3, orders: 5, tables: 5, branches: 1 },
  }],
  plans: [
    { id: 'starter', name: 'Starter', maxUsers: 3, maxProducts: 200, priceTHB: 990 },
    { id: 'professional', name: 'Professional', maxUsers: 15, maxProducts: 2000, priceTHB: 2490 },
    { id: 'enterprise', name: 'Enterprise', maxUsers: 0, maxProducts: 0, priceTHB: 0 },
  ],
  contactEmail: 'you@example.com',
};

const USER = { id: 1, username: 'admin', name: 'A', role: 'platform_admin', active: true };
const calls = [];
// Signed out until the login call arrives, so the test walks the same path a
// person does: the login form first, then the console.
let signedIn = false;
window.fetch = async (url, opts = {}) => {
  calls.push(String(url));
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  const unauthorized = () => ({ ok: false, status: 401, text: async () => JSON.stringify({ detail: 'Not authenticated' }) });
  if (String(url).includes('/api/platform/login')) {
    const sent = JSON.parse((opts.body || '{}'));
    if (sent.username === 'admin' && sent.password === 'a-good-password') {
      signedIn = true;
      return reply({ token: 'test-token', user: USER });
    }
    return { ok: false, status: 401, text: async () => JSON.stringify({ detail: 'Invalid username or password' }) };
  }
  if (String(url).includes('/api/platform/me')) return signedIn ? reply({ user: USER }) : unauthorized();
  if (String(url).includes('/api/platform/stores')) return reply(STORES);
  if (String(url).includes('/api/platform/logout')) return reply({ ok: true });
  return reply({});
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => window.document.body.textContent || '';

(async () => {
  await sleep(600);
  ok('the bundle boots without throwing', errors.length === 0, errors.join('\n'));
  ok('the login screen appears', /Platform administration/i.test(text()), text().slice(0, 200));

  // Sign in the way a person does: type into the fields and submit.
  const doc = window.document;
  const inputs = [...doc.querySelectorAll('input')];
  const userField = inputs[0];
  const passField = inputs[1];
  ok('username and password fields are present', !!userField && !!passField, `found ${inputs.length} inputs`);

  if (userField && passField) {
    const setValue = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    setValue(userField, 'admin');
    setValue(passField, 'a-good-password');
    await sleep(120);
    const form = userField.closest('form') || doc.querySelector('form');
    ok('the sign-in form is there', !!form);
    form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await sleep(600);
  }

  ok('signing in does not throw', errors.length === 0, errors.join('\n'));
  ok('the console is shown after sign-in', /Stores/i.test(text()), text().slice(0, 300));
  ok('the signed-in user is named', /admin/.test(text()), text().slice(0, 200));
  ok('the store list rendered', /siamkitchen/.test(text()), text().slice(0, 300));
  ok('the "New store" button rendered', /New store/.test(text()), text().slice(0, 300));
  ok('a live store is shown', /Live stores/i.test(text()), text().slice(0, 300));
  ok('the page is not blank', text().trim().length > 40, `only ${text().trim().length} characters rendered`);
  ok('the sign-in call was made', calls.some((c) => c.includes('/api/platform/login')), calls.join(', '));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
