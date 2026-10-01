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

// ------------------------------------------------------------------ SQLite

// Deliberately not implemented yet, and it refuses loudly rather than silently
// falling back to the file engine. A half-built database backend that quietly
// wrote to the wrong place is how a shop loses a day's orders.
//
// The shape it has to satisfy is fixed by jsonFileAdapter above, so there is
// no argument to be had about what SQLite would need to do.
function sqliteAdapter() {
  throw Object.assign(
    new Error(
      'The SQLite storage engine is selected but not implemented. '
      + 'It is being built behind the same contract as the file engine; '
      + 'set POS_STORAGE=json until it is available.',
    ),
    { code: 'storage_engine_unavailable' },
  );
}

function createAdapter(options = {}) {
  const engine = String(options.engine || process.env.POS_STORAGE || 'json').toLowerCase();
  if (engine === 'json' || engine === 'file') return jsonFileAdapter(options);
  if (engine === 'sqlite' || engine === 'libsql') return sqliteAdapter(options);
  throw new Error(`Unknown storage engine: ${engine}`);
}

module.exports = { createAdapter, jsonFileAdapter, sqliteAdapter, DATA_DIR, KEEP };
