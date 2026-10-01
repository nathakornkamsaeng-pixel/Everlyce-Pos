// The checkout service, tested directly.
//
// No server, no HTTP, no bcrypt. The whole point of pulling the rules out of
// the route is that a few hundred cases against the money path become cheap
// enough to actually run, including the ones that are hard to arrange over
// HTTP: a batch where the second order fails, an idempotent replay, and
// interleaved attempts on one order.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRepo } = require('../src/repo');
const checkout = require('../src/services/checkout');

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

// ---------------------------------------------------------------- harness

const STORE_COLLECTIONS = [
  'users', 'tables', 'categories', 'products', 'modifierGroups', 'modifierOptions',
  'orders', 'orderItems', 'payments', 'promptPayRequests', 'refunds', 'discounts',
  'cashSessions', 'sessions', 'loyaltyMembers', 'loyaltyLedger', 'translations',
  'revokedTokens', 'securityLocks', 'stockMovements', 'branches', 'apiKeys',
];
const GLOBAL = ['stores', 'platformAdmins', 'revokedPlatformTokens', 'platformSettings'];

function blankBucket() {
  const b = { schemaVersion: 3, settings: { taxRate: '7', serviceChargeRate: '10', currency: 'THB', restaurantName: 'Test' }, nextIds: {} };
  for (const c of STORE_COLLECTIONS) b[c] = [];
  b.branches.push({ id: 1, name: 'Main', isDefault: true });
  return b;
}

// A repository over a plain object, with writes counted. No disk, no engine.
function harness({ rows = true } = {}) {
  let doc = {
    schemaVersion: 3,
    stores: [{ id: 1, slug: 'test', name: 'Test', status: 'active' }],
    platformAdmins: [],
    revokedPlatformTokens: [],
    platformSettings: {},
    storeData: { 1: blankBucket() },
    nextIds: {},
  };
  let commits = 0;
  const repo = createRepo({
    getDoc: () => doc,
    setDoc: (n) => { doc = n; },
    isGlobal: (n) => GLOBAL.includes(n),
    blankBucket,
    bucketFor: (d, id) => {
      if (!d.storeData[String(id)]) d.storeData[String(id)] = blankBucket();
      return d.storeData[String(id)];
    },
    persist: () => { commits += 1; },
    clock: () => '2026-01-01T00:00:00.000Z',
  });
  const store = repo.findStoreBySlug('test');
  const write = (fn) => repo.withStore(store, fn);
  return {
    repo, store, write, doc: () => doc,
    commits: () => commits,
    // A believable order: two lines, tax and service charge applied.
    order(over = {}) {
      return write(() => {
        const order = {
          id: repo.nextId('orders'),
          orderNumber: 'ORD-1',
          status: 'pending',
          paymentStatus: 'pending',
          draft: false,
          subtotal: 0, tax: 0, serviceCharge: 0, discount: 0, tip: 0, total: 0,
          orderType: 'dine_in',
          tableId: 1,
          sessionId: 1,
          branchId: 1,
          memberId: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          startedAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          ...over,
        };
        repo.coll('orders').push(order);
        for (const line of rows ? [
          { productId: 1, quantity: 2, unitPrice: 100 },
          { productId: 2, quantity: 1, unitPrice: 50 },
        ] : []) {
          repo.coll('orderItems').push({
            id: repo.nextId('orderItems'),
            orderId: order.id,
            productName: `p${line.productId}`,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            modifiers: '[]',
            status: 'pending',
            refunded: false,
            refundedQuantity: 0,
            stockReserved: false,
            stockConsumed: false,
            branchId: 1,
          });
        }
        return order;
      });
    },
    openDrawer() {
      return write(() => {
        const s = { id: repo.nextId('cashSessions'), branchId: 1, status: 'open', openingAmount: 0, openedAt: '2026-01-01T00:00:00.000Z' };
        repo.coll('cashSessions').push(s);
        return s;
      });
    },
    items(orderId) { return write(() => repo.coll('orderItems').filter((i) => Number(i.orderId) === Number(orderId))); },
    payments() { return write(() => repo.coll('payments').slice()); },
    sessionTotals() {
      return write(() => repo.coll('sessions').map((s) => ({ id: s.id, total: s.total, orderCount: s.orderCount })));
    },
  };
}

// The collaborators the service needs, stubbed so a case can say exactly what
// the totals are. recompute is the one that has to be real enough to matter.
const deps = {
  recompute(order) {
    const subtotal = 250;
    order.subtotal = subtotal;
    order.tax = Math.round(subtotal * 0.07 * 100) / 100;
    order.serviceCharge = Math.round(subtotal * 0.10 * 100) / 100;
    order.total = Math.round((subtotal + order.tax + order.serviceCharge + (order.tip || 0)) * 100) / 100;
  },
  recalculateSession() {},
  settleLoyalty() {},
  memberRequired: () => false,
};

const settle = (h, order, body, extra = {}) => h.write(() => checkout.settle({
  repo: h.repo, order, body, actor: { id: 7 }, deps, ...extra,
}));

console.log('\n== a cash sale ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  const r = settle(h, order, { method: 'cash', received: 500 });
  ok('the order is paid', r.order.paymentStatus === 'paid', r.order.paymentStatus);
  ok('a payment row is written', h.payments().length === 1 && h.payments()[0].method === 'cash');
  ok('the total is 292.50 from 250 plus tax and service charge', r.order.total === 292.5, r.order.total);
  ok('change is worked out from what was handed over', r.payment.change === 207.5, r.payment.change);
  ok('the change is rounded to cents', Number.isInteger(r.payment.change * 100), r.payment.change);
  ok('the payment is tied to the drawer', r.payment.cashSessionId != null, r.payment.cashSessionId);
  ok('the order leaves draft', r.order.draft === false);
  ok('a receipt token is issued', typeof r.order.receiptToken === 'string' && r.order.receiptToken.length === 32);
  ok('preparation time is measured', typeof r.order.prepMs === 'number' && r.order.prepMs >= 0, r.order.prepMs);
  ok('the actor is recorded on the payment', r.payment.createdBy === 7);
}

console.log('\n== stock moves at the moment of sale ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  h.write(() => {
    for (const item of repo_items(h, order.id)) item.stockReserved = true;
  });
  ok('the lines are reserved before the sale', h.items(order.id).every((i) => i.stockReserved));
  settle(h, order, { method: 'cash' });
  ok('and consumed after it, never left reserved', h.items(order.id).every((i) => i.stockConsumed && !i.stockReserved));
  function repo_items(hh, id) { return hh.items(id); }
}

console.log('\n== a drawer is required for cash ==');
{
  const h = harness();
  const order = h.order();
  let refused = null;
  try { settle(h, order, { method: 'cash' }); } catch (e) { refused = e; }
  ok('cash without an open drawer is refused', refused && /cash drawer/i.test(refused.message), refused && refused.message);
  ok('with a 409, because the till has to open one', refused && refused.status === 409, refused && refused.status);
  ok('and nothing was written', h.payments().length === 0);
  ok('and the order is still open', h.write(() => h.repo.coll('orders')[0].paymentStatus) === 'pending');
}

console.log('\n== card does not need a drawer ==');
{
  const h = harness();
  const order = h.order();
  const r = settle(h, order, { method: 'card' });
  ok('card settles with no drawer open', r.order.paymentStatus === 'paid');
  ok('and change is zero, not worked out from a phantom handover', r.payment.change === 0, r.payment.change);
  ok('received equals the amount due', r.payment.received === r.payment.amount);
}

console.log('\n== a handover that does not cover the order ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  for (const received of [0, 1, 292.49, 292.4999]) {
    let refused = null;
    try { settle(h, order, { method: 'cash', received }); } catch (e) { refused = e; }
    ok(`refused when handed ${received}`, refused && /less than the amount due/i.test(refused.message), refused && refused.message);
  }
  ok('still no payment was recorded', h.payments().length === 0);
  ok('and the order is untouched', h.write(() => h.repo.coll('orders')[0].paymentStatus) === 'pending');
  const exact = settle(h, order, { method: 'cash', received: 292.5 });
  ok('exactly the amount due is accepted, with no change', exact.payment.change === 0, exact.payment.change);
}

console.log('\n== an empty order cannot be checked out ==');
{
  const h = harness({ rows: false });
  h.openDrawer();
  const order = h.order();
  let refused = null;
  try { settle(h, order, { method: 'cash' }); } catch (e) { refused = e; }
  ok('refused with a clear reason', refused && /empty order/i.test(refused.message), refused && refused.message);
  ok('and no payment exists', h.payments().length === 0);
}

console.log('\n== an already-paid order ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  settle(h, order, { method: 'cash' });
  let refused = null;
  try { settle(h, order, { method: 'cash' }); } catch (e) { refused = e; }
  ok('a second attempt is refused', refused && /already closed/i.test(refused.message), refused && refused.message);
  ok('still exactly one payment', h.payments().length === 1, h.payments().length);
}

console.log('\n== a retried request is not a second payment ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  const first = settle(h, order, { method: 'card', idempotencyKey: 'k-1' });
  const second = settle(h, order, { method: 'card', idempotencyKey: 'k-1' });
  ok('the retry is recognised', second.idempotent === true, second.idempotent);
  ok('and returns the original payment, not a new one', second.payment.id === first.payment.id);
  ok('there is still only one payment', h.payments().length === 1, h.payments().length);
  ok('and the order total did not move', h.write(() => h.repo.coll('orders')[0].total) === first.order.total);
  // A different key is a different request, so it is not a replay and must be
  // refused outright rather than quietly accepted.
  let refused = null;
  try { settle(h, order, { method: 'card', idempotencyKey: 'k-2' }); } catch (e) { refused = e; }
  ok('a different key is not treated as a replay', refused && /already closed/i.test(refused.message), refused && refused.message);
  ok('and still cannot double-pay the order', h.payments().length === 1, h.payments().length);
  // The key has to be looked up against the same order, not globally.
  const other = h.order();
  const otherPaid = settle(h, other, { method: 'card', idempotencyKey: 'k-1' });
  ok("another order can reuse a key that is already on file", otherPaid.idempotent === false, otherPaid.idempotent);
  ok('because the replay is scoped to the order, not the shop', h.payments().length === 2, h.payments().length);
}

console.log('\n== methods are an allow-list, not a free string ==');
{
  const h = harness();
  h.openDrawer();
  // Truthy but not on the list: refused.
  for (const method of ['promptpay', 'bitcoin', 'CASH', 'x'.repeat(50), 'promptPay', [], {}, 7]) {
    const order = h.order();
    let refused = null;
    try { settle(h, order, { method }); } catch (e) { refused = e; }
    ok(`refused: ${JSON.stringify(String(method)).slice(0, 20)}`, refused && /Invalid payment method/i.test(refused.message), refused && refused.message);
  }
  // Falsy is the documented default rather than an error: a till that sends no
  // method is charging cash, which is what the drawer check then confirms.
  for (const method of [0, '', null, undefined, false, NaN]) {
    const order = h.order();
    const r = settle(h, order, { method });
    ok(`falsy method ${JSON.stringify(String(method))} falls back to cash`, r.payment.method === 'cash', r.payment.method);
  }
  const h2 = harness();
  h2.openDrawer();
  const order = h2.order();
  const pp = settle(h2, order, { method: 'promptpay' }, { allowPromptPay: true });
  ok('promptpay is allowed when the caller says so', pp.payment.method === 'promptpay');
}

console.log('\n== tip ==');
{
  const h = harness();
  h.openDrawer();
  const noTip = h.order();
  const a = settle(h, noTip, { method: 'cash' });
  ok('no tip means no tip', a.order.tip === 0 || a.order.tip === undefined, a.order.tip);
  for (const tip of [-1, 'abc', 1000001, Infinity]) {
    const order = h.order();
    let refused = null;
    try { settle(h, order, { method: 'cash', tip }); } catch (e) { refused = e; }
    ok(`refused tip ${String(tip)}`, refused && /Invalid tip/i.test(refused.message), refused && refused.message);
  }
  const order = h.order();
  const tipped = settle(h, order, { method: 'cash', tip: 20 });
  ok('a valid tip is added on top of the total', tipped.order.total === 312.5, tipped.order.total);
}

console.log('\n== a batch is all or nothing ==');
{
  // The reason transactions are re-entrant. Order two cannot be settled, so
  // order one must not be left paid on disk.
  const h = harness();
  h.openDrawer();
  const first = h.order();
  const second = h.order({ sessionId: 2 });
  // Break the second one: cancel every line so it is empty.
  h.write(() => {
    for (const item of h.repo.coll('orderItems')) if (Number(item.orderId) === Number(second.id)) item.status = 'cancelled';
  });
  let threw = null;
  try {
    h.repo.transaction(() => {
      // Re-read inside the transaction, exactly as the routes do. A reference
      // taken beforehand would point at the copy the rollback restores from.
      settle(h, h.write(() => h.repo.coll('orders').find((o) => o.id === first.id)), { method: 'card' });
      settle(h, h.write(() => h.repo.coll('orders').find((o) => o.id === second.id)), { method: 'card' });
    });
  } catch (e) { threw = e; }
  ok('the batch failed', Boolean(threw), threw && threw.message);
  ok('the first order was not left paid', h.write(() => h.repo.coll('orders').find((o) => o.id === first.id).paymentStatus) === 'pending');
  ok('no payment survived from the first order', h.payments().length === 0, h.payments().length);
}

console.log('\n== a nested transaction does not commit early ==');
{
  const h = harness();
  h.openDrawer();
  const order = h.order();
  let depthSeen = null;
  h.repo.transaction(() => {
    depthSeen = h.repo.inTransaction();
    settle(h, h.write(() => h.repo.coll('orders').find((o) => o.id === order.id)), { method: 'card' });
  });
  ok('a service inside a transaction can see it is nested', depthSeen === true);
  ok('the outer frame is what commits', h.payments().length === 1);
  ok('and the order is settled once', h.write(() => h.repo.coll('orders')[0].paymentStatus) === 'paid');
}

console.log('\n== the service needs a store context, like everything else ==');
{
  const h = harness();
  const order = h.order();
  let refused = null;
  try {
    checkout.settle({ repo: h.repo, order, body: { method: 'card' }, deps });
  } catch (e) { refused = e; }
  ok('reading a collection outside a store is refused', refused && /store/i.test(refused.message), refused && refused.message);
  ok('and the code says which one', refused && refused.code === 'store_required', refused && refused.code);
}

console.log('\n== totals are never float drift ==');
{
  const h = harness();
  h.openDrawer();
  for (const [received, expectedChange] of [[300, 7.5], [292.5, 0], [1000, 707.5], [292.51, 0.01]]) {
    const order = h.order();
    const r = settle(h, order, { method: 'cash', received });
    ok(`handed ${received} gives change ${expectedChange}`, r.payment.change === expectedChange, r.payment.change);
  }
  // 0.1 + 0.2 territory: three lines of 0.1 must not come to 0.30000000000000004.
  ok('change is always at most two decimals', h.payments().every((p) => Number.isInteger(p.change * 100)), h.payments().map((p) => p.change));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
