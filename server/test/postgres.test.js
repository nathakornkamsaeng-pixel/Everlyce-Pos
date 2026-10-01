// PostgreSQL schema conformance.
//
// Not a smoke test. Each case is a property the file engine could not enforce,
// because it had a single writer and no database to say no:
//
//   - two cashiers opening a drawer at the same instant
//   - the same idempotency key presented twice, concurrently
//   - a payment for an order that does not exist
//   - a line item pointing at a deleted order
//   - a query that forgets to filter by store
//   - money that is not exactly representable
//
// Row level security only applies to a non-superuser role, so the RLS cases run
// as a deliberately unprivileged role, which is also how the application would
// actually connect.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { Client } = require('pg');

const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage', 'schema.sql'), 'utf8');
const URL = process.env.TEST_DATABASE_URL
  || 'postgres://postgres@127.0.0.1:5432/everlyce_test';

let pass = 0;
let fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); }
  else { fail += 1; console.log(`  FAIL ${label}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
}

const uniq = () => Math.random().toString(36).slice(2, 10);

// client.connect() resolves to undefined, so the client has to be kept
// separately. Getting this wrong silently leaks connections.
async function client(url = URL) {
  const c = new Client({ connectionString: url });
  await c.connect();
  return c;
}

async function main() {
  const admin = new Client({ connectionString: URL });
  await admin.connect();

  // Start from a known-empty schema so the count assertions mean something.
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.query(SCHEMA);

  const tables = await admin.query(
    "select count(*)::int n from information_schema.tables where table_schema='public'",
  );
  ok('the schema creates every table', tables.rows[0].n >= 16, tables.rows[0].n);
  const idx = await admin.query("select count(*)::int n from pg_indexes where schemaname='public'");
  ok('and the indexes that make it fast', idx.rows[0].n >= 40, idx.rows[0].n);
  const pol = await admin.query("select count(*)::int n from pg_policies where schemaname='public'");
  ok('and a tenant policy per table', pol.rows[0].n >= 13, pol.rows[0].n);

  // Two stores, so isolation has something to isolate.
  await admin.query(`
    INSERT INTO stores (id, slug, name, status) VALUES
      (1,'one','One','active'), (2,'two','Two','active')
  `);
  await admin.query(`INSERT INTO branches (id, store_id, name, is_default) VALUES (1,1,'Main',true),(2,2,'Main',true)`);
  await admin.query(`INSERT INTO tables (id, store_id, branch_id, name) VALUES (1,1,1,'T1')`);
  await admin.query(`INSERT INTO categories (id, store_id, name) VALUES (1,1,'{"en":"Coffee"}'::jsonb)`);
  await admin.query(`INSERT INTO products (id, store_id, category_id, name, price) VALUES (1,1,1,'{"en":"Latte"}'::jsonb, 90)`);
  await admin.query(`INSERT INTO orders (id, store_id, branch_id, order_number, subtotal, total) VALUES (1,1,1,'ORD-1',100,107)`);
  await admin.query(`CREATE SEQUENCE IF NOT EXISTS seq_cs`);

  console.log('\n== one open drawer per branch, even under a race ==');
  {
    // The file engine checked this in application code, which only held because
    // Node is single threaded. Ten concurrent inserts: exactly one must win.
    const attempts = Array.from({ length: 10 }, async () => {
      const c = await client();
      try {
        await c.query(`INSERT INTO cash_sessions (id, store_id, branch_id, status, opening_amount)
                       VALUES (nextval('seq_cs'), 1, 1, 'open', 0)`);
        return 'ok';
      } catch (e) { return e.code; } finally { await c.end(); }
    });
    const results = await Promise.all(attempts);
    ok('exactly one concurrent open succeeds', results.filter((r) => r === 'ok').length === 1, results);
    ok('the rest are refused by the database, not the application',
      results.filter((r) => r === '23505').length === 9, results);
    const open = await admin.query(`SELECT count(*)::int n FROM cash_sessions WHERE status='open' AND branch_id=1`);
    ok('and only one open drawer exists afterwards', open.rows[0].n === 1, open.rows[0].n);
  }

  console.log('\n== the idempotency key is enforced, not hoped for ==');
  {
    const results = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
      const c = await client();
      try {
        await c.query(`INSERT INTO payments (id, store_id, order_id, method, amount, received, change, idempotency_key)
                       VALUES (${100 + i}, 1, 1, 'cash', 107, 107, 0, 'retry-key')`);
        return 'ok';
      } catch (e) { return e.code; } finally { await c.end(); }
    }));
    ok('six concurrent retries of one payment leave one row', results.filter((r) => r === 'ok').length === 1, results);
    ok('the rest collide on the unique index', results.filter((r) => r === '23505').length === 5, results);
    const n = await admin.query(`SELECT count(*)::int n FROM payments WHERE idempotency_key='retry-key'`);
    ok('and the table agrees', n.rows[0].n === 1, n.rows[0].n);
  }

  console.log('\n== a payment cannot exist without its order ==');
  {
    let code = null;
    try { await admin.query(`INSERT INTO payments (id, store_id, order_id, method, amount) VALUES (900,1,4242,'cash',10)`); }
    catch (e) { code = e.code; }
    ok('a dangling payment is refused', code === '23503', code);
  }

  console.log('\n== a line cannot outlive its order ==');
  {
    let code = null;
    try {
      await admin.query(`INSERT INTO order_items (id, store_id, order_id, product_name, quantity, unit_price)
                         VALUES (900,1,4242,'Ghost',1,10)`);
    } catch (e) { code = e.code; }
    ok('a dangling line item is refused', code === '23503', code);
    // And deleting an order takes its lines with it.
    await admin.query(`INSERT INTO order_items (id, store_id, order_id, product_name, quantity, unit_price)
                       VALUES (901,1,1,'Latte',2,90)`);
    const before = await admin.query('SELECT count(*)::int n FROM order_items');
    await admin.query('DELETE FROM orders WHERE id = 1');
    const after = await admin.query('SELECT count(*)::int n FROM order_items');
    ok('deleting an order cascades to its lines', before.rows[0].n === 1 && after.rows[0].n === 0,
      { before: before.rows[0].n, after: after.rows[0].n });
    await admin.query(`INSERT INTO orders (id, store_id, branch_id, order_number, subtotal, total)
                       VALUES (1,1,1,'ORD-1',100,107)`);
  }

  console.log('\n== money is exact ==');
  {
    // The reason this is numeric and not float. In JavaScript 0.1+0.2 is
    // 0.30000000000000004, which on a till is a real dispute.
    await admin.query(`UPDATE products SET price = 0.1 WHERE id = 1`);
    const v = await admin.query('SELECT price FROM products WHERE id = 1');
    ok('a tenth of a baht is stored as exactly a tenth', v.rows[0].price === '0.10', v.rows[0].price);
    let code = null;
    try { await admin.query('UPDATE products SET price = -5 WHERE id = 1'); } catch (e) { code = e.code; }
    ok('a negative price is refused', code === '23514', code);
    await admin.query(`UPDATE products SET price = 90 WHERE id = 1`);
    // numeric(12,2) means ten digits before the point, so an order is capped at
    // 9,999,999,999.99 baht. That is a ceiling worth stating rather than
    // discovering: past it the database refuses the write instead of rounding.
    const max = await admin.query(`SELECT 9999999999.99::numeric(12,2) AS v`);
    ok('the column holds a value at its stated ceiling', max.rows[0].v === '9999999999.99', max.rows[0].v);
    let overflow = null;
    try { await admin.query('SELECT 10000000000::numeric(12,2)'); } catch (e) { overflow = e.code; }
    ok('and refuses one past it, rather than truncating', overflow === '22003', overflow);
    let stored = null;
    try {
      await admin.query(`INSERT INTO orders (id, store_id, order_number, total)
                         VALUES (950, 1, 'ORD-BIG', 10000000000)`);
    } catch (e) { stored = e.code; }
    ok('so a total that large cannot be recorded at all', stored === '22003', stored);
  }

  console.log('\n== row level security catches a missing store filter ==');
  {
    // A role with no BYPASSRLS, which is how the application connects.
    const role = `everlyce_app_${uniq()}`;
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'test' NOBYPASSRLS`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);

    const asApp = () => client(URL.replace(/\/\/[^@]*@/, `//${role}:test@`));

    const c1 = await asApp();
    await c1.query(`SET app.store_id = '1'`);
    const mine = await c1.query('SELECT count(*)::int n FROM stores');
    // stores has no store_id column, so query a tenant table instead.
    const myProducts = await c1.query('SELECT count(*)::int n FROM products');
    await c1.query(`INSERT INTO products (id, store_id, name, price) VALUES (500, 1, '{"en":"Mine"}'::jsonb, 5)`);
    const afterMine = await c1.query('SELECT count(*)::int n FROM products');
    ok('a store sees its own rows', afterMine.rows[0].n === myProducts.rows[0].n + 1, afterMine.rows[0].n);
    ok('stores itself is not tenant filtered, it is the tenant list', mine.rows[0].n === 2, mine.rows[0].n);

    const c2 = await asApp();
    await c2.query(`SET app.store_id = '2'`);
    const theirs = await c2.query('SELECT count(*)::int n FROM products');
    ok('another store sees none of them', theirs.rows[0].n === 0, theirs.rows[0].n);
    let crossWrite = null;
    try {
      await c2.query(`INSERT INTO products (id, store_id, name, price) VALUES (501, 1, '{"en":"Sneaky"}'::jsonb, 5)`);
    } catch (e) { crossWrite = e.code; }
    ok('and cannot write into another store, even with the right id', crossWrite === '42501', crossWrite);

    const c3 = await asApp();
    const unset = await c3.query('SELECT count(*)::int n FROM products');
    ok('with no store set at all, a tenant table returns nothing', unset.rows[0].n === 0, unset.rows[0].n);

    await c1.end(); await c2.end(); await c3.end();
    // Grants and policies are objects owned by the role, so they have to go
    // first or the drop is refused for having dependencies.
    await admin.query(`DROP OWNED BY ${role} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  }

  console.log('\n== printer and scanner models are data ==');
  {
    await admin.query(`INSERT INTO printer_profiles (vendor, model, protocol, paper_width_mm, columns)
                       VALUES ('Epson','TM-T88VII','escpos-network',80,48)`);
    let dupe = null;
    try {
      await admin.query(`INSERT INTO printer_profiles (vendor, model, protocol) VALUES ('Epson','TM-T88VII','escpos-network')`);
    } catch (e) { dupe = e.code; }
    ok('the same model cannot be declared twice', dupe === '23505', dupe);
    let noProtocol = null;
    try {
      await admin.query(`INSERT INTO printer_profiles (vendor, model, paper_width_mm) VALUES ('X','Y',42)`);
    } catch (e) { noProtocol = e.code; }
    ok('a profile with no protocol is refused outright', noProtocol === '23502', noProtocol);
    let badWidth = null;
    try {
      await admin.query(`INSERT INTO printer_profiles (vendor, model, protocol, paper_width_mm)
                         VALUES ('X','Y','escpos-network',42)`);
    } catch (e) { badWidth = e.code; }
    ok('paper width is 58 or 80, nothing else prints', badWidth === '23514', badWidth);
    await admin.query(`INSERT INTO printers (id, store_id, branch_id, name, kind, protocol, address)
                       VALUES (1,1,1,'Kitchen Hot','kitchen','escpos-network','10.0.0.5:9100')`);
    await admin.query(`INSERT INTO printers (id, store_id, branch_id, name, kind, protocol, address)
                       VALUES (2,1,1,'Front','receipt','escpos-network','10.0.0.6:9100')`);
    let secondDefault = null;
    try {
      await admin.query(`UPDATE printers SET is_default_receipt = true WHERE id = 1`);
      await admin.query(`UPDATE printers SET is_default_receipt = true WHERE id = 2`);
    } catch (e) { secondDefault = e.code; }
    ok('only one default receipt printer per branch', secondDefault === '23505', secondDefault);
    // A second branch may have its own default, which is the point of branching.
    await admin.query(`INSERT INTO branches (id, store_id, name) VALUES (3,1,'Garden')`);
    let crossBranch = null;
    try {
      await admin.query(`INSERT INTO printers (id, store_id, branch_id, name, kind, protocol, is_default_receipt)
                         VALUES (3,1,3,'Garden Front','receipt','escpos-network',true)`);
    } catch (e) { crossBranch = e.code; }
    ok('but another branch can have its own default', crossBranch === null, crossBranch);

    await admin.query(`INSERT INTO scanners (id, store_id, branch_id, name, kind, transport)
                       VALUES (1,1,1,'Till 1','barcode','hid')`);
    const jobs = await admin.query(`SELECT count(*)::int n FROM print_jobs`);
    ok('the print queue starts empty', jobs.rows[0].n === 0);
    await admin.query(`INSERT INTO print_jobs (store_id, branch_id, printer_id, kind, payload)
                       VALUES (1,1,1,'kitchen','{"lines":["Latte"]}'::jsonb)`);
    const claimable = await admin.query(`SELECT count(*)::int n FROM print_jobs
                                         WHERE status='queued' AND printer_id=1 AND available_at <= now()`);
    ok('a queued job is immediately claimable by its printer', claimable.rows[0].n === 1, claimable.rows[0].n);
    let badStatus = null;
    try { await admin.query(`UPDATE print_jobs SET status='nonsense' WHERE store_id=1`); } catch (e) { badStatus = e.code; }
    ok('a job cannot be put into a state nothing handles', badStatus === '23514', badStatus);
  }

  console.log('\n== the claim query is index-only ==');
  {
    const plan = await admin.query(`EXPLAIN (COSTS OFF) SELECT id FROM print_jobs
                                    WHERE status='queued' AND printer_id=1 AND available_at <= now()
                                    ORDER BY available_at LIMIT 1`);
    const text = plan.rows.map((r) => r['QUERY PLAN']).join(' ');
    ok('a partial index serves the queue claim, not a sequential scan', /Index/.test(text), text.slice(0, 200));
  }

  await admin.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('schema conformance failed:', e.message);
  process.exit(1);
});
