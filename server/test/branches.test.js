// Branches: one store running more than one location, plus single-store
// self-hosted mode. Runs against a temporary copy, never a live install.
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.TEST_PORT || 18060);
const BASE = `http://127.0.0.1:${PORT}`;
const { isolatedData } = require('./helpers/isolated-data');
const DATA_DIR = isolatedData();
const PASSWORD = process.env.TEST_PLATFORM_PASSWORD || 'everlyce-test-password';
const STORE = process.env.TEST_STORE || 'myrestaurant';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const children = new Set();
function launch(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'index.js')], {
    env: {
      ...process.env,
      POS_DATA_DIR: DATA_DIR,
      PORT: String(PORT),
      POS_DEFAULT_STORE_SLUG: STORE,
POS_BOOTSTRAP_USERNAME: 'admin',
      POS_BOOTSTRAP_PASSWORD: PASSWORD,
      POS_PLATFORM_ADMIN_USERNAME: 'admin',
      POS_PLATFORM_ADMIN_PASSWORD: PASSWORD,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  child.on('exit', () => children.delete(child));
  return { child, get log() { return log; } };
}
function killAll() { for (const c of children) { try { c.kill('SIGKILL'); } catch (e) {} } }
process.on('exit', killAll);
process.on('unhandledRejection', (e) => { console.error(e); killAll(); process.exit(1); });

async function call(method, p, { body, token, store = STORE, branch, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = `Bearer ${token}`;
  if (store) h['X-POS-Store'] = store;
  if (branch) h['X-POS-Branch'] = String(branch);
  const res = await fetch(`${BASE}${p}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  return { status: res.status, data };
}

async function waitUp() {
  for (let i = 0; i < 80; i += 1) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  const srv = launch();
  if (!await waitUp()) { console.log('server did not start\n', srv.log); killAll(); process.exit(1); }

  const login = await call('POST', '/api/auth/login', { body: { username: 'admin', password: PASSWORD } });
  ok('admin sign-in', login.status === 200 && !!login.data.token, login);
  const token = login.data.token;

  console.log('\n== every store starts with a default branch ==');
  const branches0 = await call('GET', '/api/branches', { token });
  ok('branch list readable', branches0.status === 200 && Array.isArray(branches0.data), branches0.status);
  // Orders already in the fixture, read before this test adds any.
  const mainCountBefore = branches0.data.reduce((sum, b) => sum + Number(b.orderCount || 0), 0);
  ok('exactly one branch to begin with', branches0.data.length === 1, branches0.data);
  const main = branches0.data[0];
  ok('it is called Main', main.name === 'Main', main.name);
  ok('it is flagged as the default', main.isDefault === true, main);
  ok('it reports its table count', typeof main.tableCount === 'number', main);
  ok('it reports its order count', typeof main.orderCount === 'number', main);

  console.log('\n== an admin can add a branch ==');
  const bad = await call('POST', '/api/branches', { token, body: { name: '' } });
  ok('a branch needs a name', bad.status === 400, bad);
  const dupe = await call('POST', '/api/branches', { token, body: { name: 'Copy', code: 'main' } });
  ok('a duplicate branch code is refused', dupe.status === 409, dupe);

  const created = await call('POST', '/api/branches', {
    token, body: { name: 'Riverside', code: 'riverside', address: '12 River Road', phone: '+66 2 000 0000' },
  });
  ok('branch created', created.status === 201, created);
  ok('it has a code', created.data.code === 'riverside', created.data);
  ok('it keeps the address', created.data.address === '12 River Road', created.data);
  const riverside = created.data.id;

  const branches1 = await call('GET', '/api/branches', { token });
  ok('two branches now exist', branches1.data.length === 2, branches1.data.map((b) => b.code));
  ok('the default is still first', branches1.data[0].isDefault === true, branches1.data.map((b) => ({ c: b.code, d: b.isDefault })));

  console.log('\n== a branch can be edited ==');
  const renamed = await call('PUT', `/api/branches/${riverside}`, { token, body: { name: 'Riverside Branch', phone: '+66 2 111 1111' } });
  ok('rename works', renamed.status === 200 && renamed.data.name === 'Riverside Branch', renamed.data);
  ok('the phone number was updated', renamed.data.phone === '+66 2 111 1111', renamed.data.phone);

  console.log('\n== only an admin can change branches ==');
  const cashier = await call('POST', '/api/users', {
    token, body: { username: 'br_cashier', name: 'Branch Cashier', role: 'cashier', password: 'cashierpass1234' },
  });
  ok('cashier created', cashier.status === 200 || cashier.status === 201, cashier);
  const cLogin = await call('POST', '/api/auth/login', { body: { username: 'br_cashier', password: 'cashierpass1234' } });
  ok('cashier signed in', cLogin.status === 200, cLogin);
  const cToken = cLogin.data.token;
  const cashierList = await call('GET', '/api/branches', { token: cToken });
  ok('a cashier can see the branches', cashierList.status === 200 && cashierList.data.length === 2, cashierList.status);
  const cashierCreate = await call('POST', '/api/branches', { token: cToken, body: { name: 'Sneaky' } });
  ok('a cashier cannot add a branch', cashierCreate.status === 403, cashierCreate);
  const cashierEdit = await call('PUT', `/api/branches/${riverside}`, { token: cToken, body: { name: 'Hacked' } });
  ok('a cashier cannot edit a branch', cashierEdit.status === 403, cashierEdit);
  const cashierDelete = await call('DELETE', `/api/branches/${riverside}`, { token: cToken });
  ok('a cashier cannot remove a branch', cashierDelete.status === 403, cashierDelete);

  console.log('\n== tables belong to a branch ==');
  const cat = await call('POST', '/api/categories', { token, body: { name: 'Test Cat', sortOrder: 1 } });
  ok('category created', cat.status === 200 || cat.status === 201, cat);
  const product = await call('POST', '/api/products', {
    token, body: { name: 'Test Coffee', price: 50, categoryId: cat.data.id, available: true },
  });
  ok('product created', product.status === 200 || product.status === 201, product);

  const mainTable = await call('POST', '/api/tables', { token, branch: main.id, body: { name: 'MainT1', seats: 2 } });
  ok('table created on the main branch', mainTable.status === 200 || mainTable.status === 201, mainTable);
  ok('the table records its branch', Number(mainTable.data.branchId) === Number(main.id), mainTable.data);
  const riverTable = await call('POST', '/api/tables', { token, branch: riverside, body: { name: 'RiverT1', seats: 4 } });
  ok('table created on the other branch', riverTable.status === 200 || riverTable.status === 201, riverTable);
  ok('it records the other branch', Number(riverTable.data.branchId) === Number(riverside), riverTable.data);

  // Counted rather than asserted as a total, because the sample install ships
  // with tables of its own on the default branch.
  const allNow = await call('GET', '/api/tables?branchId=all', { token });
  const mainT1 = allNow.data.find((t) => t.name === 'MainT1' && Number(t.branchId) === Number(main.id));
  const riverT1 = allNow.data.find((t) => t.name === 'RiverT1' && Number(t.branchId) === Number(riverside));
  ok('both new tables are listed on the right branch', !!mainT1 && !!riverT1, allNow.data.map((t) => ({ n: t.name, b: t.branchId })));

  const filtered = await call('GET', `/api/tables?branchId=${main.id}`, { token });
  ok('tables can be filtered by branch', filtered.data.every((t) => Number(t.branchId) === Number(main.id)), filtered.data.map((t) => ({ n: t.name, b: t.branchId })));
  ok('the main branch includes its own new table', filtered.data.some((t) => t.name === 'MainT1'), filtered.data.map((t) => t.name));
  ok('the main branch excludes the other branch table', !filtered.data.some((t) => t.name === 'RiverT1'), filtered.data.map((t) => t.name));

  const allTables = await call('GET', '/api/tables?branchId=all', { token });
  ok('branchId=all returns tables from both branches', allTables.data.length === allNow.data.length, { got: allTables.data.length, expected: allNow.data.length });
  ok('including the other branch', allTables.data.some((t) => Number(t.branchId) === Number(riverside)), [...new Set(allTables.data.map((t) => t.branchId))]);

  const byHeader = await call('GET', '/api/tables?branchId=all', { token, branch: riverside });
  ok('a request with X-POS-Branch is still answered', byHeader.status === 200, byHeader.status);
  const byQueryHeader = await call('GET', '/api/tables?branchId=' + riverside, { token, branch: main.id });
  ok('an explicit branchId in the query wins over the header', byQueryHeader.data.every((t) => Number(t.branchId) === Number(riverside)), byQueryHeader.data.map((t) => ({ n: t.name, b: t.branchId })));
  ok('the other branch is included there', byQueryHeader.data.some((t) => t.name === 'RiverT1'), byQueryHeader.data.map((t) => t.name));
  const badBranch = await call('GET', '/api/tables', { token, branch: 99999 });
  ok('an unknown branch is rejected', badBranch.status === 400, badBranch);

  console.log('\n== an order is stamped with its branch ==');
  const mainSession = await call('POST', '/api/sessions', { token, branch: main.id, body: { tableId: mainTable.data.id, guestCount: 2 } });
  ok('session opened on the main table', mainSession.status === 201, mainSession);
  ok('the session records its branch', Number(mainSession.data.branchId) === Number(main.id), mainSession.data);

  const order = await call('POST', '/api/orders', {
    token, branch: main.id, body: { tableId: mainTable.data.id, items: [{ productId: product.data.id, quantity: 1 }] },
  });
  ok('order created', order.status === 200 || order.status === 201, order);
  ok('the order records the main branch', Number(order.data.branchId) === Number(main.id), order.data);
  ok('the order belongs to the session', Number(order.data.sessionId) === Number(mainSession.data.id), order.data);

  // The fixture may already hold orders from before branches existed; they are
  // all on the default branch after the upgrade, so compare against a baseline.
  const ordersBefore = await call('GET', '/api/orders?branchId=all', { token });
  const baselineMain = ordersBefore.data.filter((o) => Number(o.branchId) === Number(main.id)).length;
  const baselineRiver = ordersBefore.data.filter((o) => Number(o.branchId) === Number(riverside)).length;

  const mainOrders = await call('GET', `/api/orders?branchId=${main.id}`, { token });
  ok('orders filter by branch', mainOrders.data.every((o) => Number(o.branchId) === Number(main.id)), mainOrders.data.map((o) => ({ n: o.orderNumber, b: o.branchId })));
  ok('every order on this branch is listed, and no others', mainOrders.data.length === baselineMain, { got: mainOrders.data.length, expected: baselineMain });
  const riverOrders = await call('GET', `/api/orders?branchId=${riverside}`, { token });
  ok('the other branch has only what it was given', riverOrders.data.length === baselineRiver, { got: riverOrders.data.length, expected: baselineRiver });

  // A table carries its own branch, so an order cannot be stamped wrongly by
  // sending the wrong X-POS-Branch header.
  const mismatched = await call('POST', '/api/orders', {
    token, branch: riverside, body: { tableId: mainTable.data.id, items: [{ productId: product.data.id, quantity: 1 }] },
  });
  ok('an order is created', mismatched.status === 200 || mismatched.status === 201, mismatched);
  ok('the table wins over the header, so it is the main branch', Number(mismatched.data.branchId) === Number(main.id), mismatched.data);

  console.log('\n== reports can be split by branch ==');
  const allReport = await call('GET', '/api/dashboard', { token });
  ok('dashboard without a branch covers the store', allReport.status === 200, allReport.status);
  const mainReport = await call('GET', `/api/dashboard?branchId=${main.id}`, { token });
  ok('dashboard for one branch works', mainReport.status === 200, mainReport.status);
  const riverReport = await call('GET', `/api/dashboard?branchId=${riverside}`, { token });
  ok('the other branch reports only its own takings', riverReport.status === 200, riverReport.status);
  ok('which is nothing yet, since no order was rung up there', Number(riverReport.data.totalRevenue || 0) === 0, riverReport.data.totalRevenue);
  // These orders are still unpaid drafts, so settled revenue is 0 on both
  // branches; what matters is that each dashboard only counts its own orders.
  const mainDash = await call('GET', `/api/dashboard?branchId=${main.id}`, { token });
  const allDash = await call('GET', '/api/dashboard', { token });
  ok('a branch dashboard does not exceed the whole-store one', Number(mainDash.data.totalRevenue || 0) <= Number(allDash.data.totalRevenue || 0), { branch: mainDash.data.totalRevenue, all: allDash.data.totalRevenue });
  ok('and both are usable', typeof allDash.data.totalRevenue !== 'undefined', Object.keys(allDash.data || {}).slice(0, 6));
  // The branch counter counts every order on the branch, drafts included, so it
  // is compared against a baseline read from the same source.
  const statsNow = await call('GET', '/api/branches', { token });
  const mainNow = statsNow.data.find((b) => b.id === main.id);
  const riverNow = statsNow.data.find((b) => b.id === riverside);
  ok('the branch list shows orders per branch', riverNow.orderCount === 0 && mainNow.orderCount >= mainCountBefore, {
    main: mainNow.orderCount, mainBefore: mainCountBefore, river: riverNow.orderCount,
  });
  ok('the main branch counted the orders made here', mainNow.orderCount >= ordersBefore.data.length, { branch: mainNow.orderCount, orders: ordersBefore.data.length });

  console.log('\n== a branch with data cannot be deleted ==');
  const deleteMain = await call('DELETE', `/api/branches/${main.id}`, { token });
  ok('the default branch cannot be deleted', deleteMain.status === 409, deleteMain);
  const deleteRiver = await call('DELETE', `/api/branches/${riverside}`, { token });
  ok('a branch holding tables cannot be deleted', deleteRiver.status === 409, deleteRiver);
  ok('the message says why', /table/i.test(deleteRiver.data.detail || ''), deleteRiver.data.detail);

  await call('DELETE', `/api/tables/${riverTable.data.id}`, { token });
  const deleteEmpty = await call('DELETE', `/api/branches/${riverside}`, { token });
  ok('an empty branch can be deleted', deleteEmpty.status === 200, deleteEmpty);
  const branches2 = await call('GET', '/api/branches', { token });
  ok('one branch is left', branches2.data.length === 1, branches2.data.map((b) => b.code));

  console.log('\n== branches survive a restart ==');
  const ordersAtRestart = await call('GET', '/api/orders?branchId=all', { token });
  killAll();
  await new Promise((r) => setTimeout(r, 600));
  const srv2 = launch();
  const up2 = await waitUp();
  ok('server restarts', up2, srv2.log);
  if (up2) {
    const after = await call('GET', '/api/branches', { token });
    ok('the branch list is intact after a restart', after.status === 200 && after.data.length === 1, after.data);
    const tablesAfter = await call('GET', '/api/tables?branchId=all', { token });
    ok('tables keep their branch after a restart', tablesAfter.data.every((t) => Number(t.branchId) === Number(main.id)), tablesAfter.data.map((t) => ({ n: t.name, b: t.branchId })));
    const ordersAfter = await call('GET', '/api/orders?branchId=all', { token });
    ok('orders keep their branch after a restart', ordersAfter.data.length === ordersAtRestart.data.length && ordersAfter.data.every((o) => Number(o.branchId) === Number(main.id)), { got: ordersAfter.data.length, expected: ordersAtRestart.data.length });
    const branchesAfter = await call('GET', '/api/branches', { token });
    ok('the branch order counts survive a restart', branchesAfter.data.find((b) => b.id === main.id).orderCount === mainNow.orderCount, { after: branchesAfter.data.find((b) => b.id === main.id).orderCount, expected: mainNow.orderCount });
  }
  killAll();

  console.log(`\n${pass} passed, ${fail} failed`);
  const allLog = srv.log + srv2.log;
  if (/Error:/.test(allLog)) {
    console.log('\n--- server log errors ---');
    console.log(allLog.split('\n').filter((l) => /Error/.test(l)).slice(0, 10).join('\n'));
  }
  process.exit(fail ? 1 : 0);
})();
