const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { coll, nextId, now, touch, transaction, storeIsActive, contactEmail } = require('../db');
const { log, EVENTS } = require('../activityLog');
const { signToken, publicUser, revokeToken, requireAuth, requireRole } = require('../middleware');
const { rateLimit, clientIp } = require('../rateLimit');

const router = express.Router();
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('pos-invalid-credential', 10);

function boundedSetting(key, fallback, minimum, maximum) {
  const value = Number(coll('settings')[key]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function lockPolicy() {
  return {
    attempts: boundedSetting('loginLockAttempts', 5, 1, 100),
    windowMs: boundedSetting('loginLockWindowMinutes', 15, 1, 1440) * 60 * 1000,
    blockMs: boundedSetting('loginLockBlockMinutes', 30, 1, 1440) * 60 * 1000,
    maxMs: boundedSetting('loginLockMaxHours', 24, 1, 24) * 60 * 60 * 1000,
  };
}

function time(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

function lockKey(username, ip) {
  return crypto.createHash('sha256').update(`${username}|${ip}`).digest('hex');
}

function findLock(username, ip) {
  const key = lockKey(username, ip);
  return coll('securityLocks').find((entry) => entry.key === key) || null;
}

function activeLock(username, ip) {
  const entry = findLock(username, ip);
  return entry && time(entry.blockedUntil) > Date.now() ? entry : null;
}

function recordLoginFailure(username, ip) {
  const policy = lockPolicy();
  const key = lockKey(username, ip);
  const timestamp = Date.now();
  return transaction(() => {
    const list = coll('securityLocks');
    let entry = list.find((candidate) => candidate.key === key);
    const expired = Boolean(entry && entry.blockedUntil) && time(entry.blockedUntil) <= timestamp;
    const outsideWindow = entry && timestamp - new Date(entry.lastFailureAt || entry.createdAt).getTime() > policy.windowMs;
    if (!entry) {
      entry = { id: nextId('securityLocks'), key, username, ip, failures: 0, lockCount: 0, firstFailureAt: now(), lastFailureAt: now(), blockedUntil: null, createdAt: now() };
      list.push(entry);
    } else if (expired || outsideWindow) {
      entry.failures = 0;
      entry.firstFailureAt = now();
    }
    if (time(entry.blockedUntil) > timestamp) return entry;
    entry.failures = Number(entry.failures || 0) + 1;
    entry.lastFailureAt = now();
    if (entry.failures >= policy.attempts) {
      entry.lockCount = Number(entry.lockCount || 0) + 1;
      const multiplier = Math.pow(2, Math.max(0, entry.lockCount - 1));
      entry.blockedUntil = new Date(timestamp + Math.min(policy.blockMs * multiplier, policy.maxMs)).toISOString();
    }
    for (const stale of list.filter((candidate) => (
      time(candidate.blockedUntil) <= timestamp
      && timestamp - new Date(candidate.lastFailureAt || candidate.createdAt).getTime() > Math.max(policy.windowMs, 24 * 60 * 60 * 1000)
    ))) list.splice(list.indexOf(stale), 1);
    return entry;
  });
}

function clearLoginLock(username, ip) {
  const key = lockKey(username, ip);
  const list = coll('securityLocks');
  const index = list.findIndex((entry) => entry.key === key);
  if (index < 0) return;
  transaction(() => {
    const live = coll('securityLocks');
    const current = live.findIndex((entry) => entry.key === key);
    if (current >= 0) live.splice(current, 1);
  });
}

function lockDto(entry) {
  const blockedUntil = time(entry.blockedUntil);
  return {
    id: entry.id,
    username: entry.username,
    ip: entry.ip,
    failures: Number(entry.failures || 0),
    lockCount: Number(entry.lockCount || 0),
    blockedUntil: entry.blockedUntil || null,
    retryAfterSeconds: blockedUntil > Date.now() ? Math.max(1, Math.ceil((blockedUntil - Date.now()) / 1000)) : 0,
    lastFailureAt: entry.lastFailureAt || null,
  };
}


// Two caps, because one cap cannot do both jobs here.
//
// Per account from an address: defence in depth alongside the lockout counter,
// and it stays per-address so a shared connection is not punished for the
// other tills on it.
//
// Per address overall: a deliberately high ceiling. A shop's tills are usually
// behind one router, so every terminal shares an IP, and a low cap would lock
// out a whole shop at dinnertime. This is here to bound CPU, because every
// attempt costs a bcrypt compare, not to catch someone walking usernames --
// that is what the per-account lockout already does, one account at a time.
const loginCeiling = Number(process.env.POS_RATE_LOGIN_PER_IP || 300);

const perAccountGuessLimit = rateLimit({
  limit: 20,
  windowMs: 15 * 60 * 1000,
  key: (req) => {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    return `${clientIp(req)}|${String(req.storeSlug || '')}|${String(body.username || '').toLowerCase()}`;
  },
  message: 'Too many sign-in attempts for this account. Try again later.',
  code: 'login_rate_limited',
});

const perAddressCeiling = rateLimit({
  limit: Number.isFinite(loginCeiling) && loginCeiling > 0 ? loginCeiling : 300,
  windowMs: 15 * 60 * 1000,
  key: (req) => `${clientIp(req)}|signin`,
  message: 'Too many sign-in attempts from this address. Try again later.',
  code: 'login_address_rate_limited',
});

const reauthLimit = rateLimit({
  limit: 15,
  windowMs: 15 * 60 * 1000,
  key: (req) => `${clientIp(req)}|reauth`,
  message: 'Too many attempts. Try again later.',
  code: 'reauth_rate_limited',
});

router.post('/login', perAccountGuessLimit, perAddressCeiling, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = String(body.username || '').trim().toLowerCase();
  const ip = requestIp(req);
  // A store that registered but has not activated yet is a normal state, not a
  // wrong password. Sign-in is allowed so the owner can reach the activation
  // screen; the store API stays closed until a key is used. A suspended store
  // is closed outright, so it cannot even get that far.
  if (req.store && req.store.status === 'suspended') {
    log(EVENTS.LOGIN_FAIL, { user: { username } }, { store: req.store.slug, ip, reason: 'suspended' });
    return res.status(403).json({
      message: `Store /${req.store.slug} is suspended. Please contact ${contactEmail()}.`,
      code: 'store_suspended',
      store: { slug: req.store.slug, name: req.store.name, status: req.store.status },
      contactEmail: contactEmail(),
    });
  }
  const locked = activeLock(username, ip);
  if (locked) {
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(locked.blockedUntil).getTime() - Date.now()) / 1000));
    log(EVENTS.LOGIN_BLOCKED, { user: { username } }, { ip, store: req.store?.slug, retryAfter: retryAfterSeconds });
    return res.status(429).json({ message: 'Login temporarily locked for this account and IP', retryAfterSeconds });
  }
  const user = coll('users').find((candidate) => candidate.username && candidate.username.toLowerCase() === username && candidate.active);
  const usingPin = body.pin !== undefined;
  const supplied = String(usingPin ? (body.pin ?? '') : (body.password ?? ''));
  const storedHash = user ? (usingPin ? user.pinHash : user.passwordHash) : null;
  const ok = await bcrypt.compare(supplied, storedHash || DUMMY_PASSWORD_HASH);
  if (!user || !ok) {
    const entry = recordLoginFailure(username, ip);
    const retryAfterSeconds = Math.max(0, Math.ceil((new Date(entry.blockedUntil || 0).getTime() - Date.now()) / 1000));
    log(EVENTS.LOGIN_FAIL, { user: { username: username || '?' } }, { ip, store: req.store?.slug, failures: entry.failures, retryAfter: retryAfterSeconds });
    if (retryAfterSeconds > 0) return res.status(429).json({ message: 'Login temporarily locked for this account and IP', retryAfterSeconds });
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  clearLoginLock(username, ip);
  log(EVENTS.LOGIN, user ? { user } : { user: { username } }, { id: user.id, role: user.role, ip, store: req.store?.slug });
  res.json({
    token: signToken(user, req.store),
    user: publicUser(user),
    store: req.store
      ? {
        slug: req.store.slug,
        name: req.store.name,
        // The client uses this to send the owner straight to the activation
        // screen instead of into an app that cannot load yet.
        status: req.store.status,
        active: storeIsActive(req.store),
      }
      : null,
    ...(req.store && !storeIsActive(req.store)
      ? { activationRequired: true, contactEmail: contactEmail() }
      : {}),
  });
});

router.post('/logout', requireAuth, (req, res) => {
  revokeToken(req.auth);
  touch();
  log(EVENTS.LOGOUT, req, {});
  res.json({ ok: true });
});

router.post('/reauth', requireAuth, reauthLimit, async (req, res) => {
  const password = req.body && typeof req.body === 'object' ? req.body.password : null;
  const user = req.user;
  const username = String(user.username || '').toLowerCase();
  const ip = requestIp(req);
  const locked = activeLock(username, ip);
  if (locked) {
    const retryAfterSeconds = Math.max(1, Math.ceil((new Date(locked.blockedUntil).getTime() - Date.now()) / 1000));
    return res.status(429).json({ message: 'Verification temporarily locked for this account and IP', retryAfterSeconds });
  }
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user.passwordHash || !ok) {
    const entry = recordLoginFailure(username, ip);
    const retryAfterSeconds = Math.max(0, Math.ceil((new Date(entry.blockedUntil || 0).getTime() - Date.now()) / 1000));
    log(EVENTS.LOGIN_FAIL, req, { reauth: true, ip, retryAfter: retryAfterSeconds });
    if (retryAfterSeconds > 0) return res.status(429).json({ message: 'Verification temporarily locked for this account and IP', retryAfterSeconds });
    return res.status(401).json({ detail: user.passwordHash ? 'Password is not correct' : 'Password not set for this account' });
  }
  clearLoginLock(username, ip);
  log(EVENTS.LOGIN, req, { reauth: true, ip });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.get('/locks', requireAuth, requireRole('admin'), (req, res) => {
  const locks = coll('securityLocks').slice().sort((a, b) => (b.blockedUntil || '').localeCompare(a.blockedUntil || '')).map(lockDto);
  res.json({ locks, policy: lockPolicy() });
});

router.delete('/locks/:id', requireAuth, requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const entry = coll('securityLocks').find((candidate) => Number(candidate.id) === id);
  if (!entry) return res.status(404).json({ detail: 'Lock not found' });
  transaction(() => {
    const list = coll('securityLocks');
    const index = list.findIndex((candidate) => Number(candidate.id) === id);
    if (index >= 0) list.splice(index, 1);
  });
  log(EVENTS.LOGIN_UNLOCK, req, { username: entry.username, ip: entry.ip });
  res.json({ ok: true });
});

router.put('/language', requireAuth, (req, res) => {
  req.user.language = req.body && req.body.language === 'en' ? 'en' : 'th';
  touch();
  res.json({ user: publicUser(req.user) });
});

module.exports = router;
