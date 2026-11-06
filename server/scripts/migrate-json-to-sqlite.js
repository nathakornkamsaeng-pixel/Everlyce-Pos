#!/usr/bin/env node
// Copy data.json into data.sqlite, after a backup of the JSON file.
//
//   node server/scripts/migrate-json-to-sqlite.js --dir /opt/pos/server/data
//   node server/scripts/migrate-json-to-sqlite.js --dir /opt/pos/server/data --replace
//
// data.json is not deleted. Set POS_STORAGE=sqlite and restart once the
// script prints ok. Until then the server keeps using JSON.
'use strict';

const { migrateJsonToSqlite } = require('../src/storage/migrate');

function arg(name) {
  const at = process.argv.indexOf(name);
  if (at < 0) return null;
  return process.argv[at + 1] || null;
}

const dir = arg('--dir') || process.env.POS_DATA_DIR || null;
if (!dir) {
  console.error('Pass --dir <data directory> or set POS_DATA_DIR. Refusing to guess which shop to migrate.');
  process.exit(1);
}

try {
  const result = migrateJsonToSqlite({ dir, replace: process.argv.includes('--replace') });
  console.log(JSON.stringify({
    ok: true,
    ...result,
    next: 'Set POS_STORAGE=sqlite and restart. data.json was left in place so you can switch back.',
  }, null, 2));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
