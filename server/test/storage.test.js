// The storage contract.
//
// The point of this file is that a second engine can be added without anyone
// having to trust that it behaves like the first. Anything an engine has to
// guarantee is asserted here, so the SQLite backend gets the same treatment
// the file engine does before it is allowed anywhere near a real till.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createAdapter, jsonFileAdapter } = require('../src/storage');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'everlyce-storage-'));
  return dir;
}

const tmp = [];
function adapterIn(dir, options = {}) {
  const a = jsonFileAdapter({ dir, ...options });
  tmp.push(dir);
  return a;
}

console.log('\n== the engine is chosen by config ==');
{
  const dir = scratch();
  const a = adapterIn(dir);
  ok('the default engine is the file engine', a.name === 'json', a.name);
  ok('POS_STORAGE=sqlite is refused rather than silently falling back', (() => {
    try { createAdapter({ engine: 'sqlite' }); return false; } catch (e) { return /not implemented/.test(e.message); }
  })());
  ok('the refusal names the setting to use instead', (() => {
    try { createAdapter({ engine: 'sqlite' }); return false; } catch (e) { return /POS_STORAGE=json/.test(e.message); }
  })());
  ok('an unknown engine fails loudly', (() => {
    try { createAdapter({ engine: 'postgres' }); return false; } catch (e) { return /Unknown storage engine/.test(e.message); }
  })());
  ok('"file" is accepted as a name for the same engine', createAdapter({ engine: 'file', dir }).name === 'json');
}

console.log('\n== a round trip ==');
{
  const dir = scratch();
  const a = adapterIn(dir);
  ok('a fresh directory has nothing stored', a.load() === null, a.load());
  const snapshot = { schemaVersion: 3, stores: [{ id: 1, slug: 'one' }], storeData: { 1: { users: [{ id: 1 }] } } };
  a.commit(snapshot, null);
  const back = a.load();
  ok('what goes in comes back', JSON.stringify(back) === JSON.stringify(snapshot), back);
  ok('and it parses as the same document, not a string', back && Array.isArray(back.stores), typeof back);
}

console.log('\n== a failed write cannot lose the old data ==');
{
  const dir = scratch();
  const a = adapterIn(dir);
  const good = { schemaVersion: 3, stores: [{ id: 1, slug: 'safe' }], storeData: {} };
  a.commit(good, null);
  // A value JSON cannot represent is the realistic shape of this failure: a
  // BigInt, a circular reference, or a bug that puts a function in the state.
  const broken = { schemaVersion: 3, stores: good.stores, storeData: {} };
  broken.self = broken;
  let threw = false;
  try { a.commit(broken, good); } catch (e) { threw = true; }
  ok('an unwritable snapshot is refused', threw);
  const after = a.load();
  ok('the previous snapshot is still intact and complete',
    after && after.stores.length === 1 && after.stores[0].slug === 'safe', after);
  ok('the file on disk is still valid json', (() => {
    try { JSON.parse(fs.readFileSync(a.dataFile, 'utf8')); return true; } catch (e) { return false; }
  })());
  ok('no temporary file was left behind', !fs.readdirSync(dir).some((n) => n.endsWith('.tmp')),
    fs.readdirSync(dir));
}

console.log('\n== backups rotate instead of overwriting ==');
{
  const dir = scratch();
  const a = adapterIn(dir, { file: path.join(dir, 'data.json'), backupDir: path.join(dir, 'backups') });
  const names = [];
  for (let i = 0; i < 5; i += 1) {
    a.commit({ schemaVersion: 3, generation: i, stores: [], storeData: {} }, i === 0 ? null : { schemaVersion: 3, generation: i - 1, stores: [], storeData: {} });
    const found = (fs.existsSync(a.backupDir) ? fs.readdirSync(a.backupDir) : []).filter((n) => /^data-\d{8}-\d{6}-\d{3}(-\d+)?\.json$/.test(n));
    names.push(found.length);
  }
  ok('each write adds a backup rather than replacing the last one',
    names[1] === 1 && names[2] === 2 && names[4] === 4, names);
  ok('the backups are readable documents', (() => {
    try {
      for (const n of fs.readdirSync(a.backupDir)) JSON.parse(fs.readFileSync(path.join(a.backupDir, n), 'utf8'));
      return true;
    } catch (e) { return false; }
  })());
  ok('a backup is owner-only too', (() => {
    const n = fs.readdirSync(a.backupDir)[0];
    if (!n) return false;
    return (fs.statSync(path.join(a.backupDir, n)).mode & 0o777) === 0o600;
  })());
  ok('the first write makes no backup, because there was nothing to lose', names[0] === 0, names[0]);
}

console.log('\n== the window is bounded ==');
{
  const dir = scratch();
  const backupDir = path.join(dir, 'backups');
  const a = adapterIn(dir, { file: path.join(dir, 'data.json'), backupDir });
  // Write more generations than the window holds and let the adapter trim. A
  // driving clock keeps every write in its own millisecond, so this exercises
  // the ordinary path rather than the same-millisecond collision suffix.
  const keep = require('../src/storage').KEEP;
  let tick = 0;
  const driven = jsonFileAdapter({ dir, file: path.join(dir, 'data.json'), backupDir, clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, (tick * 7) % 1000)) });
  let previous = null;
  for (let i = 0; i < keep + 6; i += 1) {
    tick = i;
    const next = { schemaVersion: 3, generation: i, stores: [], storeData: {} };
    driven.commit(next, previous);
    previous = next;
  }
  // The same pattern the adapter trims with. A looser filter here is what let
  // an untrimmed filename go unnoticed, so it is asserted to agree.
  const PATTERN = /^data-\d{8}-\d{6}-\d{3}(-\d+)?\.json$/;
  const kept = fs.readdirSync(backupDir).filter((n) => PATTERN.test(n));
  const everything = fs.readdirSync(backupDir).filter((n) => n.startsWith('data-'));
  ok('the test and the adapter agree on what a backup is called', kept.length === everything.length,
    { matched: kept.length, onDisk: everything.length, extra: everything.filter((n) => !PATTERN.test(n)) });
  ok('the window never exceeds the configured keep count', kept.length === keep, kept.length);
  ok('the default window keeps ten generations', keep === 10, keep);
  // A millisecond under 100 is the case that used to escape the trim.
  const early = jsonFileAdapter({ dir, file: path.join(dir, 'data.json'), backupDir: path.join(dir, 'b2'), clock: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 7)) });
  early.commit({ schemaVersion: 3, a: 1, stores: [], storeData: {} }, null);
  early.commit({ schemaVersion: 3, a: 2, stores: [], storeData: {} }, { schemaVersion: 3, a: 1, stores: [], storeData: {} });
  early.commit({ schemaVersion: 3, a: 3, stores: [], storeData: {} }, { schemaVersion: 3, a: 2, stores: [], storeData: {} });
  const earlyNames = fs.readdirSync(path.join(dir, 'b2'));
  ok('a backup written 7ms into a second is still a recognisable name',
    earlyNames.every((n) => PATTERN.test(n)), earlyNames);
}

console.log('\n== describe() tells the truth ==');
{
  const dir = scratch();
  const a = adapterIn(dir);
  const before = a.describe();
  ok('a fresh store reports no size yet', before.sizeBytes === 0 && before.modifiedAt === null, before);
  a.commit({ schemaVersion: 3, stores: [], storeData: {} }, null);
  const after = a.describe();
  ok('after a write it reports a size and a time', after.sizeBytes > 0 && !!after.modifiedAt, after);
  ok('it names the engine', after.engine === 'json', after.engine);
  ok('it reports the backup window', after.backups && typeof after.backups.count === 'number' && typeof after.backups.keep === 'number', after.backups);
}

console.log('\n== the data file is not world readable ==');
{
  const dir = scratch();
  const a = adapterIn(dir);
  a.commit({ schemaVersion: 3, stores: [], storeData: {} }, null);
  const mode = fs.statSync(a.dataFile).mode & 0o777;
  ok('the data file is owner-only', mode === 0o600, mode.toString(8));
  const dirMode = fs.statSync(dir).mode & 0o777;
  ok('the directory is owner-only', dirMode === 0o700, dirMode.toString(8));
}

console.log('\n== the server still boots on the adapter ==');
{
  const dir = scratch();
  tmp.push(dir);
  const { spawn } = require('child_process');
  const port = 19510;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      POS_DATA_DIR: dir,
      POS_STORAGE: 'json',
      PORT: String(port),
      POS_DEFAULT_STORE_SLUG: 'conformance',
      POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: 'everlyce-test-password',
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: 'everlyce-test-password',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  (async () => {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) { up = true; break; } } catch (e) {}
      await new Promise((r) => setTimeout(r, 100));
    }
    ok('a fresh install boots with POS_STORAGE set explicitly', up, log.split('\n').slice(-4).join(' | '));
    ok('and writes its data through the adapter', fs.existsSync(path.join(dir, 'data.json')));
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    ok('the document it wrote is a v3 multi-store shape', doc.schemaVersion === 3 && !!doc.storeData, Object.keys(doc || {}));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));

    for (const d of tmp) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    if (/Error/.test(log)) {
      console.log('\n--- server log ---');
      console.log(log.split('\n').filter((l) => /Error/.test(l)).slice(0, 6).join('\n'));
    }
    process.exit(fail ? 1 : 0);
  })();
}
