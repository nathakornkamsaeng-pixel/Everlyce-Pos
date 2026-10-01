// In-process rate limiting.
//
// nginx already rate limits, and that is the right first line. This is the
// backstop for when nginx is not in the path: a second proxy, a tunnel, a
// direct call to the app, or the self-hosted single-container setup where the
// app is the only thing listening. Relying on nginx alone means the limit
// silently disappears in exactly the deployments nobody tests.
//
// Per-process and in-memory, so a limit is per instance rather than global.
// That is a deliberate trade: it is a floor, not a ceiling, and it is the only
// thing available without adding shared state. Raise these with nginx in front
// rather than treating them as the primary defence.

const buckets = new Map();

// Cheap periodic sweep so a long-running process does not accumulate an entry
// per IP forever, which is itself a slow memory leak and a slow DoS.
const SWEEP = setInterval(() => {
  const nowMs = Date.now();
  for (const [key, bucket] of buckets) {
    if (nowMs - bucket.start > bucket.windowMs * 4) buckets.delete(key);
  }
}, 60 * 1000);
if (SWEEP.unref) SWEEP.unref();

function rateLimit({ limit, windowMs = 60 * 1000, key, message = 'Too many requests', code = 'rate_limited' } = {}) {
  if (!limit) throw new Error('rateLimit needs a limit');
  return (req, res, next) => {
    const id = key ? key(req) : clientIp(req);
    const nowMs = Date.now();
    let bucket = buckets.get(id);
    if (!bucket || nowMs - bucket.start >= windowMs) {
      bucket = { start: nowMs, count: 0, windowMs };
      buckets.set(id, bucket);
      if (buckets.size > 20000) buckets.clear();
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((bucket.start + windowMs - nowMs) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ detail: message, code, retryAfter });
    }
    return next();
  };
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  if (forwarded) return forwarded.split(',')[0].trim();
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown');
}

// Sign-in is the one worth being strict about: it is the only endpoint where
// guessing is worth doing, and bcrypt is slow enough to be a DoS on its own.
const LIMITS = {
  login: rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, message: 'Too many sign-in attempts. Try again later.', code: 'login_rate_limited' }),
  platformLogin: rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, message: 'Too many sign-in attempts. Try again later.', code: 'login_rate_limited' }),
  register: rateLimit({ limit: 5, windowMs: 60 * 60 * 1000, message: 'Too many sign-up attempts from this address.', code: 'register_rate_limited' }),
  activate: rateLimit({ limit: 15, windowMs: 60 * 60 * 1000, message: 'Too many activation attempts. Try again later.', code: 'activate_rate_limited' }),
  publicOrder: rateLimit({ limit: 30, windowMs: 60 * 1000, message: 'Too many orders from this device; ask staff for help', code: 'order_rate_limited' }),
  reauth: rateLimit({ limit: 10, windowMs: 15 * 60 * 1000, message: 'Too many attempts. Try again later.', code: 'reauth_rate_limited' }),
};

module.exports = { rateLimit, clientIp, LIMITS };
