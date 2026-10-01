const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { getSecret } = require('./secret');
const { coll, revokePlatformJti } = require('./db');

function signToken(user, store) {
  return jwt.sign({
    id: Number(user.id),
    username: user.username,
    role: user.role,
    authVersion: Number(user.authVersion) || 1,
    store: store ? Number(store.id) : null,
    slug: store ? store.slug : null,
    scope: 'store',
    jti: crypto.randomUUID(),
  }, getSecret(), { expiresIn: process.env.POS_TOKEN_TTL || '12h' });
}

// Platform staff tokens are a different audience: they must never be accepted
// by a store API, and a store token must never open the platform console.
function signPlatformToken(user) {
  return jwt.sign({
    id: Number(user.id),
    username: user.username,
    role: 'platform_admin',
    authVersion: Number(user.authVersion) || 1,
    store: null,
    scope: 'platform',
    jti: crypto.randomUUID(),
  }, getSecret(), { expiresIn: process.env.POS_TOKEN_TTL || '12h' });
}

function verifyToken(token) {
  const payload = jwt.verify(token, getSecret());
  if (!payload || typeof payload !== 'object') throw new Error('Invalid token');
  return payload;
}

function tokenFromRequest(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    hasPin: Boolean(user.pinHash || user.pin),
    cashierId: user.cashierId ?? null,
    language: user.language || 'th',
    active: user.active,
    createdAt: user.createdAt,
  };
}

function revokeToken(payload) {
  if (!payload || !payload.jti) return;
  const list = coll('revokedTokens');
  const expiresAt = payload.exp ? Number(payload.exp) * 1000 : (Date.now() + 7 * 24 * 60 * 60 * 1000);
  if (!list.some((entry) => entry.jti === payload.jti)) list.push({ jti: payload.jti, expiresAt });
}

// Platform sessions are few, so their revocations live at the top level next to
// the accounts they belong to.
function revokePlatformToken(payload) {
  if (!payload || !payload.jti) return;
  const expiresAt = payload.exp ? Number(payload.exp) * 1000 : (Date.now() + 7 * 24 * 60 * 60 * 1000);
  revokePlatformJti(payload.jti, expiresAt);
}

function requireAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ detail: 'Not authenticated' });
  try {
    const payload = verifyToken(token);
    if (payload.scope && payload.scope !== 'store') return res.status(401).json({ detail: 'Invalid or expired token' });
    // A token is bound to the store it was issued for. Someone cannot replay a
    // valid token from one shop against another shop's API.
    if (req.store && payload.store != null && Number(payload.store) !== Number(req.store.id)) {
      return res.status(401).json({ detail: 'Invalid or expired token' });
    }
    const user = coll('users').find((candidate) => Number(candidate.id) === Number(payload.id));
    if (!user || !user.active || Number(payload.authVersion) !== Number(user.authVersion || 1)) {
      return res.status(401).json({ detail: 'Invalid or expired token' });
    }
    if (payload.jti && coll('revokedTokens').some((entry) => entry.jti === payload.jti && Number(entry.expiresAt) > Date.now())) {
      return res.status(401).json({ detail: 'Invalid or expired token' });
    }
    req.user = user;
    req.auth = payload;
    req.token = token;
    next();
  } catch (e) {
    return res.status(401).json({ detail: 'Invalid or expired token' });
  }
}

function platformTokenRevoked(jti) {
  return coll('revokedPlatformTokens').some((entry) => entry.jti === jti && Number(entry.expiresAt) > Date.now());
}

function requirePlatformAuth(req, res, next) {
  const token = tokenFromRequest(req);
  if (!token) return res.status(401).json({ detail: 'Not authenticated' });
  try {
    const payload = verifyToken(token);
    if (payload.scope !== 'platform') return res.status(403).json({ detail: 'Platform access only' });
    if (payload.jti && platformTokenRevoked(payload.jti)) {
      return res.status(401).json({ detail: 'Invalid or expired token' });
    }
    const user = coll('platformAdmins').find((candidate) => Number(candidate.id) === Number(payload.id));
    if (!user || !user.active || Number(payload.authVersion) !== Number(user.authVersion || 1)) {
      return res.status(401).json({ detail: 'Invalid or expired token' });
    }
    req.platformUser = user;
    req.auth = payload;
    req.token = token;
    next();
  } catch (e) {
    return res.status(401).json({ detail: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ detail: 'Not authenticated' });
    if (!roles.includes(req.user.role)) return res.status(403).json({ detail: 'Forbidden' });
    next();
  };
}

function bumpAuthVersion(user) {
  user.authVersion = (Number(user.authVersion) || 1) + 1;
}

module.exports = {
  signToken, signPlatformToken, verifyToken, tokenFromRequest, publicUser, revokeToken,
  revokePlatformToken, requireAuth, requirePlatformAuth, requireRole, bumpAuthVersion,
};
