// Drives the platform console settings: changing the contact details, the LINE
// link appearing on the public screens, and changing the password. The panel is
// reached from a button in the header, so a missing wiring shows up here as a
// panel that never renders.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from '/opt/pos/node_modules/jsdom/lib/api.js';
import { build } from '/opt/pos/node_modules/esbuild/lib/main.js';

const BUNDLE = path.join('/tmp', `pos-settings-${process.pid}.js`);
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
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${String(extra).slice(0, 240)}` : ''}`); }
}

const PASSWORD = 'a-good-password';
const NEW_PASSWORD = 'a-much-longer-password';

function boot({ initialLine = '', path = '/platform' } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: `https://pos.example.com${path}`, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  const style = window.document.createElement('style');
  window.document.head.appendChild(style);
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(BUNDLE, 'utf8');
  window.document.head.appendChild(script);
  window.__errors = errors;

  const state = { config: { contactEmail: 'you@example.com', lineOpenChatUrl: initialLine }, signedIn: false, configCalls: 0, patchCalls: [], passwordCalls: [] };
  const USER = { id: 1, username: 'admin', name: 'A', role: 'platform_admin', active: true };

  window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const reply = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (u.includes('/api/platform/config') && (opts.method || 'GET') === 'GET') {
      state.configCalls += 1;
      return reply(state.config);
    }
    if (u.includes('/api/platform/config') && opts.method === 'PATCH') {
      state.patchCalls.push(body);
      if (body.lineOpenChatUrl && !/^https:\/\/line\.me\//.test(body.lineOpenChatUrl)) {
        return { ok: false, status: 400, text: async () => JSON.stringify({ detail: 'The LINE link must be a line.me address' }) };
      }
      state.config = { contactEmail: body.contactEmail || state.config.contactEmail, lineOpenChatUrl: body.lineOpenChatUrl ?? state.config.lineOpenChatUrl };
      return reply(state.config);
    }
    if (u.includes('/api/platform/password')) {
      state.passwordCalls.push(body);
      if (body.currentPassword === PASSWORD && body.newPassword === NEW_PASSWORD) {
        state.signedIn = false;
        return reply({ ok: true, message: 'Password changed. Please sign in again.' });
      }
      return { ok: false, status: 401, text: async () => JSON.stringify({ detail: 'That is not your current password' }) };
    }
    if (u.includes('/api/platform/login')) {
      if (body.username === 'admin' && (body.password === PASSWORD || body.password === NEW_PASSWORD)) {
        state.signedIn = true;
        return reply({ token: 't', user: USER });
      }
      return { ok: false, status: 401, text: async () => JSON.stringify({ detail: 'Invalid username or password' }) };
    }
    if (u.includes('/api/platform/me')) {
      return state.signedIn ? reply({ user: USER }) : { ok: false, status: 401, text: async () => JSON.stringify({ detail: 'Not authenticated' }) };
    }
    if (u.includes('/api/platform/logout')) { state.signedIn = false; return reply({ ok: true }); }
    if (u.includes('/api/platform/stores')) {
      return reply({ stores: [{ id: 1, slug: 'newshop', name: 'New Shop', status: 'active', plan: 'enterprise', planName: 'Enterprise', planMonths: 0, restaurantName: 'New Shop', createdAt: '2026-01-01T00:00:00.000Z', activatedAt: null, contactName: null, contactEmail: null, contactPhone: null, note: null, source: 'admin', hasKey: false, keyHint: null, keyIssuedAt: null, keyExpiresAt: null, keyUsedAt: null, keyRevokedAt: null, stats: { users: 2, products: 5, orders: 3, tables: 4, branches: 1 } }], plans: [{ id: 'enterprise', name: 'Enterprise', maxUsers: 0, maxProducts: 0, priceTHB: 0 }], ...state.config });
    }
    if (u.includes('/api/platform/store/')) return reply({ store: { id: 1, slug: 'newshop', name: 'New Shop', status: 'active', restaurantName: 'New Shop' }, ...state.config });
    return reply({});
  };
  return { window, state };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (window) => window.document.body.textContent || '';
const setValue = (window, el, v) => {
  const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const byText = (window, re) => [...window.document.querySelectorAll('button')].find((b) => re.test(b.textContent || ''));

async function signIn(env) {
  const { window } = env;
  await sleep(500);
  const inputs = [...window.document.querySelectorAll('input')];
  setValue(window, inputs[0], 'admin');
  setValue(window, inputs[1], PASSWORD);
  await sleep(100);
  (inputs[0].closest('form') || window.document.querySelector('form'))
    .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await sleep(500);
}

const env = boot();
console.log('== sign in, then open settings ==');
await signIn(env);
ok('no errors after sign-in', env.window.__errors.length === 0, env.window.__errors.join('\n'));
ok('the console rendered', /Stores/.test(text(env.window)), text(env.window).slice(0, 160));

const settingsBtn = byText(env.window, /Settings/);
ok('there is a Settings button', !!settingsBtn, [...env.window.document.querySelectorAll('button')].map((b) => b.textContent).join(' | '));
if (settingsBtn) {
  settingsBtn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);
}

console.log('\n== the settings panel renders ==');
const emailFieldValue = () => env.window.document.querySelector('input[type="email"]')?.value;
ok('it has a contact email field', !!emailFieldValue, 'no email input');
const lineInput = [...env.window.document.querySelectorAll('input')].find((i) => /line\.me/.test(i.placeholder || ''));
ok('it has a LINE link field', !!lineInput, [...env.window.document.querySelectorAll('input')].map((i) => i.placeholder).join(' | '));
// The address lives in the input's value, not in the page text.
ok('it pre-fills the current address', emailFieldValue() === 'you@example.com', emailFieldValue());
ok('it has a current password field', [...env.window.document.querySelectorAll('input[type="password"]')].length >= 3, 'expected 3 password fields');

console.log('\n== changing the contact email ==');
setValue(env.window, env.window.document.querySelector('input[type="email"]'), 'help@mycompany.com');
await sleep(80);
const saveContact = byText(env.window, /Save contact details/);
ok('there is a save button', !!saveContact);
if (saveContact) {
  saveContact.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
}
ok('the change is sent to the server', env.state.patchCalls.some((c) => c.contactEmail === 'help@mycompany.com'), env.state.patchCalls);
ok('the new address is confirmed on screen', /saved/i.test(text(env.window)), text(env.window).slice(0, 260));

console.log('\n== the LINE link is saved ==');
setValue(env.window, lineInput, 'https://line.me/R/ti/p/@abcd1234');
await sleep(80);
const saveLine = byText(env.window, /Save contact details/);
if (saveLine) {
  saveLine.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
}
ok('the LINE link is stored', env.state.config.lineOpenChatUrl === 'https://line.me/R/ti/p/@abcd1234', env.state.config);
const joinBtn = [...env.window.document.querySelectorAll('a')].find((a) => /line\.me\/R\/ti/.test(a.getAttribute('href') || ''));
ok('a LINE link is offered on the console', !!joinBtn, [...env.window.document.querySelectorAll('a')].map((a) => a.getAttribute('href')).join(' | '));

console.log('\n== a bad LINE link is refused ==');
setValue(env.window, lineInput, 'https://evil.example/R/ti/p/@x');
await sleep(80);
const saveBad = byText(env.window, /Save contact details/);
if (saveBad) {
  saveBad.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
}
ok('the server refused it', env.state.config.lineOpenChatUrl === 'https://line.me/R/ti/p/@abcd1234', env.state.config.lineOpenChatUrl);
ok('the error is shown', /line\.me/i.test(text(env.window)), text(env.window).slice(0, 300));

console.log('\n== changing the password ==');
const pwFields = [...env.window.document.querySelectorAll('input[type="password"]')];
ok('three password fields are present', pwFields.length >= 3, `found ${pwFields.length}`);
setValue(env.window, pwFields[0], 'the-wrong-current-one');
setValue(env.window, pwFields[1], NEW_PASSWORD);
setValue(env.window, pwFields[2], NEW_PASSWORD);
await sleep(100);
const changeBtn = byText(env.window, /Change password/);
ok('there is a change button', !!changeBtn);
if (changeBtn) {
  changeBtn.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(400);
}
ok('a wrong current password is reported', /not your current password/i.test(text(env.window)), text(env.window).slice(0, 300));

setValue(env.window, pwFields[0], PASSWORD);
setValue(env.window, pwFields[1], NEW_PASSWORD);
setValue(env.window, pwFields[2], 'a-different-confirmation');
await sleep(100);
const changeBtn2 = byText(env.window, /Change password/);
if (changeBtn2) {
  changeBtn2.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);
}
ok('mismatched confirmation is caught before the server', /do not match/i.test(text(env.window)), text(env.window).slice(0, 300));

setValue(env.window, pwFields[2], NEW_PASSWORD);
await sleep(100);
const changeBtn3 = byText(env.window, /Change password/);
if (changeBtn3) {
  changeBtn3.dispatchEvent(new env.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(500);
}
ok('the password change is sent', env.state.passwordCalls.some((c) => c.newPassword === NEW_PASSWORD), env.state.passwordCalls);
ok('the session is signed out afterwards', env.state.signedIn === false, env.state.signedIn);
ok('nothing threw', env.window.__errors.length === 0, env.window.__errors.join('\n'));

// The LINE button appeared on the main site next to "Self host this" and "Start
// your trial". Both of those are gone from this build: there is no hosted signup
// to send anyone to, and no operator to chat with. The setting and the component
// stay, because the activation screen still offers it and an operator may want it
// for their own support, but the public page no longer advertises a way to reach
// the platform owner.
console.log('\n== the public page no longer offers a way to contact the platform ==');
for (const configured of [true, false]) {
  const site = boot({ initialLine: configured ? 'https://line.me/R/ti/p/@abcd1234' : '', path: '/' });
  const { window } = site;
  await sleep(700);
  const buttons = [...window.document.querySelectorAll('a')].filter((a) => /line\.me/i.test(a.getAttribute('href') || ''));
  const page = window.document.body.textContent || '';
  ok('no LINE button on the public page, configured or not', buttons.length === 0, buttons.map((b) => b.getAttribute('href')).join(' | '));
  ok('the page still renders', /Everlyce/.test(page), page.slice(0, 160));
  ok('and it still says what this is', /Your shop|server/i.test(page), page.slice(0, 200));
  ok('with no trial and no pricing', !/free trial|days free|per month|฿/.test(page), page.slice(0, 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
