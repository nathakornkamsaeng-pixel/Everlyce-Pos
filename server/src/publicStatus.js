// The public face of /api/stat/health.
//
// A browser gets this page; a monitoring client asking for JSON still gets the
// small machine-readable object it has always got. The split is deliberate:
// this page is meant to be screenshotted and sent to people, so it carries no
// store names, no slugs and no row counts. Those are reconnaissance, and they
// already exist on the JSON side for the owner who needs them.
//
// Self-contained on purpose. A status page has to render even when the app
// bundle is what is broken, so there is no external font, image or script, and
// it stays inside the site's Content-Security-Policy.
//
// The layout is deliberately almost entirely typographic. Containers, gradients
// and cards were tried first and read as a template: every fact boxed, the eye
// with nowhere to rest. Hairline rules and whitespace do the same work with far
// less noise, so there is one alignment axis and almost no filled surfaces.

const WORDMARK = `<svg class="mark" viewBox="0 0 256 256" role="img" aria-label="Everlyce POS">
  <defs>
    <linearGradient id="sbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d3a6b"/>
      <stop offset="0.55" stop-color="#24518f"/>
      <stop offset="1" stop-color="#2f7ad4"/>
    </linearGradient>
  </defs>
  <rect width="256" height="256" rx="56" fill="url(#sbg)"/>
  <g>
    <rect x="72" y="64" width="112" height="30" rx="15" fill="#fff"/>
    <rect x="72" y="113" width="86" height="30" rx="15" fill="#3ddc97"/>
    <rect x="72" y="162" width="112" height="30" rx="15" fill="#fff"/>
    <rect x="72" y="64" width="30" height="128" rx="15" fill="#fff"/>
  </g>
</svg>`;

// One phrase each, and no glosses: the strip is there to be read in one pass,
// not studied.
const CAPABILITIES = [
  'Till and tables', 'Orders', 'Payments', 'Kitchen display', 'Loyalty',
  'Menu and stock', 'Receipts', 'Multi-store', 'Multi-branch', 'PDPA privacy',
  'Self-hosting', 'Thai and English',
];

// Short enough to sit as a label and a line of text with no table furniture.
const POSTURE = [
  ['Transport', 'HTTPS only, HSTS'],
  ['Headers', 'CSP, nosniff, frame-deny'],
  ['Rate limits', 'Sign-in, sign-up, activation'],
  ['Credentials', 'bcrypt, never returned'],
  ['Keys', 'SHA-256, single use, revocable'],
  ['Tokens', 'Store- and platform-scoped'],
  ['Isolation', 'One bucket per store'],
  ['Audit', 'Sign-in and settings logged'],
];

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function readableUptime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return d ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// Only the verdict and how many advisories, never what they are: a public page
// that listed "1 table session has been open for more than a day" would be
// telling a stranger something about how the shop is being run.
function verdict(status, counts) {
  if (status === 'fail') {
    return { tone: 'bad', line: 'Action required', note: 'The integrity checks found problems that need a look.' };
  }
  if (status === 'degraded') {
    const n = (counts && counts.warn) || 0;
    return {
      tone: 'warn',
      line: `Operational, with ${n} ${n === 1 ? 'advisory' : 'advisories'}`,
      note: 'Nothing is failing.',
    };
  }
  return { tone: 'ok', line: 'All systems operational', note: 'Every integrity check passes.' };
}

function renderPublicStatus({ report, responseMs, brandVersion }) {
  const v = verdict(report.integrity.status, report.integrity.counts);
  const p = report.process;
  const total = (report.integrity.counts.error || 0) + (report.integrity.counts.warn || 0) + (report.integrity.counts.info || 0);
  const platform = String(p.platform).replace(/^linux$/i, 'Linux').replace(/^darwin$/i, 'macOS');

  const feats = CAPABILITIES.map((c) => `<span class="feat">${esc(c)}</span>`).join('');

  const posture = POSTURE
    .map(([t, d]) => `<div class="post"><span class="post-t">${esc(t)}</span><span class="post-d">${esc(d)}</span></div>`)
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0a0c11">
<title>Everlyce POS · status</title>
<link rel="icon" href="/brand/favicon.svg?v=${brandVersion}" type="image/svg+xml">
<style>
  :root {
    --bg: #0a0c11;
    --ink: #e9edf4;
    --mid: #97a2b4;
    --dim: #6b7588;
    --faint: #4a5364;
    --line: rgba(255,255,255,0.085);
    --ok: #3ddc97;
    --warn: #f0b429;
    --bad: #f07070;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 880px; margin: 0 auto; padding: 56px 28px 72px; }

  /* ---- masthead ---- */
  .top { display: flex; align-items: center; gap: 11px; padding-bottom: 26px; border-bottom: 1px solid var(--line); }
  .mark { width: 26px; height: 26px; border-radius: 7px; flex: none; }
  .brand { font-size: 14.5px; font-weight: 650; letter-spacing: -0.005em; }
  .top-right { margin-left: auto; display: flex; align-items: center; gap: 18px; }
  .stamp { font-size: 12px; color: var(--faint); font-variant-numeric: tabular-nums; }
  button.copy {
    font: inherit; font-size: 12px; color: var(--mid); cursor: pointer;
    background: none; border: 1px solid var(--line); border-radius: 5px;
    padding: 5px 11px; transition: color .15s, border-color .15s;
  }
  button.copy:hover { color: var(--ink); border-color: rgba(255,255,255,0.22); }
  button.copy.done { color: var(--ok); border-color: rgba(61,220,151,0.35); }

  /* ---- verdict ---- */
  .verdict { padding: 40px 0 38px; }
  .line { display: flex; align-items: baseline; gap: 11px; }
  .swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; position: relative; top: -1px; }
  .swatch.ok { background: var(--ok); } .swatch.warn { background: var(--warn); } .swatch.bad { background: var(--bad); }
  .line-text { font-size: 21px; font-weight: 600; letter-spacing: -0.018em; }
  .note { margin: 8px 0 0 19px; font-size: 13.5px; color: var(--mid); }

  /* ---- figures: a spec sheet, ruled rather than boxed ---- */
  .figs { display: grid; grid-template-columns: repeat(5, 1fr); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
  .fig { padding: 17px 18px 17px 0; }
  .fig + .fig { border-left: 1px solid var(--line); padding-left: 18px; }
  .fig-l { font-size: 10.5px; font-weight: 600; letter-spacing: 0.11em; text-transform: uppercase; color: var(--faint); }
  .fig-v { margin-top: 6px; font-size: 19px; font-weight: 600; letter-spacing: -0.015em; font-variant-numeric: tabular-nums; }
  .fig-n { margin-top: 2px; font-size: 12px; color: var(--dim); }

  /* ---- sections ---- */
  section { padding-top: 42px; }
  h2 { margin: 0 0 16px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.13em; text-transform: uppercase; color: var(--faint); }

  /* An aligned grid, not a wrapped sentence: a run of separators leaves a
     dangling dot at the end of every line it breaks on. */
  .feats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 11px 24px; }
  .feat { font-size: 14px; color: #c6cedd; letter-spacing: -0.005em; }

  .posts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 11px 40px; }
  .post { display: flex; align-items: baseline; gap: 12px; min-width: 0; }
  .post-t { flex: none; font-size: 13px; font-weight: 600; color: #b9c2d1; }
  .post-d { font-size: 13px; color: var(--dim); }

  footer { margin-top: 48px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 12.5px; color: var(--faint); }
  footer p { margin: 0 0 6px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: var(--dim); }

  @media (max-width: 780px) {
    .wrap { padding: 34px 20px 56px; }
    .figs { grid-template-columns: repeat(2, 1fr); }
    .fig { padding: 14px 16px 14px 0; }
    .fig + .fig { border-left: 0; padding-left: 0; }
    .fig:nth-child(2n) { border-left: 1px solid var(--line); padding-left: 16px; }
    .fig:nth-child(n+3) { border-top: 1px solid var(--line); }
    .posts { grid-template-columns: 1fr; }
    .feats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .line-text { font-size: 19px; }
  }
  @media (max-width: 420px) {
    .figs { grid-template-columns: 1fr; }
    .feats { grid-template-columns: 1fr; }
    .fig:nth-child(2n) { border-left: 0; padding-left: 0; }
    .fig + .fig { border-top: 1px solid var(--line); }
    .stamp { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">

  <header class="top">
    ${WORDMARK}
    <span class="brand">Everlyce POS</span>
    <span class="top-right">
      <span class="stamp">${esc(report.generatedAt.slice(0, 19).replace('T', ' '))} UTC</span>
      <button class="copy" id="copy" type="button">Copy link</button>
    </span>
  </header>

  <div class="verdict">
    <div class="line">
      <span class="swatch ${v.tone}"></span>
      <span class="line-text">${esc(v.line)}</span>
    </div>
    <p class="note">${esc(v.note)}</p>
  </div>

  <div class="figs">
    <div class="fig">
      <div class="fig-l">Uptime</div>
      <div class="fig-v" id="uptime">${esc(readableUptime(p.uptimeSeconds))}</div>
      <div class="fig-n">since restart</div>
    </div>
    <div class="fig">
      <div class="fig-l">Response</div>
      <div class="fig-v">${responseMs} ms</div>
      <div class="fig-n">to build</div>
    </div>
    <div class="fig">
      <div class="fig-l">Runtime</div>
      <div class="fig-v">${esc(p.nodeVersion.replace(/^v/, ''))}</div>
      <div class="fig-n">Node on ${esc(platform)}</div>
    </div>
    <div class="fig">
      <div class="fig-l">Memory</div>
      <div class="fig-v">${p.rssMb} MB</div>
      <div class="fig-n">${p.heapUsedMb} MB heap</div>
    </div>
    <div class="fig">
      <div class="fig-l">Integrity</div>
      <div class="fig-v">${report.integrity.status === 'pass' ? 'Pass' : report.integrity.status === 'degraded' ? 'Advisory' : 'Failing'}</div>
      <div class="fig-n">${total === 0 ? 'nothing to review' : `${total} finding${total === 1 ? '' : 's'}`}</div>
    </div>
  </div>

  <section>
    <h2>What it does</h2>
    <div class="feats">${feats}</div>
  </section>

  <section>
    <h2>Security</h2>
    <div class="posts">${posture}</div>
  </section>

  <footer>
    <p>No customer data, no store names and no record counts on this page. Those sit behind the platform sign-in, where every view is written to the audit log.</p>
    <p>For monitoring: <code>curl ${esc('/api/stat/health')}</code> returns the same verdict as JSON.</p>
  </footer>

</div>
<script>
  // Ticks between page loads, seeded from the server's own clock so it starts
  // at exactly the value the server reported.
  (function () {
    var node = document.getElementById('uptime');
    var seconds = ${Number(p.uptimeSeconds)} + Math.max(0, (Date.now() - ${Date.parse(report.generatedAt)}) / 1000);
    var fmt = function (s) {
      s = Math.max(0, Math.floor(s));
      var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
          m = Math.floor((s % 3600) / 60), sec = s % 60;
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d ? d + 'd ' + pad(h) + 'h ' + pad(m) + 'm' : pad(h) + ':' + pad(m) + ':' + pad(sec);
    };
    setInterval(function () { seconds += 1; if (node) node.textContent = fmt(seconds); }, 1000);

    var btn = document.getElementById('copy');
    if (!btn) return;
    var reset = function () {
      btn.textContent = 'Copied';
      btn.classList.add('done');
      setTimeout(function () { btn.textContent = 'Copy link'; btn.classList.remove('done'); }, 1600);
    };
    btn.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href).then(reset, function () {});
        return;
      }
      var field = document.createElement('textarea');
      field.value = location.href;
      field.setAttribute('readonly', '');
      field.style.position = 'absolute';
      field.style.left = '-9999px';
      document.body.appendChild(field);
      field.select();
      try { document.execCommand('copy'); reset(); } catch (e) {}
      document.body.removeChild(field);
    });
  })();
</script>
</body>
</html>`;
}

module.exports = { renderPublicStatus, readableUptime, CAPABILITIES, POSTURE };
