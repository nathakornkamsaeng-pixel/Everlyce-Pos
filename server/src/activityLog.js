const fs = require('fs');
const path = require('path');

// A deliberately plain activity log: one line per event, no formatting,
// no structure to parse. Capped at 0.5 GB with simple rotation.
const MAX_BYTES = 500 * 1024 * 1024; // 0.5 GB
const KEEP_ROTATIONS = 1; // log.1 alongside log.txt
const FLUSH_EVERY = 200;

const DATA_DIR = process.env.POS_DATA_DIR || path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'activity.log');
const ROTATED = path.join(LOG_DIR, 'activity.log.1');

let pending = 0;
let timer = null;
const queue = [];

function ensureDir() {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(LOG_DIR, 0o700); } catch (e) {}
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch (e) { return 0; }
}

function rotateIfNeeded(incoming) {
  if (sizeOf(LOG_FILE) + incoming <= MAX_BYTES) return;
  try {
    if (fs.existsSync(ROTATED)) fs.unlinkSync(ROTATED);
    fs.renameSync(LOG_FILE, ROTATED);
  } catch (e) {
    // If rotation fails, truncate so the log can never grow without bound.
    try { fs.writeFileSync(LOG_FILE, ''); } catch (e2) {}
  }
}

// Appends go straight to disk. The volume is small (one line per order or
// setting change) and this guarantees a read always sees what was just written.
function flush() {
  if (!queue.length) return;
  const text = queue.splice(0, queue.length).join('');
  try {
    ensureDir();
    rotateIfNeeded(Buffer.byteLength(text));
    fs.appendFileSync(LOG_FILE, text, { mode: 0o600 });
    try { fs.chmodSync(LOG_FILE, 0o600); } catch (e) {}
  } catch (e) {
    // Never let logging break a request.
  }
}

function write(line) {
  queue.push(`${line}\n`);
  pending += 1;
  if (pending >= FLUSH_EVERY) {
    flush();
    return;
  }
  // Small volumes still land on disk promptly so the admin can read them live.
  if (!timer) {
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 250);
    if (timer.unref) timer.unref();
  }
}

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function actor(req) {
  if (!req || !req.user) return 'system';
  return req.user.username || `user:${req.user.id}`;
}

function storeOf(req) {
  if (!req) return '';
  if (req.store && req.store.slug) return ` store=${req.store.slug}`;
  return '';
}

// event names are short and fixed so the log stays easy to eyeball
const EVENTS = {
  LOGIN: 'login', LOGIN_FAIL: 'login-fail', LOGIN_BLOCKED: 'login-blocked', LOGIN_UNLOCK: 'login-unlock', LOGOUT: 'logout',
  ORDER_SENT: 'order-sent', ORDER_PAID: 'order-paid', ORDER_VOID: 'order-void',
  ORDER_DISCARD: 'order-discard', ORDER_STATUS: 'order-status',
  PROMPTPAY_REQUEST: 'promptpay-request', PROMPTPAY_CONFIRM: 'promptpay-confirm',
  SESSION_OPEN: 'session-open', SESSION_CLOSE: 'session-close',
  CASH_OPEN: 'cash-open', CASH_CLOSE: 'cash-close',
  STOCK_ADJUST: 'stock-adjust',
  MEMBER_NEW: 'member-new', MEMBER_UPDATE: 'member-update', MEMBER_DELETE: 'member-delete',
  POINTS_REDEEM: 'points-redeem', POINTS_EARN: 'points-earn', COUPON_USE: 'coupon-use',
  DATA_CLEAR: 'data-clear', SETTINGS_SAVE: 'settings-save',
  USER_NEW: 'user-new', USER_UPDATE: 'user-update', USER_DELETE: 'user-delete',
  I18N_PUBLISH: 'i18n-publish', I18N_COLLECT: 'i18n-collect',
  GHOST_CLEAN: 'ghost-clean', SERVER_START: 'server-start',
  API_KEY_ISSUED: 'api-key-issued', API_KEY_REVOKED: 'api-key-revoked', API_KEY_DENIED: 'api-key-denied',
  STORE_TRIAL_EXPIRED: 'store-trial-expired', STORE_TRIAL_ACTIVATED: 'store-trial-activated',
  STORE_REGISTER: 'store-register', STORE_ACTIVATED: 'store-activated',
  CONSENT_GRANTED: 'consent-granted', CONSENT_REFUSED: 'consent-refused', CONSENT_REVOKED: 'consent-revoked',
  STORE_PLAN_REQUESTED: 'store-plan-requested', STORE_PLAN_REQUEST_WITHDRAWN: 'store-plan-request-withdrawn', STORE_PLAN_REQUEST_FULFILLED: 'store-plan-request-fulfilled',
  STORE_ACTIVATE_FAIL: 'store-activate-fail', STORE_KEY_ISSUED: 'store-key-issued',
  STORE_KEY_REVOKED: 'store-key-revoked', STORE_STATUS: 'store-status', STORE_UPDATED: 'store-updated',
  STORE_REJECTED: 'store-rejected', STORE_CREATED: 'store-created', STORE_DELETED: 'store-deleted',
  BRANCH_CREATE: 'branch-create', BRANCH_UPDATE: 'branch-update', BRANCH_DELETE: 'branch-delete',
  DATA_SUBJECT_ACCESS: 'data-subject-access', DATA_SUBJECT_ERASURE: 'data-subject-erasure',
  CONSENT_WITHDRAWN: 'consent-withdrawn', DATA_RETENTION_PURGE: 'data-retention-purge',
  PRIVACY_NOTICE: 'privacy-notice', STAT_REPORT: 'stat-report',
};

// usage: log(EVENTS.LOGIN, req, { id, ip })
function log(event, req, detail) {
  const who = actor(req);
  let extra = '';
  if (detail && typeof detail === 'object') {
    extra = Object.keys(detail)
      .filter((k) => detail[k] !== undefined && detail[k] !== null && detail[k] !== '')
      .map((k) => `${k}=${formatValue(detail[k])}`)
      .join(' ');
  } else if (detail !== undefined && detail !== null) {
    extra = `value=${formatValue(detail)}`;
  }
  write(`${stamp()} ${event} who=${who}${storeOf(req)}${extra ? ' ' + extra : ''}`);
}

function formatValue(v) {
  const s = String(v);
  return /[\s|]/.test(s) ? `"${s.replace(/"/g, "'")}"` : s;
}

function read(options = {}) {
  ensureDir();
  flush();
  const limit = Math.max(1, Math.min(Number(options.lines) || 500, 5000));
  const file = options.includeRotated && fs.existsSync(ROTATED) ? ROTATED : LOG_FILE;
  if (!fs.existsSync(file)) return { lines: [], size: 0, rotated: false, max: MAX_BYTES };
  const size = sizeOf(file);
  // read only the tail we need
  const fd = fs.openSync(file, 'r');
  try {
    const want = limit * 220;
    const length = Math.min(size, want);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    return {
      lines: buf.toString('utf8').split('\n').filter(Boolean).slice(-limit),
      size,
      rotated: size >= MAX_BYTES,
      max: MAX_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function clear() {
  queue.length = 0;
  pending = 0;
  try { if (fs.existsSync(ROTATED)) fs.unlinkSync(ROTATED); } catch (e) {}
  try { if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, ''); } catch (e) {}
  write(`${stamp()} log-cleared`);
}

module.exports = { log, read, clear, EVENTS, MAX_BYTES, LOG_FILE };
