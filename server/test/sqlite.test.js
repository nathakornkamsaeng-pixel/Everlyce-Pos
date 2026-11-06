// SQLite engine: round trip, a failed write, the JSON migration.
//
// The file engine's conformance suite stays in storage.test.js. This file is
// the part that only exists once POS_STORAGE=sqlite is a real engine, including
// the one-shot copy off JSON. It must not write server/data.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { createAdapter, sqliteAdapter } = require('../src/storage');
const { migrateJsonToSqlite } = require('../src/storage/migrate');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'everlyce-sqlite-'));
}

const tmp = [];
function keep(dir) { tmp.push(dir); return dir; }

const snapshot = {
  schemaVersion: 3,
  stores: [{ id: 1, slug: 'one', name: 'One' }],
  storeData: { 1: { users: [{ id: 1, username: 'a' }], orders: [] } },
};

console.log('\n== a round trip on sqlite ==');
{
  const dir = keep(scratch());
  const a = sqliteAdapter({ dir });
  ok('a fresh directory has nothing stored', a.load() === null);
  a.commit(snapshot, null);
  const back = a.load();
  ok('what goes in comes back', JSON.stringify(back) === JSON.stringify(snapshot), back);
  ok('the database file is sqlite, not a renamed json document',
    fs.readFileSync(a.dataFile).subarray(0, 15).toString('utf8') === 'SQLite format 3');
  ok('no JSON snapshot was written beside it', !fs.existsSync(path.join(dir, 'data.json')));
  const mode = fs.statSync(a.dataFile).mode & 0o777;
  ok('the database file is owner-only', mode === 0o600, mode.toString(8));
  const described = a.describe();
  ok('describe names sqlite and a size', described.engine === 'sqlite' && described.sizeBytes > 0, described.engine);
  ok('describe states the durability story', /synchronous=FULL/.test(described.durability), described.durability);
}

console.log('\n== a failed write cannot lose the old row ==');
{
  const dir = keep(scratch());
  const a = sqliteAdapter({ dir });
  const good = { schemaVersion: 3, stores: [{ id: 1, slug: 'safe' }], storeData: {} };
  a.commit(good, null);
  const broken = { schemaVersion: 3, stores: good.stores, storeData: {} };
  broken.self = broken;
  let threw = false;
  try { a.commit(broken, good); } catch (e) { threw = true; }
  ok('an unwritable snapshot is refused', threw);
  const after = a.load();
  ok('the previous snapshot is still the one stored',
    after && after.stores[0].slug === 'safe', after);
}

console.log('\n== a later commit keeps the previous generation ==');
{
  const dir = keep(scratch());
  let tick = 0;
  const a = sqliteAdapter({
    dir,
    clock: () => new Date(Date.UTC(2026, 0, 2, 0, 0, 0, tick)),
  });
  a.commit({ schemaVersion: 3, generation: 1, stores: [], storeData: {} }, null);
  tick = 8;
  a.commit({ schemaVersion: 3, generation: 2, stores: [], storeData: {} }, null);
  const names = fs.readdirSync(a.backupDir).filter((n) => n.endsWith('.json'));
  ok('only the generation that was replaced is backed up', names.length === 1, names);
  const prior = JSON.parse(fs.readFileSync(path.join(a.backupDir, names[0]), 'utf8'));
  ok('the backup is the generation that was replaced', prior.generation === 1, prior);
  ok('the live row is the new generation', a.load().generation === 2);
  const backupMode = fs.statSync(path.join(a.backupDir, names[0])).mode & 0o777;
  ok('the backup is owner-only', backupMode === 0o600, backupMode.toString(8));
}

console.log('\n== json to sqlite, backup first ==');
{
  const dir = keep(scratch());
  const json = createAdapter({ engine: 'json', dir });
  json.commit(snapshot, null);
  const result = migrateJsonToSqlite({ dir, clock: () => new Date(Date.UTC(2026, 3, 4, 5, 6, 7, 8)) });
  ok('the migration names the backup it took first', fs.existsSync(result.backup), result.backup);
  const copied = JSON.parse(fs.readFileSync(result.backup, 'utf8'));
  ok('that backup is the document that was migrated', copied.stores[0].slug === 'one', copied.stores);
  const live = sqliteAdapter({ dir }).load();
  ok('sqlite holds the same document', JSON.stringify(live) === JSON.stringify(snapshot));
  ok('data.json is still there, so the flag can stay on json',
    JSON.stringify(JSON.parse(fs.readFileSync(json.dataFile, 'utf8'))) === JSON.stringify(snapshot));
  let refused = null;
  try { migrateJsonToSqlite({ dir, clock: () => new Date(Date.UTC(2026, 3, 4, 5, 6, 8, 9)) }); }
  catch (e) { refused = e; }
  ok('a second run refuses to overwrite', refused && refused.code === 'migration_target_exists', refused && refused.code);
  ok('and the row was not replaced with anything else', sqliteAdapter({ dir }).load().stores[0].slug === 'one');

  const replaced = migrateJsonToSqlite({
    dir,
    replace: true,
    clock: () => new Date(Date.UTC(2026, 3, 4, 5, 6, 9, 10)),
  });
  ok('replace is explicit', replaced.replaced === true);
}

console.log('\n== a bad source never creates a database ==');
{
  const missing = keep(scratch());
  let missingErr = null;
  try { migrateJsonToSqlite({ dir: missing }); } catch (e) { missingErr = e; }
  ok('a missing file is refused', missingErr && missingErr.code === 'migration_source_missing');
  ok('and no database file appears', !fs.existsSync(path.join(missing, 'data.sqlite')));

  const bad = keep(scratch());
  fs.writeFileSync(path.join(bad, 'data.json'), '{', { mode: 0o600 });
  let badErr = null;
  try { migrateJsonToSqlite({ dir: bad, clock: () => new Date(Date.UTC(2026, 5, 1, 0, 0, 0, 1)) }); }
  catch (e) { badErr = e; }
  ok('a snapshot that does not parse is refused', badErr && badErr.code === 'migration_source_invalid', badErr && badErr.message);
  ok('sqlite was not created for it', !fs.existsSync(path.join(bad, 'data.sqlite')));
  ok('the unreadable file was still backed up first',
    fs.existsSync(badErr.backup) && fs.readFileSync(badErr.backup, 'utf8') === '{', badErr && badErr.backup);
}

console.log('\n== the CLI does the same thing ==');
{
  const dir = keep(scratch());
  fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(snapshot), { mode: 0o600 });
  const script = path.join(__dirname, '..', 'scripts', 'migrate-json-to-sqlite.js');
  const ran = spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
  ok('the script exits 0', ran.status === 0, ran.stderr);
  let parsed = null;
  try { parsed = JSON.parse(ran.stdout); } catch (e) { parsed = null; }
  ok('and prints the backup path', parsed && parsed.ok === true && fs.existsSync(parsed.backup), parsed);
  const again = spawnSync(process.execPath, [script, '--dir', dir], { encoding: 'utf8' });
  ok('running it again exits 1', again.status === 1, again.stderr);
  ok('and says it is refusing to overwrite', /Refusing to overwrite/.test(again.stderr), again.stderr);
  const noDir = spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, POS_DATA_DIR: '' } });
  ok('without a directory it refuses to guess', noDir.status === 1 && /POS_DATA_DIR/.test(noDir.stderr), noDir.stderr);
}

console.log('\n== the server boots on sqlite and does not write json ==');
{
  const dir = keep(scratch());
  const port = 19521;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      POS_DATA_DIR: dir,
      POS_STORAGE: 'sqlite',
      PORT: String(port),
      POS_DEFAULT_STORE_SLUG: 'sqlite-boot',
      POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: 'everlyce-test-password',
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: 'everlyce-test-password',
      POS_SELF_HOST: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  (async () => {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) { up = true; break; }
      } catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    ok('a fresh install boots with POS_STORAGE=sqlite', up, log.split('\n').slice(-6).join(' | '));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    ok('it wrote data.sqlite', fs.existsSync(path.join(dir, 'data.sqlite')));
    ok('it did not fall back to data.json', !fs.existsSync(path.join(dir, 'data.json')));
    const doc = createAdapter({ engine: 'sqlite', dir }).load();
    ok('the document is a v3 snapshot', doc && doc.schemaVersion === 3 && !!doc.storeData, doc && doc.schemaVersion);

    for (const d of tmp) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}
