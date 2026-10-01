// Store API keys, for integrations that are not a person at a till.
//
// The rule the user asked for: the integration surface is reachable with an
// API key, never with a browser session, and never anonymously. A key is bound
// to one store by construction, because the store id is part of the key and the
// hash is only ever compared inside that store's own bucket. A key for shop A
// therefore cannot read shop B, and revoking it takes effect on the next call.
//
// Only the SHA-256 hash is stored. The key itself is returned once, at creation,
// and cannot be recovered afterwards.

const crypto = require('crypto');
const { coll, nextId, now, touch, transaction, findStoreById, storeIsActive, runWithStore } = require('./db');

const PREFIX = 'evk';
const SECRET_BYTES = 24;

const SCOPES = [
  { id: 'catalog:read', label: 'Read the menu' },
  { id: 'orders:read', label: 'Read orders' },
  { id: 'orders:write', label: 'Create orders' },
];

const SCOPE_IDS = SCOPES.map((s) => s.id);

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

// evk_<storeId>_<secret>. The store id is not a secret: it is an internal
// autoincrement, and carrying it in the key is what makes the isolation
// auditable rather than implied.
function parse(key) {
  const m = /^evk_(\d{1,12})_([A-Za-z0-9_-]{20,120})$/.exec(String(key || '').trim());
  if (!m) return null;
  return { storeId: Number(m[1]), secret: m[2] };
}

function issue({ storeId, label, scopes }) {
  const wanted = SCOPE_IDS.filter((s) => (scopes || []).includes(s));
  if (!wanted.length) throw Object.assign(new Error('Pick at least one scope'), { status: 400 });

  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const key = `${PREFIX}_${storeId}_${secret}`;
  const record = {
    id: nextId('apiKeys'),
    label: String(label || '').trim().slice(0, 60) || 'Integration',
    scopes: wanted,
    prefix: key.slice(0, 14),
    hash: hashKey(key),
    createdAt: now(),
    lastUsedAt: null,
    revokedAt: null,
    useCount: 0,
  };
  transaction(() => coll('apiKeys').push(record));
  return { key, record };
}

// Compared in constant time, and only ever against the hashes in the caller's
// own store bucket.
function verifyWithinStore(key) {
  const wanted = hashKey(key);
  const target = Buffer.from(wanted, 'hex');
  for (const record of coll('apiKeys') || []) {
    const stored = Buffer.from(String(record.hash || ''), 'hex');
    if (stored.length === target.length && crypto.timingSafeEqual(stored, target)) {
      return record.revokedAt ? null : record;
    }
  }
  return null;
}

function keyFromRequest(req) {
  const auth = String(req.headers.authorization || '');
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer && bearer[1]) return bearer[1].trim();
  const header = req.headers['x-api-key'];
  if (header) return String(Array.isArray(header) ? header[0] : header).trim();
  return '';
}

// Revocation is a soft flag rather than a delete, so the audit trail can still
// show that the key existed and when it stopped working.
function revoke(record) {
  if (!record || record.revokedAt) return record;
  record.revokedAt = now();
  return record;
}

// Writes lastUsedAt at most once a minute per key, so a busy integration does
// not turn into a write on every single call.
const TOUCHED = new Map();
function touchUsage(record) {
  const nowMs = Date.now();
  const last = TOUCHED.get(record.hash) || 0;
  if (nowMs - last < 60 * 1000) return;
  TOUCHED.set(record.hash, nowMs);
  const live = (coll('apiKeys') || []).find((k) => Number(k.id) === Number(record.id));
  if (!live) return;
  live.lastUsedAt = now();
  live.useCount = (Number(live.useCount) || 0) + 1;
  touch();
}

// A plain in-memory bucket limiter, per key. Enough to stop one integration
// from hammering the till, and it resets with the process like the rest of the
// rate limiting on this service.
function rateLimit({ limit = 240, windowMs = 60 * 1000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const id = String(req.apiKey ? req.apiKey.id : 'anon');
    const nowMs = Date.now();
    const entry = hits.get(id);
    if (!entry || nowMs - entry.start > windowMs) {
      hits.set(id, { start: nowMs, count: 1 });
      if (hits.size > 5000) hits.clear();
      return next();
    }
    entry.count += 1;
    if (entry.count > limit) {
      res.set('Retry-After', String(Math.ceil((entry.start + windowMs - nowMs) / 1000)));
      return res.status(429).json({ detail: 'Too many requests', code: 'rate_limited' });
    }
    return next();
  };
}

// Resolves the key, and only the key, to a store. Mounted ahead of the browser
// store context on purpose: a session token must not be accepted here, and the
// key is the single authority on which tenant this request touches.
function requireApiKey(scope) {
  return (req, res, next) => {
    const raw = keyFromRequest(req);
    if (!raw) {
      return res.status(401).json({ detail: 'API key required', code: 'api_key_required' });
    }
    const parsed = parse(raw);
    if (!parsed) {
      return res.status(401).json({ detail: 'Malformed API key', code: 'api_key_invalid' });
    }
    const store = findStoreById(parsed.storeId);
    if (!store || !storeIsActive(store)) {
      // Same answer whether the store is missing or merely not active, so the
      // response cannot be used to enumerate store ids.
      return res.status(403).json({ detail: 'This key cannot be used', code: 'api_key_rejected' });
    }
    const record = runWithStore(store, () => verifyWithinStore(raw));
    if (!record) {
      return res.status(401).json({ detail: 'API key rejected', code: 'api_key_rejected' });
    }
    if (scope && !record.scopes.includes(scope)) {
      return res.status(403).json({ detail: `This key is not allowed to ${scope}`, code: 'api_key_scope' });
    }
    req.apiKey = record;
    req.apiKeyStore = store;
    req.store = store;
    req.storeSlug = store.slug;
    // touchUsage reads the key collection, so it has to run inside the store
    // context, not just after it has been identified.
    return runWithStore(store, () => {
      touchUsage(record);
      next();
    });
  };
}

// What an owner sees in the key list. Never the hash, never the key.
function publicKey(record) {
  return {
    id: record.id,
    label: record.label,
    scopes: record.scopes,
    prefix: record.prefix,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt || null,
    useCount: Number(record.useCount) || 0,
    revokedAt: record.revokedAt || null,
  };
}

module.exports = {
  SCOPES, SCOPE_IDS, PREFIX,
  parse, issue, revoke, verifyWithinStore, requireApiKey, rateLimit, publicKey, hashKey,
};
