// One-shot copy of a JSON snapshot into the SQLite engine.
//
// The JSON file is backed up before it is parsed, and it is left in place
// afterwards. The operator flips POS_STORAGE=sqlite only after this script
// has exited 0. Until that flag is set the server keeps reading JSON, so a
// migration that is never switched on cannot diverge from the till.
'use strict';

const fs = require('fs');
const path = require('path');
const { sqliteAdapter, rotate, stampFor, DATA_DIR } = require('./index');

function fail(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

function migrateJsonToSqlite(options = {}) {
  const dir = options.dir || process.env.POS_DATA_DIR || DATA_DIR;
  const jsonFile = options.jsonFile || path.join(dir, 'data.json');
  const backupDir = options.backupDir || path.join(dir, 'backups');
  const when = options.clock ? options.clock() : new Date();

  if (!fs.existsSync(jsonFile)) {
    throw fail(`No JSON snapshot at ${jsonFile}. Nothing to migrate.`, 'migration_source_missing');
  }

  // Backup first, before parse and before the database file is created. A
  // snapshot that does not parse still has a copy, and SQLite is untouched.
  const backup = rotate(jsonFile, backupDir, stampFor(when));
  if (!backup) {
    throw fail('Could not back up the JSON snapshot. SQLite was not written.', 'migration_backup_failed');
  }

  let text;
  try {
    text = fs.readFileSync(jsonFile, 'utf8');
  } catch (e) {
    throw fail(`Could not read ${jsonFile}. SQLite was not written. Backup: ${backup}`, 'migration_source_invalid', { backup });
  }
  if (!String(text).trim()) {
    throw fail(`The JSON snapshot at ${jsonFile} is empty. SQLite was not written. Backup: ${backup}`, 'migration_source_invalid', { backup });
  }

  let snapshot;
  try {
    snapshot = JSON.parse(text);
  } catch (e) {
    throw fail(`The JSON snapshot could not be parsed. SQLite was not written. Backup: ${backup}`, 'migration_source_invalid', { backup });
  }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw fail(`The JSON snapshot is not a document. SQLite was not written. Backup: ${backup}`, 'migration_source_invalid', { backup });
  }

  const sqlite = sqliteAdapter({
    dir,
    file: options.sqliteFile || path.join(dir, 'data.sqlite'),
    backupDir,
    clock: options.clock,
  });
  const existing = sqlite.load();
  if (existing && options.replace !== true) {
    throw fail(
      'SQLite already holds a snapshot. Refusing to overwrite it. Re-run with --replace after you have another copy.',
      'migration_target_exists',
      { backup },
    );
  }
  sqlite.commit(snapshot, existing);
  return {
    backup,
    sqliteFile: sqlite.dataFile,
    source: jsonFile,
    engine: 'sqlite',
    replaced: Boolean(existing),
  };
}

module.exports = { migrateJsonToSqlite };
