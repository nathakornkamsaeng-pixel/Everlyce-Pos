const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const {
  coll, nextId, now, touch, transaction, withStore, defaultStore, storeList, findStoreBySlug,
  DEFAULT_STORE_SLUG, bucketFor,
} = require('./db');

async function ensureBootstrapAdmin() {
  const store = defaultStore();
  if (!store) {
    console.log('No stores exist yet; nothing to bootstrap.');
    return;
  }

  // The installation's original store is created active with the migrated
  // admin, so this normally finds both already in place.
  await withStore(store, async () => {
    if (coll('users').some((user) => user.role === 'admin' && user.active)) return;
    const username = String(process.env.POS_BOOTSTRAP_USERNAME || 'admin').trim();
    const generated = !process.env.POS_BOOTSTRAP_PASSWORD;
    const password = process.env.POS_BOOTSTRAP_PASSWORD || crypto.randomBytes(18).toString('base64url');
    const passwordHash = await bcrypt.hash(password, 10);
    transaction(() => {
      coll('users').push({
        id: nextId('users'),
        username,
        name: 'System Admin',
        role: 'admin',
        pinHash: null,
        cashierId: null,
        passwordHash,
        active: true,
        authVersion: 1,
        createdAt: now(),
      });
    });
    if (generated) {
      const file = path.join(require('./db').DATA_DIR, 'bootstrap-admin.txt');
      fs.writeFileSync(file, `username=${username}\npassword=${password}\n`, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch (e) {}
      console.log(`Bootstrap admin created: ${username} / credentials written to ${file}`);
    } else {
      console.log(`Bootstrap admin created: ${username}`);
    }
  });

  // Every installation needs at least one platform operator, otherwise stores
  // could never be activated.
  if (coll('platformAdmins').some((admin) => admin.active)) return;
  const username = String(process.env.POS_PLATFORM_ADMIN_USERNAME || process.env.POS_BOOTSTRAP_USERNAME || 'admin').trim();
  const generated = !process.env.POS_PLATFORM_ADMIN_PASSWORD;
  const password = process.env.POS_PLATFORM_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(password, 10);
  transaction(() => {
    coll('platformAdmins').push({
      id: nextId('platformAdmins'),
      username,
      name: 'Platform Admin',
      role: 'platform_admin',
      passwordHash,
      active: true,
      authVersion: 1,
      createdAt: now(),
    });
  });
  if (generated) {
    const file = path.join(require('./db').DATA_DIR, 'platform-admin.txt');
    fs.writeFileSync(file, `username=${username}\npassword=${password}\n`, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch (e) {}
    console.log(`Platform admin created: ${username} / credentials written to ${file}`);
  } else {
    console.log(`Platform admin created: ${username}`);
  }
}

module.exports = { ensureBootstrapAdmin };
