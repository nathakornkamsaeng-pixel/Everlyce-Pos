// The api helpers decide which token to send from opts.platform. An earlier
// version of del() dropped its options argument, so every platform delete went
// out with no Authorization header and came back "Not authenticated". This
// asserts the options actually reach the request, per verb.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.join(process.cwd(), 'src', 'lib', 'api.js');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${extra}` : ''}`); }
}

const source = readFileSync(SRC, 'utf8');

console.log('== every http helper forwards its options ==');
for (const verb of ['get', 'post', 'put', 'del']) {
  const line = (source.match(new RegExp(`^export const ${verb} = .*$`, 'm')) || [''])[0];
  ok(`${verb} is defined`, Boolean(line), 'helper missing');
  if (!line) continue;
  const params = (line.match(/\(([^)]*)\)/) || ['', ''])[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const takesOpts = params.some((p) => /opts/.test(p));
  const passesOpts = /request\(/.test(line) && /opts\)/.test(line.replace(/, undefined, opts\)/, ', opts)'));
  ok(`${verb} accepts opts`, takesOpts, line);
  ok(`${verb} passes opts to request`, passesOpts, line);
}

console.log('\n== request() actually uses opts.platform to choose the token ==');
const body = source.slice(source.indexOf('async function request('));
const usesPlatform = /const platform = opts\.platform === true;/.test(body);
const usesPlatformToken = /platform \? api\.platformToken : api\.token/.test(body);
ok('opts.platform is read', usesPlatform);
ok('it selects the platform token', usesPlatformToken);
ok('a platform call omits X-POS-Store', /!platform && currentStore/.test(body));

console.log('\n== no call site passes options to a helper that cannot take them ==');
// A mistake worth catching is del(path, { platform: true }) on a helper that
// only accepts a path, which is silent rather than a type error.
const files = ['src/pages/PlatformConsole.jsx', 'src/lib/branch.jsx', 'src/pages/Loyalty.jsx',
  'src/pages/Tables.jsx', 'src/pages/Modifiers.jsx', 'src/pages/Menu.jsx', 'src/pages/Users.jsx',
  'src/pages/DataCenter.jsx', 'src/pages/Checkout.jsx', 'src/pages/Settings.jsx', 'src/pages/Discounts.jsx'];
for (const rel of files) {
  let src;
  try { src = readFileSync(path.join(process.cwd(), rel), 'utf8'); } catch (e) { continue; }
  // del(path, opts) / put(path, body, opts) both use two or three arguments.
  const bad = [];
  for (const m of src.matchAll(/\b(del|put|post|get)\(([^()]*?)\)\s*[.;)]/g)) {
    const args = m[2];
    // Count top-level commas only, so an object body is not mistaken for args.
    let depth = 0;
    let commas = 0;
    for (const ch of args) {
      if ('{[(<'.includes(ch)) depth += 1;
      else if('}])>'.includes(ch)) depth -= 1;
      else if (ch === ',' && depth === 0) commas += 1;
    }
    const count = commas + 1;
    const maxArgs = m[1] === 'del' || m[1] === 'get' ? 2 : 3;
    if (count > maxArgs) bad.push(`${m[1]}(...${count} args)`);
  }
  ok(`${rel} calls helpers with a supported number of arguments`, bad.length === 0, bad.join(', '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
