const fs = require('fs');
const { coll, storeList, bucketFor, withStore, STORE_COLLECTIONS, SCHEMA_VERSION } = require('./db');

// A real look at the health of the data, rather than a page of made-up
// numbers. Everything here is a count or an internal id: no names, phone
// numbers, emails, order contents or settings values are read out.

function collectionCounts() {
  const counts = {};
  for (const name of STORE_COLLECTIONS) {
    const list = coll(name);
    counts[name] = Array.isArray(list) ? list.length : 0;
  }
  return counts;
}

function countIf(list, predicate) {
  return list.filter(predicate).length;
}

// A per-store view, which is what a multi-store install actually needs, because
// one busy branch and four quiet ones can average out into a healthy-looking
// total while one store is quietly broken.
function perStore() {
  return storeList().map((store) => withStore(store, () => storeSummary(store)));}

function storeSummary(store) {
  {
    const bucket = bucketFor(store.id);
    const counts = {};
    for (const name of STORE_COLLECTIONS) {
      counts[name] = Array.isArray(bucket[name]) ? bucket[name].length : 0;
    }
    const newest = ordersNewest(bucket.orders);
    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      status: store.status,
      plan: store.plan,
      counts,
      total: STORE_COLLECTIONS.reduce((sum, name) => sum + counts[name], 0),
      newestOrderAt: newest,
      hasAdmin: (bucket.users || []).some((u) => u.role === 'admin' && u.active),
      integrity: checkIntegrity(),
    };
  }
}

function ordersNewest(orders) {
  if (!Array.isArray(orders) || !orders.length) return null;
  let newest = null;
  for (const order of orders) {
    const at = new Date(order.createdAt || 0).getTime();
    if (!Number.isFinite(at)) continue;
    if (newest === null || at > newest) newest = at;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

// Referential checks. These are the things that actually go wrong in a POS over
// time: a table removed while open sessions still point at it, a member erased
// with ledger rows left attached, two accounts sharing a username.
function checkIntegrity() {
  const findings = [];
  const add = (severity, code, message, detail = {}) => findings.push({ severity, code, message, ...detail });

  // Stores with no data bucket, and buckets with no store.
  for (const store of storeList()) {
    if (!bucketFor(store.id).settings) add('error', 'store_no_bucket', `Store /${store.slug} has no readable settings`);
    if (store.status === 'active') {
      const users = coll('users');
      if (!users.some((u) => u.role === 'admin' && u.active)) {
        add('error', 'no_active_admin', `Store /${store.slug} is live but has no active admin`, { slug: store.slug });
      }
    }
  }

  const tables = coll('tables');
  const sessions = coll('sessions');
  const orders = coll('orders');
  const items = coll('orderItems');
  const members = coll('loyaltyMembers');
  const branches = coll('branches');
  const branchIds = new Set(branches.map((b) => Number(b.id)));

  if (!branches.length) add('error', 'no_branches', 'This store has no branch, so nothing can be rung up');

  const tableIds = new Set(tables.map((t) => Number(t.id)));
  const sessionIds = new Set(sessions.map((s) => Number(s.id)));
  const orderIds = new Set(orders.map((o) => Number(o.id)));
  const memberIds = new Set(members.map((m) => Number(m.id)));

  // A table removed while a session still points at it breaks the till screen.
  const danglingSessions = sessions.filter((s) => s.tableId != null && !tableIds.has(Number(s.tableId)));
  if (danglingSessions.length) {
    add('warn', 'session_without_table', `${danglingSessions.length} session(s) point at a table that no longer exists`, {
      sample: danglingSessions.slice(0, 5).map((s) => s.id),
    });
  }

  const danglingOrders = orders.filter((o) => o.tableId != null && !tableIds.has(Number(o.tableId)));
  if (danglingOrders.length) {
    add('warn', 'order_without_table', `${danglingOrders.length} order(s) point at a missing table`, {
      sample: danglingOrders.slice(0, 5).map((o) => o.id),
    });
  }

  const danglingSessionRefs = orders.filter((o) => o.sessionId != null && !sessionIds.has(Number(o.sessionId)));
  if (danglingSessionRefs.length) {
    add('warn', 'order_without_session', `${danglingSessionRefs.length} order(s) point at a missing session`, {
      sample: danglingSessionRefs.slice(0, 5).map((o) => o.id),
    });
  }

  const orphanItems = items.filter((i) => !orderIds.has(Number(i.orderId)));
  if (orphanItems.length) {
    add('warn', 'item_without_order', `${orphanItems.length} line item(s) belong to an order that no longer exists`, {
      sample: orphanItems.slice(0, 5).map((i) => i.id),
    });
  }

  // An erased member is supposed to keep its ledger rows, detached. A row still
  // naming a member that does not exist means the erasure did not finish.
  const danglingLedger = coll('loyaltyLedger').filter((e) => e.memberId != null && !memberIds.has(Number(e.memberId)));
  if (danglingLedger.length) {
    add('warn', 'ledger_without_member', `${danglingLedger.length} loyalty entries point at a member that no longer exists`, {
      sample: danglingLedger.slice(0, 5).map((e) => e.id),
    });
  }

  const seen = new Map();
  const duplicateUsernames = [];
  for (const user of coll('users')) {
    const key = String(user.username || '').toLowerCase();
    if (!key) continue;
    if (seen.has(key)) duplicateUsernames.push(user.username);
    seen.set(key, true);
  }
  if (duplicateUsernames.length) {
    add('error', 'duplicate_username', `${duplicateUsernames.length} account(s) share a username, which makes sign-in ambiguous`, {
      sample: duplicateUsernames.slice(0, 5),
    });
  }

  // Records that never got a branch, which happens if data was written by an
  // older build and the upgrade did not finish.
  const unbranched = ['tables', 'orders', 'sessions', 'cashSessions']
    .reduce((sum, name) => sum + countIf(coll(name), (r) => r.branchId == null), 0);
  if (unbranched) {
    add('error', 'unbranched_records', `${unbranched} record(s) have no branch, so reports cannot attribute them`, {
      branches: branchIds.size,
    });
  }

  const badBranchRef = ['tables', 'orders', 'sessions', 'cashSessions']
    .reduce((sum, name) => sum + countIf(coll(name), (r) => r.branchId != null && !branchIds.has(Number(r.branchId))), 0);
  if (badBranchRef) {
    add('error', 'unknown_branch', `${badBranchRef} record(s) point at a branch that does not exist`);
  }

  // A till left open overnight is not a fault, but it is worth seeing.
  const openSessions = sessions.filter((s) => s.status === 'open');
  const openDrawers = countIf(coll('cashSessions'), (s) => s.status === 'open');
  if (openDrawers > 1) {
    add('warn', 'multiple_open_drawers', `${openDrawers} cash drawers are open at once, which double counts takings`);
  }

  const nowMs = Date.now();
  const staleOpen = openSessions.filter((s) => {
    const at = new Date(s.openedAt || 0).getTime();
    return Number.isFinite(at) && nowMs - at > 24 * 60 * 60 * 1000;
  });
  if (staleOpen.length) {
    add('warn', 'stale_sessions', `${staleOpen.length} table session(s) have been open for more than a day`, {
      sample: staleOpen.slice(0, 5).map((s) => s.id),
    });
  }

  const activeLocks = countIf(coll('securityLocks'), (e) => {
    const until = e.blockedUntil ? new Date(e.blockedUntil).getTime() : 0;
    return until > nowMs;
  });
  if (activeLocks) {
    add('info', 'active_login_locks', `${activeLocks} sign-in lock(s) are currently blocking an account`);
  }

  const weight = { error: 0, warn: 0, info: 0 };
  for (const f of findings) weight[f.severity] = (weight[f.severity] || 0) + 1;
  const status = weight.error ? 'fail' : weight.warn ? 'degraded' : 'pass';
  return { status, counts: weight, findings };
}

function fileReport(dataFile, backupFile, storageInfo) {
  // Both start as objects, never null: the page has to be able to say "no
  // backup on disk yet" rather than render a blank.
  const out = { dataFile: {}, backup: {} };
  const stat = (file, target) => {
    if (!target) return false;
    try {
      const s = fs.statSync(file);
      target.path = file;
      target.sizeBytes = s.size;
      target.sizeMb = Math.round((s.size / (1024 * 1024)) * 100) / 100;
      target.modifiedAt = new Date(s.mtimeMs).toISOString();
      target.ageHours = Math.round(((Date.now() - s.mtimeMs) / 3600000) * 10) / 10;
      target.missing = false;
      return true;
    } catch (e) {
      target.missing = true;
      return false;
    }
  };
  stat(dataFile, out.dataFile);

  // When the engine can describe its own backups, believe it rather than
  // probing for a single file that a rotating window no longer writes.
  if (storageInfo && storageInfo.backups) {
    const window = storageInfo.backups;
    out.backup = {
      dir: window.dir,
      count: window.count,
      keep: window.keep,
      missing: window.count === 0,
      newest: window.newest,
    };
    if (window.newest) {
      const newestAgeHours = Math.round(((Date.now() - new Date(window.newest.modifiedAt).getTime()) / 3600000) * 10) / 10;
      out.backup.ageHours = newestAgeHours;
      out.backup.staleHours = Math.round((out.dataFile.ageHours - newestAgeHours) * 10) / 10;
    }
    return out;
  }

  if (stat(backupFile, out.backup)) {
    out.backup.staleHours = Math.round((out.dataFile.ageHours - out.backup.ageHours) * 10) / 10;
  }
  return out;
}

function processReport() {
  const mem = process.memoryUsage();
  return {
    uptimeSeconds: Math.round(process.uptime()),
    uptimeReadable: readableUptime(process.uptime()),
    nodeVersion: process.version,
    rssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
    heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
    heapTotalMb: Math.round((mem.heapTotal / (1024 * 1024)) * 10) / 10,
    platform: process.platform,
    loadAverage: require('os').loadavg().map((n) => Math.round(n * 100) / 100),
  };
}

function readableUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

// The whole report for the platform. Every read happens inside a store context,
// so this works the same whether the install has one store or fifty.
function buildReport({ dataFile, backupFile, storage } = {}) {
  const stores = perStore();
  const counts = {};
  for (const name of STORE_COLLECTIONS) counts[name] = 0;
  const merged = { error: 0, warn: 0, info: 0 };
  const findings = [];
  for (const store of stores) {
    for (const name of STORE_COLLECTIONS) counts[name] += store.counts[name] || 0;
    merged.error += store.integrity.counts.error;
    merged.warn += store.integrity.counts.warn;
    merged.info += store.integrity.counts.info;
    for (const f of store.integrity.findings) {
      findings.push({ ...f, store: `/${store.slug}` });
    }
  }
  const status = merged.error ? 'fail' : merged.warn ? 'degraded' : 'pass';
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    scope: stores.length === 1 ? `store /${stores[0].slug}` : `platform (${stores.length} stores)`,
    totals: {
      stores: stores.length,
      rows: total,
      records: counts,
    },
    stores: stores.map((s) => ({ ...s, integrity: { status: s.integrity.status, counts: s.integrity.counts } })),
    integrity: { status, counts: merged, findings },
    files: fileReport(dataFile, backupFile, storage),
    process: processReport(),
  };
}

module.exports = { buildReport, checkIntegrity, collectionCounts, perStore, fileReport, processReport, readableUptime, ordersNewest };
