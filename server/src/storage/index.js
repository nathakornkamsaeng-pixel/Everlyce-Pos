// How bytes reach durable storage.
//
// db.js owns what the data means: the shape, the migration, stock and loyalty
// arithmetic, the store buckets. This module owns only how a snapshot gets
// read and written, so the engine underneath can be swapped without touching a
// single route.
//
// The contract is deliberately small, because a small contract is one that can
// be implemented twice and compared:
//
//   name        a stable id for the engine, for logs and for the health report
//   load()      -> raw snapshot, or null when there is nothing on disk yet
//   commit(snapshot, previous) -> durably replace the stored snapshot
//   describe()  -> paths and sizes, for the health report
//
// commit() must be atomic: either the new snapshot is entirely durable, or the
// old one is entirely intact. A partial write that leaves a half-written
// document is the one failure this whole design exists to prevent, because a
// till cannot recover from losing yesterday's orders.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.POS_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEEP = Number(process.env.POS_BACKUP_KEEP || 10);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch (e) { /* best effort */ }
}

// A rolling window, not one .bak that a second write silently overwrites. The
// old scheme could only ever recover the immediately previous state, so two
// bad writes in a row meant losing a day of trading.
//
// The file being replaced is itself the previous state, so that is what gets
// copied. Handing it a snapshot object instead meant the existence check was
// testing an object, the copy never happened, and the window stayed empty.
function rotate(currentFile, backupDir, stamp) {
  if (!fs.existsSync(currentFile)) return null;
  ensureDir(backupDir);
  // A busy till writes several times a second, so a second-resolution name
  // would collapse a whole burst of states into one backup. Milliseconds, plus
  // a counter for the case of two writes inside the same millisecond.
  let target = path.join(backupDir, `data-${stamp}.json`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(backupDir, `data-${stamp}-${n}.json`);
    n += 1;
  }
  try {
    fs.copyFileSync(currentFile, target);
    fs.chmodSync(target, 0o600);
  } catch (e) {
    return null;
  }
  const kept = fs.readdirSync(backupDir)
    .filter((n) => /^data-\d{8}-\d{6}-\d{3}(-\d+)?\.json$/.test(n))
    .sort();
  while (kept.length > KEEP) {
    const oldest = kept.shift();
    try { fs.unlinkSync(path.join(backupDir, oldest)); } catch (e) { /* best effort */ }
  }
  return target;
}

function stampFor(d) {
  // pad has to honour the width it is given. It did not, so milliseconds came
  // out as two digits whenever they were under 100, which produced filenames
  // the trim pattern did not match. Those backups were never counted and never
  // deleted, so the window grew without bound a tenth of the time.
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
    + `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
    + `-${pad(d.getUTCMilliseconds(), 3)}`;
}

// ---------------------------------------------------------------- JSON file

// The engine in production today. Written to a temporary file in the same
// directory, fsynced, then renamed over the target: a rename within a
// filesystem is atomic, so a reader sees either the whole old file or the
// whole new one.
function jsonFileAdapter(options = {}) {
  const now = options.clock || (() => new Date());
  const dir = options.dir || DATA_DIR;
  const file = options.file || path.join(dir, 'data.json');
  const backupDir = options.backupDir || path.join(dir, 'backups');

  return {
    name: 'json',
    dataDir: dir,
    dataFile: file,
    // Kept for callers that still ask for the old single-file backup. It now
    // points at the most recent rotated copy rather than a file that only ever
    // held the previous write.
    backupFile: path.join(backupDir, 'latest.json'),
    backupDir,

    load() {
      ensureDir(dir);
      if (!fs.existsSync(file)) return null;
      const text = fs.readFileSync(file, 'utf8');
      if (!text.trim()) return null;
      return JSON.parse(text);
    },

    // The previous snapshot argument is not needed to rotate: the file about
    // to be replaced already holds the state we want to keep.
    commit(snapshot, previous) {
      ensureDir(dir);
      rotate(file, backupDir, stampFor(now()));
      const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      let fd = null;
      try {
        fd = fs.openSync(tmp, 'w', 0o600);
        fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2), 'utf8');
        // Without the fsync the bytes can still be in the page cache when the
        // rename lands, and a power cut then leaves the renamed file empty.
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        // A rename within a filesystem is atomic, so a reader sees either the
        // whole old file or the whole new one.
        fs.renameSync(tmp, file);
      } catch (e) {
        // Any failure, not just a failed rename. Serialising the snapshot can
        // throw before a single byte is written, and leaving the temporary file
        // behind then litters the data directory with full- or partial-size
        // copies of the shop's trading data.
        if (fd !== null) { try { fs.closeSync(fd); } catch (e2) { /* already closed */ } }
        try { fs.unlinkSync(tmp); } catch (e2) { /* nothing written */ }
        throw e;
      }
      // The directory entry itself has to be durable too, or the rename can be
      // lost even though the file contents were flushed.
      try {
        const dirFd = fs.openSync(dir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch (e) { /* not supported everywhere */ }
    },

    describe() {
      let sizeBytes = 0;
      let modifiedAt = null;
      try {
        const s = fs.statSync(file);
        sizeBytes = s.size;
        modifiedAt = new Date(s.mtimeMs).toISOString();
      } catch (e) { /* nothing written yet */ }
      // The window, not just a count: "3 backups, newest 4 minutes ago" tells
      // an owner whether they can recover, where "backup: missing" against a
      // single .bak file did not.
      const names = [];
      try {
        for (const n of fs.readdirSync(backupDir)) if (/^data-\d{8}-\d{6}-\d{3}/.test(n)) names.push(n);
      } catch (e) { /* no backup directory yet */ }
      names.sort();
      let newest = null;
      const newestName = names[names.length - 1];
      if (newestName) {
        try {
          const st = fs.statSync(path.join(backupDir, newestName));
          newest = { name: newestName, sizeBytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() };
        } catch (e) { /* vanished under us */ }
      }
      return {
        engine: 'json',
        dataFile: file,
        backupDir,
        sizeBytes,
        modifiedAt,
        backups: { dir: backupDir, count: names.length, keep: KEEP, newest },
      };
    },
  };
}

// Write one generation of the rolling backup window from a snapshot string.
// The JSON engine copies the file it is about to replace. SQLite has no such
// file: the previous generation is the row it is about to overwrite, so the
// same names and the same trim are applied to that text instead.
function remember(backupDir, text, stamp) {
  ensureDir(backupDir);
  let target = path.join(backupDir, `data-${stamp}.json`);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(backupDir, `data-${stamp}-${n}.json`);
    n += 1;
  }
  fs.writeFileSync(target, text, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch (e) { /* best effort */ }
  const kept = fs.readdirSync(backupDir)
    .filter((name) => /^data-\d{8}-\d{6}-\d{3}(-\d+)?\.json$/.test(name))
    .sort();
  while (kept.length > KEEP) {
    const oldest = kept.shift();
    try { fs.unlinkSync(path.join(backupDir, oldest)); } catch (e) { /* best effort */ }
  }
  return target;
}

function backupWindow(backupDir) {
  const names = [];
  try {
    for (const n of fs.readdirSync(backupDir)) if (/^data-\d{8}-\d{6}-\d{3}/.test(n)) names.push(n);
  } catch (e) { /* no backup directory yet */ }
  names.sort();
  let newest = null;
  const newestName = names[names.length - 1];
  if (newestName) {
    try {
      const st = fs.statSync(path.join(backupDir, newestName));
      newest = { name: newestName, sizeBytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() };
    } catch (e) { /* vanished under us */ }
  }
  return { dir: backupDir, count: names.length, keep: KEEP, newest };
}

// ------------------------------------------------------------------ SQLite

// One snapshot row in a local database file. The contract matches the JSON
// engine: load() returns the document or null, commit() replaces it entirely
// or leaves the previous row untouched.
//
// Durability: journal_mode=DELETE and synchronous=FULL. COMMIT does not return
// until the new page is on disk. The snapshot is a single row, so a reader
// sees the whole old document or the whole new one. A value JSON cannot
// represent is rejected before the transaction starts. The previous row is
// copied into the same rolling backup window the file engine uses, and then
// the row is replaced inside the transaction.
//
// This uses Node's built-in node:sqlite (DatabaseSync). It is still marked
// experimental by Node and prints a warning the first time it loads. It is
// used anyway so the engine does not add a native dependency. Node 20 has no
// such module; POS_STORAGE=sqlite fails closed there instead of writing JSON.
//
// `libsql` is accepted as a name for this same local file. It is not a remote
// libSQL / Turso connection.

const SQLITE_HANDLES = new Map();

function loadNodeSqlite() {
  try {
    return require('node:sqlite');
  } catch (e) {
    throw Object.assign(
      new Error(
        'POS_STORAGE=sqlite needs Node.js node:sqlite (DatabaseSync), which ships in Node 22.13 and later. '
        + `This process is ${process.version}. Upgrade Node, or set POS_STORAGE=json. `
        + 'The JSON file was not used as a fallback.',
      ),
      { code: 'storage_engine_unavailable' },
    );
  }
}

function openSqlite(file) {
  const cached = SQLITE_HANDLES.get(file);
  if (cached) return cached;
  const { DatabaseSync } = loadNodeSqlite();
  ensureDir(path.dirname(file));
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      body TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* best effort */ }
  SQLITE_HANDLES.set(file, db);
  return db;
}

function sqliteAdapter(options = {}) {
  // Fail at startup if this Node cannot open the engine. A till that boots
  // and then discovers the setting on the first order has already taken orders
  // it cannot save.
  loadNodeSqlite();
  const now = options.clock || (() => new Date());
  const dir = options.dir || DATA_DIR;
  const file = options.file || path.join(dir, 'data.sqlite');
  const backupDir = options.backupDir || path.join(dir, 'backups');

  function db() {
    return openSqlite(file);
  }

  return {
    name: 'sqlite',
    dataDir: dir,
    dataFile: file,
    backupFile: path.join(backupDir, 'latest.json'),
    backupDir,

    load() {
      const row = db().prepare('SELECT body FROM snapshot WHERE id = 1').get();
      if (!row || row.body == null || !String(row.body).trim()) return null;
      return JSON.parse(row.body);
    },

    commit(snapshot, previous) {
      // Serialise first. A circular reference throws here, with the row that
      // is already stored left exactly as it was.
      const text = JSON.stringify(snapshot);
      const database = db();
      const row = database.prepare('SELECT body FROM snapshot WHERE id = 1').get();
      if (row && row.body) {
        try { remember(backupDir, row.body, stampFor(now())); } catch (e) { /* the replace below is the durable step */ }
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(
          'INSERT OR REPLACE INTO snapshot (id, body, updated_at) VALUES (1, ?, ?)',
        ).run(text, now().toISOString());
        database.exec('COMMIT');
      } catch (e) {
        try { database.exec('ROLLBACK'); } catch (e2) { /* already rolled back */ }
        throw e;
      }
      try { fs.chmodSync(file, 0o600); } catch (e) { /* best effort */ }
      // `previous` is part of the contract. The row just replaced is the
      // previous generation; the argument is not consulted, matching the file
      // engine, which rotates the file on disk rather than the object handed in.
      void previous;
    },

    describe() {
      let sizeBytes = 0;
      let modifiedAt = null;
      try {
        const s = fs.statSync(file);
        sizeBytes = s.size;
        modifiedAt = new Date(s.mtimeMs).toISOString();
      } catch (e) { /* nothing written yet */ }
      return {
        engine: 'sqlite',
        dataFile: file,
        backupDir,
        sizeBytes,
        modifiedAt,
        backups: backupWindow(backupDir),
        // Stated so a health report does not have to guess what "committed" means.
        durability: 'single-row snapshot, journal_mode=DELETE, synchronous=FULL',
      };
    },
  };
}

// --------------------------------------------------------------- PostgreSQL

// schema.sql and postgres.test.js describe the target. They are not the live
// path. Selecting postgres must not write the JSON file, and it must not open
// a connection that half-applies the schema.
function postgresAdapter() {
  const configured = Boolean(process.env.DATABASE_URL || process.env.POS_DATABASE_URL);
  throw Object.assign(
    new Error(
      'POS_STORAGE=postgres is not available. '
      + 'server/src/storage/schema.sql and server/test/postgres.test.js exist, and they are not what the server writes. '
      + (configured
        ? 'A connection string is set and it is ignored. '
        : 'No connection string is read. ')
      + 'Still to build before this engine can be selected: an adapter on the same load/commit/describe contract (or a real relational one), '
      + 'FORCE ROW LEVEL SECURITY on the tenant tables, and a connection string the server actually opens. '
      + 'Set POS_STORAGE=json (the default) or POS_STORAGE=sqlite.',
    ),
    { code: 'storage_engine_unavailable' },
  );
}

function createAdapter(options = {}) {
  const engine = String(options.engine || process.env.POS_STORAGE || 'json').toLowerCase();
  if (engine === 'json' || engine === 'file') return jsonFileAdapter(options);
  if (engine === 'sqlite' || engine === 'libsql') return sqliteAdapter(options);
  if (engine === 'postgres' || engine === 'postgresql') return postgresAdapter(options);
  throw new Error(`Unknown storage engine: ${engine}`);
}

module.exports = {
  createAdapter, jsonFileAdapter, sqliteAdapter, postgresAdapter,
  DATA_DIR, KEEP, rotate, stampFor, remember,
};
