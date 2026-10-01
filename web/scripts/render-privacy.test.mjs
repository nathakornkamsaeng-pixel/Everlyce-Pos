// Renders the public privacy notice and the new logo. The notice is the
// document a customer is entitled to read before their data is collected, so it
// has to actually render, in both languages, with the shop's real details in it.
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from '/opt/pos/node_modules/jsdom/lib/api.js';
import { build } from '/opt/pos/node_modules/esbuild/lib/main.js';

const BUNDLE = path.join('/tmp', `pos-privacy-${process.pid}.js`);
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
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${String(extra).slice(0, 220)}` : ''}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NOTICE = {
  version: '1.0',
  controller: { legalName: 'Siam Kitchen Co., Ltd.', contactEmail: 'privacy@shop.co.th' },
  purposes: { loyalty: 'Loyalty points and member benefits', marketing: 'Promotions and offers', service: 'Service the account' },
  retentionDays: 365,
  rights: [
    { id: 'access', label: 'Ask for a copy of your data' },
    { id: 'correct', label: 'Ask for your data to be corrected' },
    { id: 'erase', label: 'Ask for your data to be deleted' },
    { id: 'withdraw', label: 'Withdraw consent' },
    { id: 'object', label: 'Object to processing' },
  ],
};

function boot(route) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: `https://pos.example.com${route}`, runScripts: 'dangerously', pretendToBeVisual: true,
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.error || e.message)));
  window.addEventListener('unhandledRejection', (e) => errors.push(String(e.reason)));
  const style = window.document.createElement('style');
  window.document.head.appendChild(style);
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(BUNDLE, 'utf8');
  window.document.head.appendChild(script);
  window.__errors = errors;
  window.fetch = async (url) => {
    const u = String(url);
    const reply = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });
    // The page reads the store-independent public notice, which is what a
    // signed-out visitor with no store header can actually fetch.
    if (u.includes('/api/public/privacy-notice')) return reply({ store: 'myrestaurant', ...NOTICE });
    if (u.includes('/api/platform/config')) return reply({ contactEmail: 'you@example.com', lineOpenChatUrl: '' });
    return reply({});
  };
  return window;
}

console.log('== the privacy notice renders ==');
const window = boot('/privacy');
await sleep(700);
const text = window.document.body.textContent || '';

ok('no errors', window.__errors.length === 0, window.__errors.join('\n'));
ok('the page is not blank', text.trim().length > 200, `${text.trim().length} characters`);
ok('it is titled', /นโยบายความเป็นส่วนตัว|Privacy notice/.test(text), text.slice(0, 140));
ok('it cites the PDPA', /2562|PDPA/.test(text), text.slice(0, 200));
ok('it names the controller', text.includes('Siam Kitchen Co., Ltd.'), text.slice(0, 300));
ok('it gives the privacy contact', text.includes('privacy@shop.co.th'), text.slice(0, 400));
ok('it states the retention period', /365/.test(text), text.slice(0, 400));
ok('it lists the rights', /access/.test(text) && /erase/.test(text) && /withdraw/.test(text), text.slice(0, 400));
ok('it mentions security', /salted hashes|เข้ารหัส/.test(text), text.slice(0, 400));
ok('it mentions breach notification', /PDPC|คณะกรรมการคุ้มครองข้อมูลส่วนบุคคล/.test(text), text.slice(0, 400));
ok('the email is a mailto link', [...window.document.querySelectorAll('a')].some((a) => a.getAttribute('href') === 'mailto:privacy@shop.co.th'), [...window.document.querySelectorAll('a')].map((a) => a.getAttribute('href')).join(' | '));
ok('a link back to the site exists', [...window.document.querySelectorAll('a')].some((a) => a.getAttribute('href') === '/'), 'no home link');

console.log('\n== it can be read in English ==');
const toggle = [...window.document.querySelectorAll('button')].find((b) => /English|ไทย/.test(b.textContent || ''));
ok('there is a language toggle', !!toggle, [...window.document.querySelectorAll('button')].map((b) => b.textContent).join(' | '));
if (toggle) {
  toggle.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await sleep(300);
  const after = window.document.body.textContent || '';
  ok('switching to English works', /Privacy notice/.test(after), after.slice(0, 160));
  ok('the Thai title is gone', !/นโยบายความเป็นส่วนตัว/.test(after), after.slice(0, 160));
  ok('the content is still complete', after.includes('Siam Kitchen Co., Ltd.') && /365/.test(after), after.slice(0, 300));
  ok('switching did not throw', window.__errors.length === 0, window.__errors.join('\n'));
}

console.log('\n== the logo suite is valid and self-contained ==');
const SVG_ASSETS = [
  'logo.svg',
  'logo-mark.svg',
  'logo-dark.svg',
  'logo-mono.svg',
  'favicon.svg',
  'wordmark.svg',
  'app-icon.svg',
  'social-card.svg',
];
for (const name of SVG_ASSETS) {
  const file = `public/brand/${name}`;
  const svg = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  ok(`${name} parses`, svg.trim().startsWith('<svg') && svg.trim().endsWith('</svg>'), svg.slice(0, 60));
  ok(`${name} has a viewBox`, /viewBox="[\d.\s-]+"/.test(svg), 'no viewBox');
  ok(`${name} has no external refs`, !/(xlink:href|href)="(?!#|data:)/.test(svg), 'external reference found');
  ok(`${name} is accessible`, /role="img"|<title/.test(svg), 'no title or role');
  const defs = (svg.match(/<defs>([\s\S]*?)<\/defs>/) || ['', ''])[1];
  ok(`${name} paints its gradient`, !/<rect[^>]*url\(/.test(defs), 'rect left inside defs is never painted');
}

console.log('\n== the mark is the E ==');
const mark = fs.readFileSync(path.join(process.cwd(), 'public/brand/logo.svg'), 'utf8');
// Three equal-height bars, a shorter accented middle arm, and a stem. These
// are the values that keep the letter reading as an E instead of an F.
ok('the stem is present', /<rect x="72" y="64" width="30" height="128"/.test(mark), 'stem missing');
ok('the middle arm is shorter than the others', /width="86" height="30"/.test(mark), 'middle arm not shortened');
ok('the middle arm carries the accent', /width="86" height="30" rx="15" fill="#3ddc97"/.test(mark), 'accent not on the middle arm');
ok('the old receipt mark is gone', !/receipt|zig-zag|scan line/i.test(mark), 'receipt geometry still present');

for (const name of ['logo.png', 'apple-touch-icon.png', 'favicon-16.png', 'favicon-32.png', 'social-card.png']) {
  const buf = fs.readFileSync(path.join(process.cwd(), 'public/brand', name));
  ok(`${name} is a real png`, buf.length > 200 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, `${buf.length} bytes`);
}

const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
ok('the favicon points at the new mark', html.includes('/brand/favicon.svg'), 'favicon link missing');
ok('there is a png favicon fallback', html.includes('/brand/favicon-32.png') && html.includes('/brand/favicon-16.png'), 'png fallback missing');
ok('apple touch icon is a png, not an svg', html.includes('/brand/apple-touch-icon.png') && !/apple-touch-icon" href="\/brand\/[^"]*\.svg/.test(html), 'ios cannot read an svg icon');
ok('the social card is linked', html.includes('/brand/social-card.png'), 'og:image missing');
ok('no leftover old brand asset', !fs.existsSync(path.join(process.cwd(), 'public/brand/logo-old.svg')), 'stray file');

// The brand files are unversioned paths, so a long-lived cache anywhere in
// front of the app would keep serving the previous artwork.
const headUrls = [...html.matchAll(/\/brand\/[a-z0-9.-]+\.(?:svg|png)(?:\?[^"']*)?/g)].map((m) => m[0]);
ok('the head links brand assets', headUrls.length >= 5, `found ${headUrls.length}`);
ok('every head brand url is versioned', headUrls.length > 0 && headUrls.every((u) => /\?v=\d+$/.test(u)), headUrls.join(' '));

const brandAssetsSrc = fs.readFileSync(path.join(process.cwd(), 'src/lib/brand-assets.js'), 'utf8');
const brandVersion = (brandAssetsSrc.match(/BRAND_VERSION\s*=\s*(\d+)/) || [])[1];
ok('BRAND_VERSION is defined', !!brandVersion, 'not found in src/lib/brand-assets.js');
ok('index.html uses the same version', headUrls.every((u) => u.endsWith(`?v=${brandVersion}`)), `version ${brandVersion}`);

for (const f of ['src/branding.jsx', 'src/pages/Landing.jsx', 'src/pages/PlatformConsole.jsx', 'src/lib/receiptExport.js']) {
  const s = fs.readFileSync(path.join(process.cwd(), f), 'utf8');
  ok(`${f} uses the versioned brand url`, !/["'`]\/brand\/logo\.svg["'`]/.test(s), 'hardcoded /brand/logo.svg');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
