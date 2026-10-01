const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const {
  coll, nextId, now, transaction, storeList, findStoreBySlug, findStoreById,
  createStore, updateStore, publicStore, slugify, slugAvailable, bucketFor, removeStore,
  PLANS, STORE_STATUS, withStore, contactEmail, lineOpenChatUrl, platformSettings,
  updatePlatformSettings,
} = require('../db');
const { log, EVENTS } = require('../activityLog');
const { signPlatformToken, requirePlatformAuth, revokePlatformToken } = require('../middleware');
const { isSelfHost, publicConfig } = require('../storeMiddleware');
const { trialLive, trialExpired, trialDaysLeft } = require('../trial');

const router = express.Router();


// ---------------------------------------------------------------- activation

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const KEY_PREFIX = 'ACPR';

function generateKey() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) out += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return `${KEY_PREFIX}-${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

function normalizeKey(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function hashKey(value) {
  return crypto.createHash('sha256').update(normalizeKey(value)).digest('hex');
}

function keyHint(value) {
  return normalizeKey(value).slice(-4);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// Application-level backstop for the public write endpoints. nginx limits
// bursts per IP; this keeps a slow drip from creating hundreds of stores.
const publicHits = new Map();
// Overridable for the suites, which register more shops in a minute than a
// person ever would, and would otherwise spend their whole run being told to
// slow down by the very limiter they are testing around. Same reasoning as
// POS_RATE_LOGIN_PER_IP on the sign-in side.
const PUBLIC_LIMIT = Math.max(1, Number(process.env.POS_RATE_PUBLIC_LIMIT || 8));
const PUBLIC_WINDOW_MS = 15 * 60 * 1000;

function throttlePublic(req, res, next) {
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const key = `${ip}|${req.path}`;
  const nowMs = Date.now();
  const entry = publicHits.get(key);
  if (!entry || nowMs - entry.first > PUBLIC_WINDOW_MS) {
    publicHits.set(key, { first: nowMs, count: 1 });
    return next();
  }
  entry.count += 1;
  if (publicHits.size > 5000) {
    for (const [candidate, value] of publicHits) {
      if (nowMs - value.first > PUBLIC_WINDOW_MS) publicHits.delete(candidate);
    }
  }
  if (entry.count > PUBLIC_LIMIT) {
    return res.status(429).json({ detail: `Too many attempts. Please contact ${contactEmail()}.` });
  }
  return next();
}

// ------------------------------------------------------------- first run

// A fresh self-hosted install has exactly one job before anything else: name the
// shop and make an owner to sign in as. There is no trial to start, no key to
// wait for, and no other shop to register for, so the whole "register a store"
// concept from the hosted version has nothing left to do here.
//
// Two properties this endpoint has to keep:
//
//   No email, deliberately. A self-hosted shop is on its own server and the
//   operator is sitting at the keyboard, so an emailed code would prove nothing
//   they have not already proven, and requiring one would make a self-hosting
//   install refuse to start unless someone set up an SMTP relay first. The
//   hosted build verifies the address for a real reason -- it hands out a free
//   trial to strangers -- and that reason does not exist here.
//
//   One shot, and then nothing. Once a store exists this route is gone, so it
//   cannot be used to add shops to a single-store install. That is what the
//   isSelfHost() check below is for, and it is the same rule the create endpoint
//   enforces from the other direction.
router.post('/setup', throttlePublic, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (!isSelfHost()) {
    return res.status(404).json({ detail: 'Not found' });
  }
  // Once a shop exists there is nothing left to set up, and leaving this open
  // would make it a second way to create a store behind the single-store rule.
  const name = String(body.storeName || body.name || '').trim();
  const ownerName = String(body.contactName || body.name || '').trim();
  const username = String(body.username || '').trim();
  const password = String(body.password || '');

  if (name.length < 2 || name.length > 120) {
    return res.status(400).json({ detail: 'Please enter your shop name' });
  }
  if (!ownerName) return res.status(400).json({ detail: 'Please enter a name for the owner' });
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return res.status(400).json({ detail: 'Username must be 3-32 characters (letters, numbers, dot, dash or underscore)' });
  }
  if (password.length < 12 || password.length > 200) {
    return res.status(400).json({ detail: 'Password must be at least 12 characters' });
  }

  const slug = slugify(body.storeId || body.slug || name);
  if (slug.length < 2) return res.status(400).json({ detail: 'Please enter a shop ID for the web address' });
  if (!slugAvailable(slug)) {
    return res.status(409).json({
      detail: `The shop ID "${slug}" is already taken. Please choose another one.`,
      suggested: suggestSlug(name),
    });
  }

  // Last, after every field has been checked. A person who typed a short password
  // needs to be told that, and answering "already set up" instead would send them
  // looking for a second shop that does not exist.
  if (storeList().length >= 1) {
    return res.status(409).json({
      detail: 'This install is already set up. Sign in with the owner account instead.',
      code: 'already_setup',
    });
  }

  // Hashed before the transaction opens, never inside it: a transaction's persist
  // fires the moment its mutator returns, so an await inside one commits an empty
  // document and swallows any later failure with no rollback.
  const passwordHash = await bcrypt.hash(password, 10);

  let outcome;
  try {
    outcome = transaction(() => {
      // Re-checked inside the transaction. Checked outside as well, and the check
      // inside is the one that counts: two requests arriving together would both
      // pass an outside check and both get a shop, which is the exact thing the
      // single-store rule exists to prevent.
      if (storeList().length >= 1) {
        return { raced: true };
      }
      const store = createStore({
        name,
        slug,
        // No contact details collected, so nothing here and no privacy notice has
        // to carry an address this install never asked for.
        contactName: ownerName,
        source: 'self-hosted-setup',
      });
      const owner = insertOwner(store, username, passwordHash, ownerName);
      // Live immediately. A self-hosted install has no trial to count down and
      // nobody to issue a key, so the waiting state is pure friction.
      const live = findStoreById(store.id);
      live.status = STORE_STATUS.ACTIVE;
      live.activatedAt = now();
      live.trialEndsAt = null;
      live.onTrial = false;
      return { slug: store.slug, name: store.name, username: owner.username };
    });
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ detail: e.message });
    throw e;
  }

  if (outcome.raced) {
    return res.status(409).json({
      detail: 'This install was just set up. Sign in with the owner account instead.',
      code: 'already_setup',
    });
  }

  log(EVENTS.STORE_CREATED, { user: null }, {
    store: outcome.slug, name: outcome.name, plan: 'enterprise', active: true, via: 'self-host-setup',
  });

  // The first store on the install is also its platform operator, so there is
  // exactly one set of credentials to manage and nothing to reconcile.
  const hasAdmin = coll('platformAdmins').some((admin) => admin.active);
  if (!hasAdmin) {
    transaction(() => {
      coll('platformAdmins').push({
        id: nextId('platformAdmins'),
        username,
        name: 'Platform Admin',
        role: 'platform_admin',
        passwordHash,
        active: true,
        authVersion: 1,
        createdAt: now(),
      });
    });
  }

  res.set('Cache-Control', 'no-store');
  return res.status(201).json({
    store: publicStore(findStoreBySlug(outcome.slug)),
    owner: { username: outcome.username },
    // The shop is at the root of the host, so signing in is /login. The prefixed
    // form still resolves, but it is not the address anyone should be given.
    signInPath: '/login',
    message: `"${outcome.name}" is ready at /${outcome.slug}. Sign in as ${outcome.username}.`,
  });
});

// ----------------------------------------------- single-store mode gate

// A self-hosted install has one shop, so the platform console has nothing to
// manage: it can list one store, delete that one store, mint keys nobody will
// redeem, and read every contact field in the file. Under the flag the whole
// console is switched off, because "one shop" that can be deleted from a web page
// is one shop only until somebody finds the URL.
//
// Two endpoints are deliberately exempt, and neither is a way to change anything:
//
//   GET /config         the landing page reads it for the contact address and to
//                       learn whether sign-up is open. Without it the public page
//                       cannot render.
//   GET /store/:slug    the same page asking whether a shop is live.
//
// Both are already read-only and unauthenticated, and both already answer the
// public half of a two-sided fact rather than anything private. Everything that
// mutates, or that reads across stores, is closed.
function platformUnavailable(req, res, next) {
  if (!isSelfHost()) return next();
  const path = req.path;
  // Matched on the real path, not on the route pattern. req.path is what the
  // client actually asked for, so a set containing '/store/:slug' would never
  // match the request '/store/siamkitchen' and the one endpoint that has to stay
  // open would 404 along with everything else.
  // Matched on the method too, because the public config is a GET and the same
  // path is also the platform settings PATCH. Letting the path through
  // unconditionally would leave the writable half of it open, which is the one
  // route on this list that edits the document.
  if (req.method === 'GET' && path === '/config') return next();
  if (req.method === 'GET' && path.startsWith('/store/')) return next();
  // Signing in and out have to keep working. The console is not useful, but an
  // operator who cannot authenticate to it sees a 404 on every request and has no
  // way to tell that from a routing mistake. Leaving sign-in open costs nothing:
  // the token it returns opens nothing else, because every route past here is
  // closed.
  if (path === '/login' || path === '/me' || path === '/logout') return next();
  return res.status(404).json({ detail: 'Not found' });
}

router.use(platformUnavailable);

// ------------------------------------------------------------------ activate

function suggestSlug(name) {
  const base = slugify(name) || 'store';
  for (let i = 2; i < 50; i += 1) {
    const candidate = `${base}-${i}`;
    if (slugAvailable(candidate)) return candidate;
  }
  return `${base}-${crypto.randomInt(100, 999)}`;
}

function clientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

// Lets the waiting screen show real state without exposing anything sensitive.
router.get('/store/:slug', (req, res) => {
  const store = findStoreBySlug(req.params.slug);
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  res.set('Cache-Control', 'no-store');
  res.json({ store: publicStore(store), contactEmail: contactEmail(), lineOpenChatUrl: lineOpenChatUrl() });
});

// ------------------------------------------------------------------ activate

// Gives a brand-new store its first owner account.
//
// Synchronous, with the hash already computed, and deliberately not opening a
// transaction of its own. The caller is always mid-transaction when it needs
// this -- a store and its owner either both exist or neither does -- and a
// nested commit here would break that: repo's transaction returns early when one
// is already open, so this would quietly do nothing and the owner would be lost
// on rollback. Hashing outside is the caller's job because bcrypt is async and
// an await inside a mutator persists before it resolves.
function insertOwner(store, username, passwordHash, ownerName) {
  return withStore(store, () => {
    if (coll('users').some((candidate) => String(candidate.username).toLowerCase() === String(username).toLowerCase())) {
      throw Object.assign(new Error('That username is already used in this store'), { status: 409 });
    }
    const created = {
      id: nextId('users'),
      username: String(username),
      name: String(ownerName || username).slice(0, 120),
      role: 'admin',
      pinHash: null,
      cashierId: null,
      passwordHash,
      active: true,
      authVersion: 1,
      createdAt: now(),
    };
    coll('users').push(created);
    return created;
  });
}

// Creates the owner account and switches the store to active. Shared by the
// key flow and the self-hosted flow, which differ only in whether a key was
// checked first. `key` is null when no key applies.
// markTrial is set when the store activated itself on the free trial rather
// than with a paid key. The distinction is the whole mechanism: a paid
// activation clears the trial so the expiry sweep can never pause a paying
// shop, and a trial activation leaves the deadline in place.
// Creates the owner account and switches the store to active. Shared by the
// key flow and the self-hosted flow, which differ only in whether a key was
// checked first. `key` is null when no key applies.
// markTrial is set when the store activated itself on the free trial rather
// than with a paid key. The distinction is the whole mechanism: a paid
// activation clears the trial so the expiry sweep can never pause a paying
// shop, and a trial activation leaves the deadline in place.
async function activateStore(store, body, key, req, { markTrial = false, converting = false } = {}) {
  const username = String(body.username || body.adminUsername || '').trim();
  const password = String(body.password || '');
  const ownerName = String(body.ownerName || body.name || '').trim() || username;

  // Converting is a plan change on a shop that is already trading: nobody is
  // signing up, so the account and its password are not touched at all.
  if (converting) {
    const result = withStore(store, () => transaction(() => {
      const live = findStoreById(store.id);
      live.trialEndsAt = null;
      live.onTrial = false;
      live.suspensionReason = null;
      live.suspendedAt = null;
      if (live.status === STORE_STATUS.SUSPENDED) live.status = STORE_STATUS.ACTIVE;
      live.keyUsedAt = now();
      live.keyUsedBy = username || 'platform';
      live.keyHash = null;
      if (body.plan && PLANS[body.plan]) live.plan = body.plan;
      if (body.planMonths !== undefined) live.planMonths = Math.max(0, Number(body.planMonths) || 0);
      return { store: publicStore(findStoreById(store.id)), username: username || 'owner' };
    }));
    const live = findStoreById(store.id);
    log(EVENTS.STORE_ACTIVATED, { user: { username } }, {
      store: live.slug, plan: live.plan, key: 'used', convertedFromTrial: true,
    });
    return {
      store: publicStore(live),
      username: result.username,
      message: `/${live.slug} is now on a paid plan. Your trial has ended and your data is unchanged.`,
    };
  }
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    return { error: { status: 400, detail: 'Username must be 3-32 characters (letters, numbers, dot, dash or underscore)' } };
  }
  if (password.length < 12 || password.length > 200) {
    return { error: { status: 400, detail: 'Password must be at least 12 characters' } };
  }


  const passwordHash = await bcrypt.hash(password, 10);

  // The owner normally already exists, because they signed up before
  // activating. Re-using that account is the point: activation is about the
  // key, not about making another account. Their password is left untouched.
  const existingOwner = withStore(store, () => coll('users')
    .find((candidate) => String(candidate.username).toLowerCase() === username.toLowerCase()) || null);

  if (existingOwner) {
    // Confirms it is really that person, and not just a guess at a username.
    const samePassword = await bcrypt.compare(password, existingOwner.passwordHash || '');
    if (!samePassword) {
      return { error: { status: 401, detail: 'That account already exists with a different password' } };
    }
    if (!existingOwner.active) {
      return { error: { status: 403, detail: 'That account is disabled' } };
    }
    const opened = withStore(store, () => transaction(() => {
      const liveExisting = findStoreById(store.id);
      liveExisting.status = STORE_STATUS.ACTIVE;
      liveExisting.activatedAt = now();
      liveExisting.keyUsedAt = key ? now() : liveExisting.keyUsedAt;
      liveExisting.keyUsedBy = username;
      liveExisting.keyHash = null;
      // A paid key ends the trial for good; a trial activation keeps it.
      if (key) {
        liveExisting.trialEndsAt = null;
        liveExisting.onTrial = false;
      } else if (markTrial) {
        liveExisting.onTrial = true;
      }
      liveExisting.suspensionReason = null;
      liveExisting.suspendedAt = null;
      if (!bucketFor(liveExisting.id).settings.restaurantName) {
        bucketFor(liveExisting.id).settings.restaurantName = liveExisting.name;
      }
      return existingOwner;
    }));
    const liveStore = findStoreById(store.id);
    log(EVENTS.STORE_ACTIVATED, { user: { username } }, { store: liveStore.slug, plan: liveStore.plan, key: key ? 'used' : 'self-host', existing: 'yes' });
    return {
      store: publicStore(liveStore),
      username: opened.username,
      message: `/${liveStore.slug} is now active. Sign in with ${opened.username}.`,
    };
  }

  let user;
  try {
    user = withStore(store, () => transaction(() => {
      const created = {
        id: nextId('users'),
        username,
        name: ownerName.slice(0, 120),
        role: 'admin',
        pinHash: null,
        cashierId: null,
        passwordHash,
        active: true,
        authVersion: 1,
        createdAt: now(),
      };
      coll('users').push(created);
      const live = findStoreById(store.id);
      live.status = STORE_STATUS.ACTIVE;
      live.activatedAt = now();
      live.keyUsedAt = key ? now() : live.keyUsedAt;
      live.keyUsedBy = username;
      live.keyHash = null; // strictly single use
      if (key) {
        live.trialEndsAt = null;
        live.onTrial = false;
      } else if (markTrial) {
        live.onTrial = true;
      }
      live.suspensionReason = null;
      live.suspendedAt = null;
      if (!bucketFor(live.id).settings.restaurantName) bucketFor(live.id).settings.restaurantName = live.name;
      return created;
    }));
  } catch (e) {
    if (e && e.status) return { error: { status: e.status, detail: e.message } };
    throw e;
  }

  // The transaction replaced the in-memory state, so the pre-activation object
  // is stale: read the store back for an honest response.
  const activated = findStoreById(store.id);
  log(EVENTS.STORE_ACTIVATED, { user: { username } }, { store: activated.slug, plan: activated.plan, key: key ? 'used' : 'self-host' });
  return {
    store: publicStore(activated),
    username: user.username,
    message: `/${activated.slug} is now active. Sign in with ${user.username}.`,
  };
}

router.post('/activate', throttlePublic, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const store = findStoreBySlug(String(body.store || body.storeId || body.slug || ''));
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  if (store.status === STORE_STATUS.ACTIVE) {
    // Already running on the trial and now paying. Verify the key and lift the
    // trial rather than telling a paying customer they are already active.
    const paidKey = normalizeKey(body.key || body.activationKey);
    if (paidKey && store.keyHash && !store.keyUsedAt && !store.keyRevokedAt
      && (!store.keyExpiresAt || new Date(store.keyExpiresAt).getTime() > Date.now())
      && safeEqual(store.keyHash, hashKey(paidKey))) {
      const converted = await activateStore(store, body, paidKey, req, { converting: true });
      if (converted.error) return res.status(converted.error.status).json({ detail: converted.error.detail });
      return res.json({ ...converted, convertedFromTrial: true });
    }
    return res.status(409).json({ detail: 'This store is already active. Please sign in.' });
  }
  if (store.status === STORE_STATUS.SUSPENDED) {
    if (store.suspensionReason === 'trial_expired') {
      return res.status(402).json({
        detail: `The free trial for /${store.slug} has ended and the store is paused. Your data is safe. Please contact ${contactEmail()} to continue.`,
        code: 'trial_expired',
      });
    }
    return res.status(403).json({ detail: `This store is suspended. Please contact ${contactEmail()}.` });
  }

  const key = normalizeKey(body.key || body.activationKey);

  // Inside the trial the shop activates itself. Waiting for someone to issue a
  // key is the opposite of a trial: it is a queue. After the week is up the key
  // is required again, which is the whole point of the deadline.
  if (!key && trialLive(store)) {
    const started = await activateStore(store, body, null, req, { onTrial: true });
    if (started.error) return res.status(started.error.status).json({ detail: started.error.detail });
    log(EVENTS.STORE_TRIAL_ACTIVATED, req, { store: store.slug, trialEndsAt: store.trialEndsAt });
    return res.json({ ...started, trial: true, trialEndsAt: store.trialEndsAt });
  }
  if (!key && trialExpired(store)) {
    return res.status(402).json({
      detail: `The 7 day trial for /${store.slug} has ended. Please contact ${contactEmail()} to continue.`,
      code: 'trial_expired',
    });
  }

  // A self-hosted install has nobody to issue keys, so the key step is skipped
  // and activation only creates the owner account.
  if (isSelfHost() && !key) {
    const done = await activateStore(store, body, null, req);
    if (done.error) return res.status(done.error.status).json({ detail: done.error.detail });
    return res.json(done);
  }
  if (!key || !store.keyHash) {
    return res.status(400).json({ detail: `An activation key is required. Please contact ${contactEmail()} to get one.` });
  }
  if (store.keyRevokedAt) return res.status(403).json({ detail: `That key was cancelled. Please contact ${contactEmail()}.` });
  if (store.keyUsedAt) return res.status(400).json({ detail: 'That key has already been used.' });
  if (store.keyExpiresAt && new Date(store.keyExpiresAt).getTime() <= Date.now()) {
    return res.status(410).json({ detail: `That key has expired. Please contact ${contactEmail()} for a new one.` });
  }
  if (!safeEqual(store.keyHash, hashKey(key))) {
    log(EVENTS.STORE_ACTIVATE_FAIL, { user: null }, { store: store.slug, ip: clientIp(req) });
    return res.status(403).json({ detail: 'That activation key is not valid for this store.' });
  }

  const done = await activateStore(store, body, key, req);
  if (done.error) return res.status(done.error.status).json({ detail: done.error.detail });
  return res.json(done);
});

// -------------------------------------------------------------- staff login

function platformPublicUser(user) {
  return { id: user.id, username: user.username, name: user.name, role: user.role, active: user.active };
}

router.post('/login', throttlePublic, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) return res.status(400).json({ detail: 'Username and password are required' });
  const user = coll('platformAdmins').find((candidate) => String(candidate.username).toLowerCase() === username.toLowerCase());
  const ok = user && user.active && user.passwordHash && await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    log(EVENTS.LOGIN_FAIL, { user: null }, { scope: 'platform', ip: clientIp(req) });
    return res.status(401).json({ detail: 'Invalid username or password' });
  }
  const token = signPlatformToken(user);
  log(EVENTS.LOGIN, { user }, { scope: 'platform' });
  res.json({ token, user: platformPublicUser(user) });
});

router.get('/me', requirePlatformAuth, (req, res) => res.json({ user: platformPublicUser(req.platformUser) }));

// ------------------------------------------------- platform settings and login

// Public, so the sign-up and activation screens can show the right contact
// details without the visitor having an account.
router.get('/config', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(publicConfig());
});

// The shared privacy policy, read for editing.
//
// Deliberately not part of publicConfig(). That is served to the marketing page
// and to anyone who asks, and while the published notice is public, the draft
// being edited is not: a half-finished policy should not be readable by someone
// deciding whether to trust us.
// Every cookie agreement ever given or refused, and the ability to withdraw.
// Read only: a record that can be edited is not evidence of consent.
router.get('/consent/history', requirePlatformAuth, (req, res) => {
  res.json(require('../cookieConsent').history(Number(req.query.limit) || 200));
});

router.post('/consent/revoke-all', requirePlatformAuth, (req, res) => {
  const out = require('../cookieConsent').revokeAll();
  log(EVENTS.CONSENT_REVOKED, req, { scope: 'cookies', revoked: out.revoked });
  res.json(out);
});

router.get('/privacy', requirePlatformAuth, (req, res) => {
  res.json({ privacy: platformSettings().privacy });
});

router.patch('/config', requirePlatformAuth, (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (body.contactEmail !== undefined) {
    const value = String(body.contactEmail).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
      return res.status(400).json({ detail: 'That does not look like a valid email address' });
    }
  }
  let updated;
  try {
    updated = transaction(() => updatePlatformSettings(body));
  } catch (e) {
    if (e && e.status) return res.status(e.status).json({ detail: e.message });
    throw e;
  }
  log(EVENTS.SETTINGS_SAVE, req, { scope: 'platform', contactEmail: updated.contactEmail, line: Boolean(updated.lineOpenChatUrl) });
  res.json(publicConfig());
});

// Changing the password re-issues authVersion, which invalidates every other
// session for that account immediately. A password change that leaves old
// sessions alive is not much of a change.
router.post('/password', requirePlatformAuth, throttlePublic, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const current = String(body.currentPassword || '');
  const next = String(body.newPassword || '');
  if (!current) return res.status(400).json({ detail: 'Enter your current password' });
  if (next.length < 12 || next.length > 200) return res.status(400).json({ detail: 'The new password must be at least 12 characters' });
  if (next === current) return res.status(400).json({ detail: 'The new password must be different from the current one' });

  const admin = req.platformUser;
  if (!admin.passwordHash || !(await bcrypt.compare(current, admin.passwordHash))) {
    log(EVENTS.LOGIN_FAIL, req, { scope: 'platform', reason: 'password-change' });
    return res.status(401).json({ detail: 'That is not your current password' });
  }
  const passwordHash = await bcrypt.hash(next, 10);
  transaction(() => {
    const live = coll('platformAdmins').find((candidate) => Number(candidate.id) === Number(admin.id));
    if (!live) throw Object.assign(new Error('Account not found'), { status: 404 });
    live.passwordHash = passwordHash;
    live.authVersion = (Number(live.authVersion) || 1) + 1;
    live.passwordChangedAt = now();
  });
  // This session is signed with the old authVersion, so it ends too. The
  // operator has to sign in again with the new password.
  revokePlatformToken(req.auth);
  log(EVENTS.LOGOUT, req, { scope: 'platform', reason: 'password-changed' });
  res.json({ ok: true, message: 'Password changed. Please sign in again.' });
});

router.post('/logout', requirePlatformAuth, (req, res) => {
  const { revokePlatformToken } = require('../middleware');
  revokePlatformToken(req.auth);
  res.json({ ok: true });
});

// The admin creates a store by hand instead of waiting for a registration,
// and gets its key in the same step. Useful for a chain, and for the
// self-hosted single-store install where nobody registers at all.
router.post('/stores', requirePlatformAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = String(body.name || body.storeName || '').trim();
  if (name.length < 2) return res.status(400).json({ detail: 'Store name is required' });
  const slug = slugify(body.slug || body.storeId || name);
  if (slug.length < 2) return res.status(400).json({ detail: 'Store ID is required' });
  if (!slugAvailable(slug)) return res.status(409).json({ detail: 'That store ID is already taken' });
  const plan = PLANS[body.plan] ? body.plan : PLANS.enterprise.id;
  const activateNow = body.activate === true;

  // A self-hosted install is one shop by definition. Saying so plainly is
  // better than creating a second store that the single-store mode then
  // half-supports.
  if (isSelfHost() && storeList().length >= 1) {
    return res.status(409).json({
      detail: 'This install runs in single-store self-hosted mode and already has a store. Turn POS_SELF_HOST off to run several.',
      code: 'self_host_single_store',
    });
  }

  // An owner, if one was asked for. Without this an admin-created shop has no
  // account that can sign in to it, and the only other way to make one is the
  // one-shot setup form, which refuses once a shop exists.
  //
  // Validated before the shop is created rather than after. Creating first and
  // checking second leaves a shop behind whenever the check fails, which is the
  // worst possible outcome: an unusable shop occupying an address the operator
  // then has to delete by hand.
  const ownerUsername = String(body.username || body.ownerUsername || '').trim();
  const ownerPassword = String(body.password || '');
  const wantsOwner = Boolean(ownerUsername || ownerPassword);
  if (wantsOwner) {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(ownerUsername)) {
      return res.status(400).json({ detail: 'Owner username must be 3-32 characters (letters, numbers, dot, dash or underscore)' });
    }
    if (ownerPassword.length < 12 || ownerPassword.length > 200) {
      return res.status(400).json({ detail: 'Password must be at least 12 characters' });
    }
  }

  // Hashed before the transaction opens, never inside it: a transaction's persist
  // fires the moment its mutator returns, so an await inside one commits an empty
  // document and swallows any later failure with no rollback.
  const ownerHash = wantsOwner ? await bcrypt.hash(ownerPassword, 10) : null;

  let store;
  let owner = null;
  try {
    store = transaction(() => {
      // Re-checked inside the transaction. Checked outside as well, and the check
      // inside is the one that counts: two requests arriving together would both
      // pass an outside check and both get a shop, which is the exact thing the
      // single-store rule exists to prevent.
      if (isSelfHost() && storeList().length >= 1) {
        throw Object.assign(new Error('This install already has a store'), { status: 409, code: 'self_host_single_store' });
      }
      const created = createStore({
        name,
        slug,
        plan,
        planMonths: Math.max(0, Number(body.planMonths) || 0),
        contactName: body.contactName,
        contactEmail: body.contactEmail,
        contactPhone: body.contactPhone,
        note: body.note,
        source: 'created-by-admin',
      });

      // An admin-created store can skip the waiting step, which is what makes it
      // usable for a self-hosted install with no key workflow at all.
      if (activateNow) {
        const live = findStoreById(created.id);
        live.status = STORE_STATUS.ACTIVE;
        live.activatedAt = now();
        live.trialEndsAt = null;
        live.onTrial = false;
        live.note = [live.note, 'Activated on creation by platform admin.'].filter(Boolean).join(' ').slice(0, 500);
      }

      // Same transaction as the shop, so a store and its owner either both exist
      // or neither does.
      const madeOwner = wantsOwner
        ? insertOwner(created, ownerUsername, ownerHash, String(body.ownerName || body.contactName || ownerUsername))
        : null;
      return { store: created, owner: madeOwner };
    });
  } catch (e) {
    if (e && e.status) {
      return res.status(e.status).json({ detail: e.message, ...(e.code ? { code: e.code } : {}) });
    }
    throw e;
  }
  owner = store.owner;

  log(EVENTS.STORE_CREATED, req, { store: store.store.slug, name: store.store.name, plan, active: activateNow, owner: Boolean(owner) });
  res.status(201).json({
    store: publicStore(findStoreById(store.store.id)),
    owner: owner ? { username: owner.username } : null,
  });
});

// ------------------------------------------------------------- store admin

router.get('/stores', requirePlatformAuth, (req, res) => {
  const stores = storeList().map((store) => ({
    ...publicStore(store),
    contactName: store.contactName,
    contactEmail: store.contactEmail,
    contactPhone: store.contactPhone,
    note: store.note,
    source: store.source,
    hasKey: Boolean(store.keyHash),
    keyHint: store.keyHint || null,
    keyIssuedAt: store.keyIssuedAt,
    keyExpiresAt: store.keyExpiresAt,
    keyUsedAt: store.keyUsedAt,
    keyRevokedAt: store.keyRevokedAt,
    stats: withStore(store, () => ({
      users: coll('users').length,
      products: coll('products').length,
      orders: coll('orders').length,
    })),
  }));
  res.json({ stores, plans: Object.values(PLANS), ...publicConfig() });
});

/**
 * Issue an activation key for a store.
 *
 * Extracted so that fulfilling a plan request and issuing a key by hand are the
 * same act with the same rules. Leaving them as two implementations is how a
 * shop asked to upgrade to Professional ends up quietly activated on Starter.
 *
 * Returns { error } instead of writing a response, so the caller decides how the
 * refusal is delivered.
 */
function issueKeyFor(store, { plan, planMonths, expiresInDays } = {}) {
  if (!store) return { error: { status: 404, detail: 'Store not found' } };

  // A shop that activated on its free trial is already trading, and it is the
  // one shop that most needs a key: it is how paying ends the trial. Refusing
  // here left trial shops with no way to upgrade at all.
  const convertingTrial = store.status === STORE_STATUS.ACTIVE && trialLive(store);
  if (store.status === STORE_STATUS.ACTIVE && !convertingTrial) {
    return { error: { status: 409, detail: 'This store is already active' } };
  }
  if (store.status === STORE_STATUS.SUSPENDED && store.suspensionReason !== 'trial_expired') {
    // A shop whose trial ran out is the other one worth converting, and that
    // needs the resume first so the sweep stops touching it.
    return { error: { status: 409, detail: 'Suspend or resume this store before issuing a key' } };
  }

  const chosen = PLANS[plan] ? plan : store.plan;
  const months = Math.max(0, Number(planMonths) || 0);
  const days = Math.min(365, Math.max(1, Number(expiresInDays) || 30));
  const key = generateKey();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + days * 86400000).toISOString();

  transaction(() => {
    const live = findStoreById(store.id);
    live.plan = chosen;
    live.planMonths = months;
    live.keyHash = hashKey(key);
    live.keyHint = keyHint(key);
    live.keyIssuedAt = issuedAt.toISOString();
    live.keyExpiresAt = expiresAt;
    live.keyUsedAt = null;
    live.keyUsedBy = null;
    live.keyRevokedAt = null;
    // A shop that is already trading keeps its status. Dropping it to
    // awaiting_activation would lock a paying customer out of a working till
    // while they fill in a payment form, which is the opposite of converting
    // them. Only a shop that is not yet live waits for the key.
    if (!convertingTrial) live.status = STORE_STATUS.AWAITING_ACTIVATION;
  });

  return {
    key, keyHint: keyHint(key), plan: chosen, planMonths: months, expiresAt,
    convertingTrial, store: publicStore(findStoreById(store.id)),
  };
}

/**
 * Plan requests are per store, so finding one means finding its store first.
 * A request is a small thing to lose track of, and losing one means a customer
 * waits for a confirmation nobody is going to send.
 */
function findPlanRequest(id) {
  for (const store of storeList()) {
    const request = withStore(store, () => (coll('planRequests') || []).find((r) => Number(r.id) === Number(id)));
    if (request) return { store, request };
  }
  return null;
}

router.post('/stores/:id/key', requirePlatformAuth, (req, res) => {
  const store = findStoreById(req.params.id);
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const issued = issueKeyFor(store, { plan: body.plan, planMonths: body.planMonths, expiresInDays: body.expiresInDays });
  if (issued.error) return res.status(issued.error.status).json({ detail: issued.error.detail });

  log(EVENTS.STORE_KEY_ISSUED, req, {
    store: store.slug, plan: issued.plan, months: issued.planMonths, hint: issued.keyHint,
    convertingTrial: issued.convertingTrial,
  });
  res.json({
    store: issued.store,
    key: issued.key,
    keyHint: issued.keyHint,
    plan: issued.plan,
    planName: PLANS[issued.plan].name,
    planMonths: issued.planMonths,
    expiresAt: issued.expiresAt,
    warning: 'Shown once. Send it to the store owner: it activates the store on first use.',
  });
});

// Plan requests waiting to be turned into keys. A shop may ask; only the
// platform decides. Fulfilling one is the same act as issuing a key, so it goes
// through the same rules rather than having a second, looser path.
router.get('/plan-requests', requirePlatformAuth, (req, res) => {
  const all = [];
  for (const store of storeList()) {
    const requests = withStore(store, () => coll('planRequests') || []);
    for (const request of requests) all.push({ ...request, storeName: store.name, storeSlug: store.slug });
  }
  const pending = all.filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id);
  const settled = all.filter((r) => r.status !== 'pending').sort((a, b) => b.id - a.id).slice(0, 25);
  res.json({ pending, settled });
});

// Takes the decision out of a shop's hands: the request is what they asked for,
// this is whether it is agreed. Marked fulfilled in the same act as the key being
// issued, so a request cannot sit "confirmed" with nothing behind it.
router.post('/plan-requests/:id/fulfil', requirePlatformAuth, (req, res) => {
  const found = findPlanRequest(req.params.id);
  if (!found) return res.status(404).json({ detail: 'Plan request not found' });
  const { store, request } = found;
  if (request.status !== 'pending') return res.status(409).json({ detail: `This request is already ${request.status}` });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const months = Math.max(1, Number(body.planMonths) || request.planMonths || 12);
  const issued = issueKeyFor(store, { plan: request.plan, planMonths: months });
  if (issued.error) return res.status(issued.error.status).json({ detail: issued.error.detail });

  const settledAt = now();
  withStore(store, () => transaction(() => {
    const r = (coll('planRequests') || []).find((x) => Number(x.id) === Number(request.id));
    if (!r) return;
    r.status = 'fulfilled';
    r.fulfilledAt = settledAt;
    r.fulfilledPlan = request.plan;
    r.fulfilledMonths = months;
    r.fulfilledBy = req.platformUser.username;
  }));
  log(EVENTS.STORE_PLAN_REQUEST_FULFILLED, req, {
    store: store.slug, planRequest: request.id, plan: request.plan, change: request.change,
  });
  res.json({
    ok: true,
    key: issued.key,
    request: { ...request, status: 'fulfilled', fulfilledAt: settledAt, fulfilledPlan: request.plan, fulfilledMonths: months },
    warning: 'Shown once. Send this key to the store owner to activate the plan.',
  });
});

// Turning a request down needs no key, only a reason, so a shop is not left
// waiting on something nobody is going to do.
router.post('/plan-requests/:id/decline', requirePlatformAuth, (req, res) => {
  const found = findPlanRequest(req.params.id);
  if (!found) return res.status(404).json({ detail: 'Plan request not found' });
  const { store, request } = found;
  if (request.status !== 'pending') return res.status(409).json({ detail: `This request is already ${request.status}` });
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 300) || null;
  withStore(store, () => transaction(() => {
    const r = (coll('planRequests') || []).find((x) => Number(x.id) === Number(request.id));
    r.status = 'declined';
    r.declinedAt = now();
    r.declineReason = reason;
    r.declinedBy = req.platformUser.username;
  }));
  log(EVENTS.STORE_PLAN_REQUEST_WITHDRAWN, req, { store: store.slug, planRequestDeclined: request.id, reason });
  res.json({ ok: true });
});

router.post('/stores/:id/revoke-key', requirePlatformAuth, (req, res) => {
  const store = findStoreById(req.params.id);
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  transaction(() => {
    const live = findStoreById(store.id);
    live.keyHash = null;
    live.keyRevokedAt = now();
    if (live.status === STORE_STATUS.AWAITING_ACTIVATION) live.status = STORE_STATUS.PENDING;
  });
  log(EVENTS.STORE_KEY_REVOKED, req, { store: store.slug });
  res.json({ store: publicStore(findStoreById(store.id)) });
});

router.post('/stores/:id/status', requirePlatformAuth, (req, res) => {
  const store = findStoreById(req.params.id);
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requested = String(body.status || '');
  let status;
  if (requested === 'suspend') status = STORE_STATUS.SUSPENDED;
  else if (requested === 'resume') status = store.keyUsedAt ? STORE_STATUS.ACTIVE : STORE_STATUS.PENDING;
  else return res.status(400).json({ detail: 'Status must be suspend or resume' });

  const updated = transaction(() => updateStore(store.id, { status, suspendedAt: status === STORE_STATUS.SUSPENDED ? now() : null }));
  log(EVENTS.STORE_STATUS, req, { store: store.slug, status });
  res.json({ store: publicStore(updated) });
});

router.patch('/stores/:id', requirePlatformAuth, (req, res) => {
  const store = findStoreById(req.params.id);
  if (!store) return res.status(404).json({ detail: 'Store not found' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const patch = {};
  if (body.plan !== undefined) {
    if (!PLANS[body.plan]) return res.status(400).json({ detail: 'Unknown plan' });
    patch.plan = body.plan;
  }
  if (body.planMonths !== undefined) patch.planMonths = Math.max(0, Number(body.planMonths) || 0);
  for (const field of ['contactName', 'contactEmail', 'contactPhone', 'note']) {
    if (body[field] !== undefined) patch[field] = String(body[field] || '').trim() || null;
  }
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2) return res.status(400).json({ detail: 'Store name is too short' });
    patch.name = name;
  }
  if (body.slug !== undefined) {
    const slug = slugify(body.slug);
    if (slug.length < 2) return res.status(400).json({ detail: 'That store ID is not valid' });
    if (!slugAvailable(slug, store.id)) return res.status(409).json({ detail: 'That store ID is already taken' });
    patch.slug = slug;
  }
  const updated = transaction(() => updateStore(store.id, patch));
  log(EVENTS.STORE_UPDATED, req, { store: updated.slug, fields: Object.keys(patch).join(',') });
  res.json({ store: publicStore(updated) });
});

// Deleting a store is permanent and takes its orders with it, so it is only
// possible when the admin has seen the record count and confirmed it. A store
// is never removed by accident or by a mistyped URL.
router.delete('/stores/:id', requirePlatformAuth, (req, res) => {
  const store = findStoreById(req.params.id);
  if (!store) return res.status(404).json({ detail: 'Store not found' });

  const stats = withStore(store, () => ({
    users: coll('users').length,
    orders: coll('orders').length,
    products: coll('products').length,
    tables: coll('tables').length,
    branches: coll('branches').length,
  }));
  const isActive = store.status === STORE_STATUS.ACTIVE;

  // Suspending keeps the records. Deleting is for stores that should not exist.
  const wanted = String(req.query.action || (req.body && req.body.action) || '');
  if (wanted === 'suspend') {
    // One path for every status. A trial shop is switched on at registration, so
    // a sign-up worth refusing may well already be trading, and a rejection that
    // quietly skipped the audit entry for those would leave the one store you
    // most want to explain later with no explanation on it.
    const reason = String((req.query.reason || (req.body && req.body.reason) || '')).trim().slice(0, 300);
    const note = [
      store.note,
      'Registration rejected by platform admin.',
      reason ? `Reason: ${reason}` : '',
    ].filter(Boolean).join(' ').slice(0, 500);

    const updated = transaction(() => {
      const live = findStoreById(store.id);
      live.status = STORE_STATUS.SUSPENDED;
      live.suspendedAt = now();
      live.note = note;
      // The key is cleared so a key issued moments before a refusal cannot be
      // used to walk the shop back in.
      live.keyHash = null;
      return live;
    });
    log(EVENTS.STORE_REJECTED, req, {
      store: store.slug, name: store.name, email: store.contactEmail,
      wasActive: isActive, reason: reason || null,
    });
    return res.json({ ok: true, action: 'rejected', store: publicStore(updated) });
  }

  if (req.query.confirm !== store.slug) {
    return res.status(409).json({
      detail: `Deleting /${store.slug} is permanent. It will remove ${stats.orders} order(s), ${stats.products} product(s), ${stats.tables} table(s) and ${stats.users} account(s). Re-send with ?confirm=${store.slug} to go ahead.`,
      code: 'confirmation_required',
      store: publicStore(store),
      stats,
    });
  }

  const removed = transaction(() => removeStore(store.id));
  log(EVENTS.STORE_DELETED, req, { store: store.slug, name: store.name, ...stats });
  res.json({ ok: true, action: 'deleted', store: removed, stats });
});

// The platform's own pages: the home page and the privacy notice. Mounted here
// so it inherits the platform token check.
router.use('/content', require('./platformContent'));

module.exports = router;
