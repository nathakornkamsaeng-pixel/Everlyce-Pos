const express = require('express');
const { buildReport, readableUptime } = require('../dbHealth');
const { requirePlatformAuth } = require('../middleware');
const { DATA_FILE, BACKUP_FILE, storeList, storageInfo } = require('../db');
const { log, EVENTS } = require('../activityLog');
const { renderPublicStatus } = require('../publicStatus');
const { BRAND_VERSION } = require('../brandVersion');

// An internal health and data report: how many rows the system holds, how big
// the file is, and whether the data still hangs together.
//
// It is behind the platform sign-in on purpose. An open version of this page
// would tell a stranger how many stores exist, how many staff, how many orders
// and how much customer data is on file, which is reconnaissance for anyone
// deciding whether this install is worth attacking. Nothing here is secret
// enough to matter to the owner, and quite enough to help an attacker.

const router = express.Router();

// Refuse bursts. This page is for a person looking at it, not for polling.
let hits = 0;
let windowStart = Date.now();
function throttle(req, res, next) {
  const now = Date.now();
  if (now - windowStart > 60 * 1000) {
    windowStart = now;
    hits = 0;
  }
  hits += 1;
  if (hits > 20) return res.status(429).json({ detail: 'Slow down' });
  return next();
}

function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

router.get('/report', requirePlatformAuth, throttle, (req, res) => {
  res.set('Cache-Control', 'no-store');
  let report;
  try {
    report = buildReport({ dataFile: DATA_FILE, backupFile: BACKUP_FILE, storage: storageInfo() });
  } catch (e) {
    return res.status(500).json({ detail: 'Could not build the report', error: e.message });
  }
  log(EVENTS.STAT_REPORT, req, { scope: 'platform' });
  if (wantsHtml(req)) return res.type('html').send(renderHtml(report));
  return res.json(report);
});

// A status dot or a monitoring ping for machines, and a page worth looking at
// for people. Content negotiation keeps both honest: a browser asking for HTML
// gets the public status page, anything else gets the same small JSON it has
// always got, so monitoring and uptime checks do not have to change.
router.get('/health', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const startedAt = process.hrtime.bigint();
  let report;
  try {
    report = buildReport({ dataFile: DATA_FILE, backupFile: BACKUP_FILE, storage: storageInfo() });
  } catch (e) {
    return res.status(503).json({ ok: false, detail: 'Data unavailable' });
  }
  const fail = report.integrity.status === 'fail';
  if (wantsHtml(req)) {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return res.status(fail ? 503 : 200)
      .type('html')
      .send(renderPublicStatus({ report, responseMs: Math.max(1, Math.round(ms)), brandVersion: BRAND_VERSION }));
  }
  // Deliberately no store count and no row count. This endpoint is unauthenticated
  // and is meant to be shown to people, and "1 store, 533 rows" is exactly the
  // reconnaissance a stranger would want. A monitor gets the verdict, which is
  // what it is actually for; the counts live on the platform-signed-in report.
  res.status(fail ? 503 : 200).json({
    ok: !fail,
    status: report.integrity.status,
    errors: report.integrity.counts.error,
    warnings: report.integrity.counts.warn,
    uptime: report.process.uptimeReadable,
  });
});

// Self-contained on purpose: a health page has to render even when the app
// bundle is what is broken.
function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bar(fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return `<span class="bar"><i style="width:${pct}%"></i></span>`;
}

function renderHtml(r) {
  const sev = { pass: 'ok', degraded: 'warn', fail: 'bad' };
  const findings = r.integrity.findings.length
    ? r.integrity.findings.map((f) => `
      <tr class="f-${f.severity}">
        <td><span class="pill ${f.severity}">${escapeHtml(f.severity)}</span></td>
        <td><code>${escapeHtml(f.code)}</code></td>
        <td>${escapeHtml(f.message)}</td>
      </tr>`).join('')
    : '<tr><td colspan="3" class="muted">No problems found. Every record still points at something that exists.</td></tr>';

  const records = Object.entries(r.totals.records)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `
      <tr>
        <td><code>${escapeHtml(k)}</code></td>
        <td class="num">${n.toLocaleString('en-US')}</td>
        <td class="barcell">${bar(r.totals.rows ? n / Math.max(...Object.values(r.totals.records)) : 0)}</td>
      </tr>`).join('');

  const stores = r.stores.map((s) => `
    <tr>
      <td><a href="/${escapeHtml(s.slug)}">/${escapeHtml(s.slug)}</a></td>
      <td>${escapeHtml(s.name)}</td>
      <td><span class="pill ${s.status === 'active' ? 'ok' : s.status === 'suspended' ? 'bad' : 'warn'}">${escapeHtml(s.status)}</span></td>
      <td class="num">${s.counts.orders.toLocaleString('en-US')}</td>
      <td class="num">${s.counts.orderItems.toLocaleString('en-US')}</td>
      <td class="num">${s.counts.users.toLocaleString('en-US')}</td>
      <td class="num">${s.counts.products.toLocaleString('en-US')}</td>
      <td class="num">${s.counts.loyaltyMembers.toLocaleString('en-US')}</td>
      <td class="num">${s.total.toLocaleString('en-US')}</td>
      <td>${s.hasAdmin ? 'yes' : '<span class="pill bad">no admin</span>'}</td>
    </tr>`).join('');

  const f = r.files;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Everlyce POS · data health</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0f1319; color: #e6e9ef;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, sans-serif; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -0.02em; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8b93a1; margin: 32px 0 12px; }
  .sub { color: #8b93a1; margin: 0 0 24px; font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .card { background: #171c24; border: 1px solid #232a35; border-radius: 12px; padding: 16px; }
  .card .n { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .card .l { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b93a1; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: #171c24;
    border: 1px solid #232a35; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid #1e242e; font-size: 13px; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b93a1; font-weight: 600; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.barcell { width: 160px; }
  .bar { display: block; height: 6px; background: #1e242e; border-radius: 3px; overflow: hidden; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, #3563b8, #17b978); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: #9db4d8; }
  .pill { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .pill.ok, .pill.pass { background: #12332a; color: #3ddc97; }
  .pill.warn, .pill.degraded { background: #3a2d13; color: #f0b429; }
  .pill.bad, .pill.fail, .pill.error { background: #3a1c1c; color: #f08c8c; }
  .pill.info { background: #16273f; color: #7fa6e8; }
  a { color: #7fa6e8; }
  .kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 14px; }
  .kv div { background: #171c24; border: 1px solid #232a35; border-radius: 10px; padding: 12px 14px; }
  .kv dt { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #8b93a1; }
  .kv dd { margin: 3px 0 0; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .muted { color: #8b93a1; }
  footer { margin-top: 36px; color: #6b7280; font-size: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Everlyce POS · data health</h1>
  <p class="sub">${escapeHtml(r.scope)} · schema v${r.schemaVersion} · generated ${escapeHtml(r.generatedAt)}</p>

  <div class="cards">
    <div class="card"><div class="n" style="color:${r.integrity.status === 'pass' ? '#3ddc97' : r.integrity.status === 'warn' ? '#f0b429' : '#f08c8c'}">${escapeHtml(r.integrity.status)}</div><div class="l">integrity</div></div>
    <div class="card"><div class="n">${r.totals.stores}</div><div class="l">stores</div></div>
    <div class="card"><div class="n">${r.totals.rows.toLocaleString('en-US')}</div><div class="l">rows</div></div>
    <div class="card"><div class="n">${r.integrity.counts.error || 0}</div><div class="l">errors</div></div>
    <div class="card"><div class="n">${r.integrity.counts.warn || 0}</div><div class="l">warnings</div></div>
    <div class="card"><div class="n">${f.dataFile.sizeMb || 0}</div><div class="l">data file (MB)</div></div>
  </div>

  <h2>Checks</h2>
  <table>
    <thead><tr><th>Severity</th><th>Check</th><th>Detail</th></tr></thead>
    <tbody>${findings}</tbody>
  </table>

  <h2>Rows by collection</h2>
  <table>
    <thead><tr><th>Collection</th><th class="num">Rows</th><th>Share</th></tr></thead>
    <tbody>${records || '<tr><td colspan="3" class="muted">Nothing stored yet.</td></tr>'}</tbody>
  </table>

  <h2>Stores</h2>
  <table>
    <thead><tr><th>Path</th><th>Name</th><th>Status</th><th class="num">Orders</th>
      <th class="num">Items</th><th class="num">Staff</th><th class="num">Menu</th>
      <th class="num">Members</th><th class="num">Rows</th><th>Admin</th></tr></thead>
    <tbody>${stores || '<tr><td colspan="10" class="muted">No stores.</td></tr>'}</tbody>
  </table>

  <h2>Storage and process</h2>
  <dl class="kv">
    <div><dt>Data file</dt><dd>${f.dataFile.sizeMb || 0} MB</dd></div>
    <div><dt>Last write</dt><dd>${escapeHtml(f.dataFile.modifiedAt || 'never')}</dd></div>
    <div><dt>Backup</dt><dd>${f.backup && !f.backup.missing ? f.backup.sizeMb + ' MB' : 'missing'}</dd></div>
    <div><dt>Uptime</dt><dd>${escapeHtml(r.process.uptimeReadable)}</dd></div>
    <div><dt>Memory in use</dt><dd>${r.process.rssMb} MB</dd></div>
    <div><dt>Node</dt><dd>${escapeHtml(r.process.nodeVersion)}</dd></div>
  </dl>

  <footer>
    Counts and internal ids only. No customer names, phone numbers, emails or
    order contents appear on this page. Restricted to platform administrators,
    and every view is written to the activity log.
  </footer>
</div>
</body>
</html>`;
}

module.exports = router;
