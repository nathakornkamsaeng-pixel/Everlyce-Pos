// Isolated data directory for the end-to-end suites.
//
// These suites boot the real server and then register stores, take orders and
// move money, so they must never be pointed at the live database. The server
// falls back to server/data whenever POS_DATA_DIR is absent, so an unset
// TEST_DATA_DIR used to silently write to production. This helper provisions a
// throwaway directory by default and refuses to run against the live one.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..', '..');
const PRODUCTION_DATA_DIR = path.resolve(path.join(SERVER_ROOT, 'data'));
const FIXTURE = path.join(SERVER_ROOT, 'example-data', 'data.json');

function isolatedData() {
  const requested = process.env.TEST_DATA_DIR;
  let dir;

  if (requested) {
    // Honour an explicitly prepared fixture, but only if it is not live data.
    dir = path.resolve(requested);
    if (dir === PRODUCTION_DATA_DIR || dir.startsWith(PRODUCTION_DATA_DIR + path.sep)) {
      throw new Error(
        'refusing to run against the production data directory: ' + dir +
        '\nSet TEST_DATA_DIR to a scratch directory, or unset it to auto-provision one.',
      );
    }
    return dir;
  }

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'everlyce-test-'));
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
  });
  if (!fs.existsSync(FIXTURE)) {
    throw new Error('missing migration fixture: ' + FIXTURE);
  }
  // Seed the legacy single-store document so the suites exercise the real
  // v1 to v3 migration instead of starting from an empty database.
  fs.copyFileSync(FIXTURE, path.join(dir, 'data.json'));
  return dir;
}

module.exports = { isolatedData, PRODUCTION_DATA_DIR, FIXTURE };
