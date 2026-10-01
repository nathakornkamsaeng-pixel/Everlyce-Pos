const path = require('path');
const fs = require('fs');
const express = require('express');
const db = require('./db');
const { coll, findStoreBySlug, storeIsActive, DEFAULT_STORE_SLUG, findStoreById } = db;
const auth = require('./routes/auth');
const platform = require('./routes/platform');
const stat = require('./routes/stat');
const { ensureBootstrapAdmin } = require('./bootstrap');
const privacyNotice = require('./privacyNotice');
const storeMiddleware = require('./storeMiddleware');
const { storeContext, requireActiveStore } = storeMiddleware;

db.load();

// Sweeps personal data past its retention period for every store, and records
// what it removed in the activity log.
function runRetentionSweep() {
  const pdpa = require('./pdpa');
  const { log, EVENTS } = require('./activityLog');
  let total = 0;
  db.eachStore((store) => {
    const result = db.withStore(store, () => pdpa.purgeExpired());
    if (result.purged) {
      total += result.purged;
      log(EVENTS.DATA_RETENTION_PURGE, { user: null }, { store: store.slug, purged: result.purged });
    }
  });
  if (total) console.log(`Retention: removed ${total} customer record(s) past the retention period`);
  return total;
}

async function start() {
  await ensureBootstrapAdmin();

  // Abandoned register tickets so they never surface as real orders.
  try { const n = db.cleanupGhosts(); if (n) console.log(`Removed ${n} abandoned register ticket(s)`); } catch (e) {}
  setInterval(() => { try { db.cleanupGhosts(); } catch (e) {} }, 2 * 60 * 1000).unref();

  // Retention. Personal data is not kept longer than the configured period, so
  // the sweep runs at startup and then hourly. A record whose consent was
  // withdrawn, or that has no consent at all and has aged out, is removed.
  try { runRetentionSweep(); } catch (e) {}
  setInterval(() => { try { runRetentionSweep(); } catch (e) {} }, 60 * 60 * 1000).unref();

  // Trials. A trial nobody enforces is just a free shop, so the deadline is
  // swept on a clock rather than checked when someone happens to ask. Hourly is
  // deliberate: it is the difference between a shop pausing a few hours after
  // its week is up and a shop finding out the next morning.
  const trial = require('./trial');
  function runTrialSweep() {
    const n = trial.expireTrials();
    if (n) console.log(`Paused ${n} store(s) whose free trial has ended`);
  }
  try { runTrialSweep(); } catch (e) { console.error('trial sweep failed', e.message); }
  setInterval(() => { try { runTrialSweep(); } catch (e) { console.error('trial sweep failed', e.message); } }, 60 * 60 * 1000).unref();

  const app = express();
  const { log, EVENTS } = require('./activityLog');
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  const allowedHosts = new Set((process.env.POS_ALLOWED_HOSTS || 'pos.example.com,localhost,127.0.0.1').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean));
  const corsOrigin = process.env.POS_CORS_ORIGIN || '';
  app.use(express.json({ limit: '2mb', strict: false }));

  // Before multi-store, every page lived at the root. Bookmarks and printed QR
  // codes still point at /login, /checkout, /order/<token> and so on, so those
  // are redirected into the original store rather than 404-ing.
  // A QR or receipt token identifies its own shop, so a guest following an old
  // link is sent to the right place instead of being guessed at.
  //
  // This is the only redirect left. There used to be one that sent /login and
  // every other page to /{shop}/login, which was how a single-shop install
  // worked before the app was mounted at the root of the host. Those URLs are now
  // the real ones, so redirecting them would bounce a guest to a path the app no
  // longer routes.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const segments = String(req.path || '').split('/').filter(Boolean);
    if (segments.length !== 2) return next();
    const [first, token] = segments;
    if (first !== 'order' && first !== 'receipt') return next();
    if (!db.defaultStore()) return next();
    const owner = first === 'order'
      ? storeMiddleware.storeForToken(token)
      : storeMiddleware.storeForReceiptToken(token);
    if (owner && owner.slug !== db.defaultStore().slug) {
      return res.redirect(302, `/${owner.slug}/${first}/${token}`);
    }
    return next();
  });

  // The store lives in the URL for page loads, and travels in a header for API
  // calls. Both are known before routing, so the brand can be inlined into the
  // HTML shell for a correct first paint and browser tab.
  app.use((req, res, next) => {
    const slug = String(req.path || '').replace(/^\//, '').split('/')[0].toLowerCase();
    req.pageStore = /^[a-z0-9][a-z0-9-]{1,39}$/.test(slug) ? findStoreBySlug(slug) : null;
    next();
  });

  app.use((req, res, next) => {
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    if (host && !allowedHosts.has(host)) return res.status(421).json({ detail: 'Host not allowed' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Liveness only. This used to report how many stores exist, which is free
  // reconnaissance for anyone who asks; a ping needs nothing but ok.
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  // Platform endpoints (register / activate / store admin) are deliberately
  // mounted before the store context so they never run inside a tenant.
  app.use('/api/platform', platform);
  // Platform-wide health and row counts. Behind the platform sign-in, because
  // an open version would advertise how many stores, staff and orders exist.
  app.use('/api/stat', stat);
  // Integration API. Mounted before the browser store context on purpose: the
  // key decides which store is in scope, and a staff session token is not
  // accepted here at all.
  app.use('/api/v1', require('./routes/apiV1'));
  // The privacy notice is read by people who are not signed in and send no
  // store header, so it resolves its own store and sits ahead of the tenant
  // middleware. A published notice that renders blank is worse than none.
  // The platform's own page copy, public because those pages are public.
  app.get('/api/platform-content/:lang', (req, res) => {
    // The retention period, not the trial length. The substitution used to feed
    // POS_TRIAL_DAYS into every {n} on these pages, which meant a privacy notice
    // stating how long customer data is kept was showing the length of a trial.
    // They happened to be the same number for a long time, which is exactly how
    // that goes unnoticed.
    //
    // Resolved against a store, because retention is a per-shop setting and this
    // route runs before the tenant middleware. The default store is the right
    // answer here: it is the only shop on a self-hosted install, and a privacy
    // notice that could not render its own retention period would be worse than
    // one showing the default.
    const values = (() => {
      try {
        const store = db.defaultStore();
        return { n: store ? db.withStore(store, () => require('./pdpa').retentionDays()) : 0 };
      } catch (e) {
        return { n: 0 };
      }
    })();
    const saved = Object.values(require('./platformContent').platformStrings())
      .reduce((acc, e) => {
        const body = req.params.lang === 'th' ? (e.th || e.en) : (e.en || e.th);
        if (body) acc[e.key] = body.replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));
        return acc;
      }, {});
    res.set('Cache-Control', 'no-store');
    res.json(saved);
  });

  // Cookie consent. Mounted before the tenant middleware because a visitor being
  // asked has no store and no account.
  app.use('/api/cookie-consent', require('./routes/cookieConsent'));

  app.get('/api/public/privacy-notice', (req, res) => {
    const found = privacyNotice.resolveNotice(req.query.store);
    if (!found) {
      return res.status(404).json({ detail: 'No privacy notice is published yet', code: 'notice_unavailable' });
    }
    return res.set('Cache-Control', 'no-store').json({ store: found.slug, ...found.notice });
  });

  // Everything below is tenant-scoped: coll() resolves to the store on
  // X-POS-Store, and a missing store is an error rather than a default.
  app.use('/api', storeContext());

  // A registered store may still sign in and activate, so those endpoints stay
  // open. Everything that touches real shop data needs a live store.
  app.use('/api', requireActiveStore);

  // Every store has at least one branch. Anything creating a table or an order
  // says which branch it belongs to, so the active branch is resolved once here
  // instead of in every handler. The browser sends X-POS-Branch.
  app.use('/api', (req, res, next) => {
    const branches = coll('branches');
    const requested = Number(req.headers['x-pos-branch'] || req.query.branch || (req.body && req.body.branchId));
    let branch = Number.isFinite(requested) && requested ? branches.find((b) => Number(b.id) === requested) : null;
    if (requested && !branch) return res.status(400).json({ detail: 'Unknown branch' });
    if (!branch) branch = branches.find((b) => b.isDefault) || branches[0] || null;
    req.branch = branch;
    req.branchId = branch ? Number(branch.id) : null;
    next();
  });

  app.use('/api/auth', auth);
  app.use('/api/branches', require('./routes/branches'));
  app.use('/api/users', require('./routes/users'));
  app.use('/api/settings', require('./routes/settings'));
  app.use('/api/tables', require('./routes/tables'));
  app.use('/api/categories', require('./routes/categories'));
  app.use('/api/products', require('./routes/products'));
  app.use('/api/modifier-groups', require('./routes/modifiers'));
  app.use('/api/orders', require('./routes/orders'));
  app.use('/api/payments', require('./routes/payments'));
  app.use('/api/subscription', require('./routes/subscription'));
  app.use('/api/shop-settings', require('./routes/shopSettings'));
  app.use('/api/discounts', require('./routes/discounts'));
  app.use('/api/cash-sessions', require('./routes/cashSessions'));
  app.use('/api/sessions', require('./routes/sessions'));
  app.use('/api/inventory', require('./routes/inventory'));
  app.use('/api/kds', require('./routes/kds'));
  app.use('/api/admin/data', require('./routes/adminData'));
  app.use('/api/loyalty', require('./routes/loyalty'));
  app.use('/api/api-keys', require('./routes/apiKeyAdmin'));
  // Public routes come before the catch-all report mount below: that router
  // requires a signed-in staff member, so mounting it at the API root first
  // would reject every customer request with 401.
  // Reads of the shared wording, for every store.
  app.use('/api/i18n', require('./routes/i18n'));
  // A shop's own wording, editable by that shop.
  app.use('/api/i18n/mine', require('./routes/storeI18n'));
  app.use('/api/display', require('./routes/display'));
  app.use('/api/public', require('./routes/public'));

  app.use('/api/reports', require('./routes/reports'));
  // The reports router declares paths like /reports/sales and /dashboard, so it
  // is also mounted at the API root. It must stay last among API routes.
  app.use('/api', require('./routes/reports'));

  app.use('/api', (req, res) => res.status(404).json({ detail: 'Not found' }));

  // First-paint brand: the store in the URL wins. The root page is the
  // platform's marketing site, so it gets the platform name, not a shop's.
  function shellBrandFor(req) {
    const store = req.pageStore || req.store;
    if (store) {
      if (storeIsActive(store)) {
        const name = db.withStore(store, () => (coll('settings') || {}).restaurantName);
        if (name) return name;
      }
      return store.name;
    }
    return 'Everlyce POS';
  }

  const dist = path.join(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(dist)) {
    // The SPA shell is served with the restaurant name already inlined, so the
    // brand is correct on first paint and in the browser tab.
    const SHELL = path.join(dist, 'index.html');
    const escapeHtml = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const sendShell = (req, res) => {
      const name = escapeHtml(shellBrandFor(req));
      fs.readFile(SHELL, 'utf8', (err, html) => {
        if (err) return res.status(500).send('Could not load the app');
        res.set('Content-Type', 'text/html; charset=utf-8');
        res.send(html.split('__RESTAURANT_NAME__').join(name));
      });
    };

    // An explicit /index.html must be branded too, so it is handled here.
    app.get('/index.html', sendShell);
    // Brand assets sit at stable, unversioned filenames, so they must not be
    // held for long: a logo change would never reach a returning visitor. The
    // general static handler below would otherwise send max-age=0 and leave
    // caching entirely up to whatever sits in front of the app.
    app.use('/brand', express.static(path.join(dist, 'brand'), {
      index: false,
      maxAge: '5m',
      setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate'),
    }));
    // index:false stops express.static short-cutting "/" and serving the raw
    // unbranded shell.
    app.use(express.static(dist, { index: false }));
    app.get(/^(?!\/api).*/, sendShell);
  }

  app.use((err, req, res, next) => {
    // A bad request is the caller's problem, not a server fault: keep the real
    // 4xx so the app can show something useful instead of a blanket 500.
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    if (res.headersSent) return next(err);
    res.status(status).json({
      detail: status >= 500 ? 'Internal server error' : (err.message || 'Bad request'),
      // Carried when the error set one, so the page can react to a specific
      // refusal rather than parsing the sentence. A store asking for a plan it
      // already has a pending request for is a different thing from being on an
      // unknown plan, and the two should not look identical to the caller.
      ...(err.code && status < 500 ? { code: err.code } : {}),
    });
  });

  const PORT = process.env.PORT || 8080;
  log(EVENTS.SERVER_START, { user: { username: 'system' } }, { port: PORT });
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`POS API listening on :${PORT}`);
  });
}

start();