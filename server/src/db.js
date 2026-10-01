const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { runWithStore, currentStore, currentStoreId } = require('./storeContext');

// Persistence lives behind the storage adapter: db.js owns what the data
// means, the adapter owns how it reaches disk. Swapping the engine is then a
// config change rather than a rewrite of every route.
const storage = require('./storage').createAdapter();
const DATA_DIR = storage.dataDir;
const DATA_FILE = storage.dataFile;
const BACKUP_FILE = storage.backupFile;
const SCHEMA_VERSION = 3;

// The slug a fresh single-store install gets. Deployments that already have a
// store set POS_DEFAULT_STORE_SLUG so old links keep resolving to the right
// shop; set it to your own store's URL segment.
const DEFAULT_STORE_SLUG = String(process.env.POS_DEFAULT_STORE_SLUG || 'myrestaurant')
  .trim().toLowerCase();

// A cap of 0 means unlimited, which is what a self-hosted install wants.
// Priced on what actually costs money to serve, which is concurrency: one
// order at a time on a busy till burns CPU, and a shop's footprint is a couple
// of hundred kilobytes whether it serves ten orders a day or ten thousand.
//
// Measured on the host: the app sits at ~65MB of 3915MB. Almost every cost on
// the box belongs to something else. A store adds roughly 200KB of data. So
// products are not a meaningful cost axis and are not priced as one, and
// capping them low only blocks real shops: a large cafe runs 300 items without
// thinking about it, and the previous cap of 200 refused it.
//
// The limits below are abuse guards, not business levers. They are set above
// what any normal shop reaches, so a limit is only ever hit by a mistake.
//
//   starter       8 staff, 500 items, 1 branch
//   professional 20 staff, 2000 items, 4 branches
//   enterprise    uncapped
//
// At 390 + 990, six paying professional shops cover the 5500 monthly host cost
// with room for support. That is the arithmetic these numbers are chosen for.
const PLANS = {
  starter: {
    id: 'starter', name: 'Starter', maxUsers: 8, maxProducts: 500, maxBranches: 1, priceTHB: 390,
  },
  professional: {
    id: 'professional', name: 'Professional', maxUsers: 20, maxProducts: 2000, maxBranches: 4, priceTHB: 990,
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', maxUsers: 0, maxProducts: 0, maxBranches: 0, priceTHB: 0,
  },
};

const STORE_STATUS = {
  PENDING: 'pending',
  AWAITING_ACTIVATION: 'awaiting_activation',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
};

// A new store gets this long to try the product before it is paused. Seven days
// is long enough to take real orders with it, and short enough that nobody
// builds a business on a free trial by accident.
//
// Self-hosted installs are exempt: there is nobody to charge, so pausing a
// shop's own server after a week would be absurd.
const TRIAL_DAYS = Math.max(0, Number(process.env.POS_TRIAL_DAYS || 7));

function trialEndFrom(iso) {
  if (TRIAL_DAYS <= 0) return null;
  const from = iso ? new Date(iso).getTime() : Date.now();
  if (!Number.isFinite(from)) return null;
  return new Date(from + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function trialRemainingMs(store) {
  if (!store || !store.trialEndsAt) return null;
  const left = new Date(store.trialEndsAt).getTime() - Date.now();
  return Number.isFinite(left) ? left : null;
}

const DEFAULT_SETTINGS = {
  restaurantName: '',
  // Controller identity. Under the Personal Data Protection Act B.E. 2562 the
  // controller has to be identifiable and give a way to be contacted about
  // personal data, and a Thai tax invoice has to carry the legal entity name
  // and its tax identification number.
  legalName: process.env.POS_LEGAL_NAME || '',
  taxId: process.env.POS_TAX_ID || '',
  // Where data-subject requests go. Falls back to the platform contact when a
  // shop has not set its own.
  privacyContactEmail: process.env.POS_PRIVACY_CONTACT || '',
  // How long customer records are kept before they are purged. 0 means keep
  // until the customer asks us to delete them.
  personalDataRetentionDays: 365,
  privacyPolicyVersion: '1.0',
  taxRate: '7',
  serviceChargeRate: '10',
  currency: 'THB',
  customerLanguage: 'th',
  cdsLanguage: 'th',
  loginLockAttempts: 5,
  loginLockWindowMinutes: 15,
  loginLockBlockMinutes: 30,
  loginLockMaxHours: 24,
  promptPayAccount: '',
  promptPayAccountType: 'phone',
  // What the payer sees on their confirmation screen, and what reconciles the
  // payment back to the shop. Tag 62 of the Thai QR carries the reference; 59
  // and 60 carry the name and city.
  merchantName: '',
  merchantCity: '',
  merchantMcc: '',
  // Gateway keys for card payments. Stored per store and never returned by any
  // settings endpoint; the capabilities list reports only whether one is set.
  opnPublicKey: '',
  opnSecretKey: '',
  stripeSecretKey: '',
  stripePublishableKey: '',
  kdsOverdueMinutes: 15,
  draftEmptyMinutes: 5,
  draftStaleMinutes: 45,
  loyaltyEnabled: true,
  loyaltyPrompt: 'always',
  loyaltyPointsPerUnit: 1,
  loyaltyPointValue: 0,
  loyaltyMinRedeemPoints: 0,
  loyaltyRequirePhone: false,
  loyaltyAutoRegister: false,
  loyaltyAllowSkip: true,
  loyaltyMaxCoupons: 0,
  loyaltyAllowStacking: true,
  loyaltyTierGold: 200,
  loyaltyTierVip: 500,
};

const STORE_COLLECTIONS = [
  'users', 'tables', 'categories', 'products', 'modifierGroups', 'modifierOptions',
  'orders', 'orderItems', 'payments', 'promptPayRequests', 'refunds', 'discounts',
  'cashSessions', 'sessions', 'loyaltyMembers', 'loyaltyLedger',
  'planRequests', 'translations', 'printers', 'printJobs',
  'revokedTokens', 'securityLocks', 'stockMovements', 'branches', 'apiKeys',
];

// A single install can run more than one branch. Every branch belongs to a
// store, so two shops never share one, and the first branch is created with the
// store so existing installs have somewhere to put their tables.
const DEFAULT_BRANCH_NAME = 'Main';

// Collections that belong to the platform rather than to a single store.
//
// The platform's own pages are here: the wording on `/` and on the PDPA privacy
// notice, which every visitor and every customer reads and which belongs to
// whoever runs the platform rather than to any one shop.
//
// The app's buttons are deliberately NOT here. "Add to basket" and the rest are
// per shop: a shop that wants them worded differently changes its own store, and
// an install running its own server can do that without asking anyone.
const GLOBAL_COLLECTIONS = [
  'stores', 'platformAdmins', 'revokedPlatformTokens', 'platformSettings', 'platformContent',
  'cookieConsents',
];

// Globals that are plain arrays and so are copied across from disk verbatim by
// normalize(). Everything not listed here is either reshaped on load (stores,
// platformAdmins), merged over defaults (platformSettings) or handled by its own
// block (platformContent), and must not be overwritten by a blanket copy.
//
// This list rather than a hand-written block per collection, because one of them
// was missed once already: cookieConsents was in GLOBAL_COLLECTIONS and never
// given a block, so it was silently reset to [] on every load and the server came
// back up having forgotten that every visitor had already agreed. A collection
// missing from here is not inert, it is emptied, and the next persist writes the
// loss to disk. Anything added to GLOBAL_COLLECTIONS is now carried across
// automatically, so this cannot fall behind it.
const PLAIN_GLOBAL_ARRAYS = [
  'revokedPlatformTokens', 'cookieConsents',
];

function blankBucket(name) {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { ...DEFAULT_SETTINGS },
    users: [],
    branches: [],
    tables: [],
    categories: [],
    products: [],
    modifierGroups: [],
    modifierOptions: [],
    orders: [],
    orderItems: [],
    payments: [],
    promptPayRequests: [],
    planRequests: [],
    refunds: [],
    discounts: [],
    cashSessions: [],
    sessions: [],
    loyaltyMembers: [],
    loyaltyLedger: [],
    // The shop's own wording: the app buttons it can reword for itself, and its
    // menu, categories, modifiers and tables.
    translations: [],
    // The shop's own printers. Each shop decides what it has plugged in where;
    // nothing here is shared with another shop or with the platform.
    printers: [],
    printJobs: [],
    revokedTokens: [],
    securityLocks: [],
    apiKeys: [],
    stockMovements: [],
    nextIds: {},
  };
}

// Settings the platform owner can change without a redeploy. The env vars act
// as the fallback for a fresh install; once changed here they win.
// The shared privacy policy: the wording and the lawful bases every shop
// publishes, which are the same everywhere.
//
// Kept apart from a shop's own legal identity on purpose. A shop's legal name,
// tax ID and privacy address are that shop's facts and it has to supply them, and
// taking them away would leave it unable to issue a valid tax invoice or name
// itself as the controller. The policy itself is not the shop's to invent: it is
// the same document for everyone, so it is written once, here, by whoever runs
// the platform.
const DEFAULT_PLATFORM_SETTINGS = {
  contactEmail: process.env.POS_CONTACT_EMAIL || 'you@example.com',
  lineOpenChatUrl: process.env.POS_LINE_OPENCHAT_URL || '',
  privacy: {
    policyVersion: process.env.POS_PRIVACY_VERSION || '1.0',
    // Bump this and every existing cookie agreement stops matching, so consent
    // is asked for again. Changing the wording without bumping it would mean
    // people had agreed to something they never saw.
    consentVersion: process.env.POS_CONSENT_VERSION || '1.0',
    // Who is the controller.
    //
    // The site owner's, not the shop's. The person publishing this software
    // operates the service that collects the data, so the notice names them. A
    // shop on a self-hosted server is its own operator and supplies its own, so
    // the shop's legal name is used there instead.
    controllerLegalName: process.env.POS_CONTROLLER_LEGAL_NAME || '',
    controllerAddress: process.env.POS_CONTROLLER_ADDRESS || '',
    // A platform-level address for privacy questions, used when a shop has not
    // published one of its own.
    contactEmail: process.env.POS_PRIVACY_CONTACT_EMAIL || process.env.POS_CONTACT_EMAIL || 'you@example.com',
    // Free text shown as an extra paragraph under the rights list. This is where
    // anything specific about how the platform as a whole handles data goes,
    // rather than being edited into every shop in turn.
    operatorNotes: '',
    purposes: {
      loyalty: 'Loyalty points and member benefits',
      marketing: 'Promotions and offers',
      service: 'Service the account and answer requests',
    },
  },
};

function blankState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    stores: [],
    platformAdmins: [],
    revokedPlatformTokens: [],
    platformSettings: { ...DEFAULT_PLATFORM_SETTINGS },
    platformContent: [],
    cookieConsents: [],
    storeData: {},
    nextIds: {},
  };
}

// Set by normalize() when it had to fill something in, so load() knows the file
// on disk is behind memory. Stripped before the document is written.
function markNeedsPersist(result) {
  Object.defineProperty(result, 'needsPersist', { value: true, enumerable: false, writable: true });
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

let state = null;
const { createRepo, MissingStoreContextError } = require('./repo');

// The repository owns the document. The functions below are kept as delegations
// because sixteen route files and the middleware import them by name, and
// rewriting all of that at once would be a far larger change than the one that
// actually buys testability.
let repo = null;

function isGlobal(name) {
  return GLOBAL_COLLECTIONS.includes(name);
}

function storeList() {
  return repo ? repo.storeList() : state.stores;
}

function findStoreBySlug(slug) {
  return repo ? repo.findStoreBySlug(slug) : null;
}

function findStoreById(id) {
  return repo ? repo.findStoreById(id) : null;
}

function defaultStore() {
  return repo ? repo.defaultStore(DEFAULT_STORE_SLUG) : null;
}

function bucketFor(storeId) {
  const id = Number(storeId);
  // Store ids are positive integers. Anything else means a caller lost track of
  // which store it is working on, and quietly creating a bucket for it would
  // strand records where nothing can find them.
  if (!Number.isSafeInteger(id) || id < 1) {
    throw Object.assign(new Error(`Invalid store id: ${storeId}`), { status: 500 });
  }
  if (!state.storeData[String(id)]) state.storeData[String(id)] = blankBucket();
  return state.storeData[String(id)];
}

function normalizeBucket(raw, fallbackName) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid store data');
  const bucket = blankBucket();
  for (const name of STORE_COLLECTIONS) {
    const value = raw[name];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) throw new Error(`Invalid collection: ${name}`);
    bucket[name] = value;
  }
  if (raw.settings !== undefined && raw.settings !== null) {
    if (typeof raw.settings !== 'object' || Array.isArray(raw.settings)) throw new Error('Invalid settings');
    bucket.settings = { ...DEFAULT_SETTINGS, ...raw.settings };
  }
  if (fallbackName && !bucket.settings.restaurantName) bucket.settings.restaurantName = fallbackName;
  if (raw.nextIds !== undefined && raw.nextIds !== null) {
    if (typeof raw.nextIds !== 'object' || Array.isArray(raw.nextIds)) throw new Error('Invalid nextIds');
    bucket.nextIds = { ...raw.nextIds };
  }
  return bucket;
}

// `coll('orders')` resolves to the active store's array. Routes keep working
// unchanged; the store boundary is enforced here instead of in 27 files.
function coll(name) {
  if (!repo) {
    if (isGlobal(name)) return state[name];
    const id = currentStoreId();
    if (!id) throw new MissingStoreContextError(name);
    return name === 'settings' ? bucketFor(id).settings : bucketFor(id)[name];
  }
  return repo.coll(name);
}

function withStore(store, fn) {
  return repo ? repo.withStore(store, fn) : runWithStore(store, fn);
}

function eachStore(fn) {
  return repo ? repo.eachStore(fn) : [];
}

function nextId(name) {
  return repo ? repo.nextId(name) : null;
}

function slugify(value) {
  return String(value || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function slugAvailable(slug, exceptId) {
  const wanted = String(slug || '').trim().toLowerCase();
  if (!wanted) return false;
  const reserved = new Set(['api', 'assets', 'order', 'login', 'register', 'platform', 'activate', 'static', 'favicon.ico', 'robots.txt']);
  if (reserved.has(wanted)) return false;
  return !state.stores.some((store) => String(store.slug).toLowerCase() === wanted && Number(store.id) !== Number(exceptId));
}

// A store always has at least one branch, and existing installs get "Main"
// attached to their tables so nothing is orphaned by the upgrade.
function ensureDefaultBranch(bucket) {
  if (!Array.isArray(bucket.branches)) bucket.branches = [];
  if (!bucket.branches.length) {
    bucket.branches.push({
      id: 1,
      name: DEFAULT_BRANCH_NAME,
      code: 'main',
      address: '',
      phone: '',
      isDefault: true,
      active: true,
      createdAt: new Date().toISOString(),
    });
    bucket.nextIds = bucket.nextIds || {};
    bucket.nextIds.branches = 1;
  }
  const fallback = bucket.branches[0].id;
  for (const table of bucket.tables || []) {
    if (table.branchId == null) table.branchId = fallback;
  }
  for (const order of bucket.orders || []) {
    if (order.branchId == null) order.branchId = fallback;
  }
  for (const session of bucket.sessions || []) {
    if (session.branchId == null) session.branchId = fallback;
  }
  for (const drawer of bucket.cashSessions || []) {
    if (drawer.branchId == null) drawer.branchId = fallback;
  }
  return bucket.branches;
}

function createBranch(storeId, input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Branch name is required'), { status: 400 });
  const bucket = bucketFor(storeId);
  ensureDefaultBranch(bucket);
  const code = slugify(input.code || name);
  if (!code) throw Object.assign(new Error('Branch code is required'), { status: 400 });
  if (bucket.branches.some((b) => b.code === code)) {
    throw Object.assign(new Error('That branch code is already used'), { status: 409 });
  }
  const branch = {
    id: nextBranchId(storeId),
    name: name.slice(0, 120),
    code,
    address: String(input.address || '').trim().slice(0, 300),
    phone: String(input.phone || '').trim().slice(0, 60),
    isDefault: false,
    active: true,
    createdAt: new Date().toISOString(),
  };
  bucket.branches.push(branch);
  return branch;
}

function nextBranchId(storeId) {
  const bucket = bucketFor(storeId);
  ensureDefaultBranch(bucket);
  const highest = bucket.branches.reduce((max, b) => Math.max(max, Number(b.id) || 0), 0);
  const n = Math.max(Number(bucket.nextIds.branches) || 0, highest) + 1;
  bucket.nextIds.branches = n;
  return n;
}

function createStore(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw Object.assign(new Error('Store name is required'), { status: 400 });
  const slug = slugify(input.slug || name);
  if (!slug || slug.length < 2) throw Object.assign(new Error('Store URL is required'), { status: 400 });
  if (!slugAvailable(slug)) throw Object.assign(new Error('That store URL is already taken'), { status: 409 });
  const plan = PLANS[input.plan] ? input.plan : PLANS.starter.id;
  const store = {
    id: nextId('stores'),
    slug,
    name,
    status: STORE_STATUS.PENDING,
    plan,
    planMonths: Math.max(0, Number(input.planMonths) || 0),
    keyHash: null,
    keyIssuedAt: null,
    keyExpiresAt: null,
    keyUsedAt: null,
    keyRevokedAt: null,
    contactName: String(input.contactName || '').trim() || null,
    contactEmail: String(input.contactEmail || '').trim().toLowerCase() || null,
    contactPhone: String(input.contactPhone || '').trim() || null,
    note: String(input.note || '').trim() || null,
    source: input.source || 'self-registration',
    createdAt: new Date().toISOString(),
    // The clock starts when the store is created, which is not when the
    // registration form was filled in: registration sends a code and creates
    // nothing, so the store is created at verification. A shop that abandons the
    // code never burns a day, and one that verifies does not lose the minutes it
    // spent reading its email. On the paid path there is no code at all, so this
    // is the same moment it always was.
    trialEndsAt: trialEndFrom(new Date().toISOString()),
    // Set when a store is activated on the trial rather than with a paid key.
    // A paid activation clears it, and a store that is not on trial is never
    // paused by the expiry sweep.
    onTrial: true,
    suspensionReason: null,
    activatedAt: null,
    suspendedAt: null,
  };
  state.stores.push(store);
  const bucket = bucketFor(store.id);
  bucket.settings.restaurantName = name;
  ensureDefaultBranch(bucket);
  return store;
}

function updateStore(storeId, patch = {}) {
  const store = findStoreById(storeId);
  if (!store) return null;
  const allowed = ['name', 'plan', 'planMonths', 'contactName', 'contactEmail', 'contactPhone', 'note', 'status', 'suspendedAt', 'activatedAt'];
  for (const key of allowed) {
    if (patch[key] !== undefined) store[key] = patch[key];
  }
  if (patch.settings && typeof patch.settings === 'object') {
    const bucket = bucketFor(store.id);
    bucket.settings = { ...bucket.settings, ...patch.settings };
  }
  return store;
}

function platformSettings() {
  if (!state.platformSettings) state.platformSettings = { ...DEFAULT_PLATFORM_SETTINGS };
  // Filled in on read, because settings saved before the privacy block existed
  // have no such key, and the console would otherwise render an empty policy
  // editor for an install that has never touched it.
  const current = state.platformSettings;
  const defaults = DEFAULT_PLATFORM_SETTINGS.privacy;
  if (!current.privacy || typeof current.privacy !== 'object' || Array.isArray(current.privacy)) {
    current.privacy = { ...defaults };
  } else {
    current.privacy = { ...defaults, ...current.privacy };
    current.privacy.purposes = { ...defaults.purposes, ...(current.privacy.purposes || {}) };
  }
  return current;
}

function contactEmail() {
  const value = platformSettings().contactEmail;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_PLATFORM_SETTINGS.contactEmail;
}

function lineOpenChatUrl() {
  const value = platformSettings().lineOpenChatUrl;
  return typeof value === 'string' ? value.trim() : '';
}

// The LINE link ends up in an href, so only real https LINE invite URLs are
// accepted. A javascript: or data: value here would be an XSS hole, and an
// arbitrary host would be a convincing phishing link sent to every person
// waiting on a key.
// The link ends up in an href, so the scheme and host are enforced: a
// javascript: or data: value would be an XSS hole, and an arbitrary host would
// be a convincing phishing button on every activation screen. The path is not
// checked, because LINE uses several invite shapes (/R/ti/p/@code, /ti/p/~code,
// /ti/g/... and regional hosts) and a wrong guess here would block a valid link.
function validateLineUrl(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return { value: '' };
  if (!/^https:\/\//i.test(raw)) {
    return { error: 'The LINE link must start with https://' };
  }
  let url;
  try {
    url = new URL(raw);
  } catch (e) {
    return { error: 'That does not look like a valid URL' };
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === 'line.me' || host.endsWith('.line.me')
    || host === 'line.me.tw' || host.endsWith('.line.me.tw');
  if (!allowed) return { error: 'The LINE link must be a line.me address' };
  return { value: url.toString() };
}

function updatePlatformSettings(patch = {}) {
  const settings = platformSettings();
  if (patch.contactEmail !== undefined) settings.contactEmail = String(patch.contactEmail).trim();
  if (patch.lineOpenChatUrl !== undefined) {
    const checked = validateLineUrl(patch.lineOpenChatUrl);
    if (checked.error) throw Object.assign(new Error(checked.error), { status: 400 });
    settings.lineOpenChatUrl = checked.value;
  }
  // The shared privacy policy. Validated here rather than trusted, because it is
  // printed verbatim on a public page to a regulator and a customer.
  if (patch.privacy !== undefined) {
    const incoming = patch.privacy;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw Object.assign(new Error('Privacy settings are not in the right shape'), { status: 400 });
    }
    const next = { ...settings.privacy };
    if (incoming.policyVersion !== undefined) {
      const value = String(incoming.policyVersion).trim().slice(0, 20);
      if (!/^[A-Za-z0-9.\-]{1,20}$/.test(value)) {
        throw Object.assign(new Error('Version may use letters, numbers, dots and dashes only'), { status: 400 });
      }
      next.policyVersion = value;
    }
    if (incoming.contactEmail !== undefined) {
      const value = String(incoming.contactEmail).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
        throw Object.assign(new Error('That does not look like a valid email address'), { status: 400 });
      }
      next.contactEmail = value;
    }
    if (incoming.operatorNotes !== undefined) {
      next.operatorNotes = String(incoming.operatorNotes).slice(0, 2000);
    }
    if (incoming.controllerLegalName !== undefined) {
      next.controllerLegalName = String(incoming.controllerLegalName).trim().slice(0, 200);
    }
    if (incoming.controllerAddress !== undefined) {
      next.controllerAddress = String(incoming.controllerAddress).trim().slice(0, 300);
    }
    if (incoming.purposes !== undefined) {
      if (!incoming.purposes || typeof incoming.purposes !== 'object' || Array.isArray(incoming.purposes)) {
        throw Object.assign(new Error('Purposes are not in the right shape'), { status: 400 });
      }
      const purposes = {};
      for (const [key, value] of Object.entries(incoming.purposes)) {
        if (!/^[a-z_]{1,32}$/.test(key)) continue;
        purposes[key] = String(value).slice(0, 200);
      }
      // The loyalty basis is what the loyalty module records consent against, so
      // it cannot be dropped: a shop that could delete it would be storing
      // loyalty data with no stated reason.
      for (const key of Object.keys(settings.privacy.purposes)) {
        if (purposes[key] === undefined) purposes[key] = settings.privacy.purposes[key];
      }
      next.purposes = purposes;
    }
    settings.privacy = next;
  }
  return settings;
}

// Removes a store and everything it owns. Callers must confirm first: there is
// no undo, and orders are part of what goes.
function removeStore(storeId) {
  const id = Number(storeId);
  const store = findStoreById(id);
  if (!store) return null;
  const snapshot = publicStore(store);
  delete state.storeData[String(id)];
  state.stores = state.stores.filter((candidate) => Number(candidate.id) !== id);
  return snapshot;
}

function publicStore(store) {
  if (!store) return null;
  return {
    id: store.id,
    slug: store.slug,
    name: store.name,
    status: store.status,
    plan: store.plan,
    planName: (PLANS[store.plan] || PLANS.starter).name,
    planMonths: store.planMonths || 0,
    restaurantName: (bucketFor(store.id).settings || {}).restaurantName || store.name,
    createdAt: store.createdAt,
    activatedAt: store.activatedAt,
    // The trial, so the platform console can see at a glance which shops are
    // counting down and which have paid. Not sensitive: it is a deadline the
    // server is already going to act on.
    trialEndsAt: store.trialEndsAt || null,
    trialDaysLeft: store.suspensionReason === 'trial_expired' ? 0 : trialRemainingDays(store),
    onTrial: Boolean(store.onTrial && store.trialEndsAt),
    trialEnded: store.suspensionReason === 'trial_expired',
    suspensionReason: store.suspensionReason || null,
    suspendedAt: store.suspendedAt || null,
  };
}

// Whole days left, rounding up so the last partial day reads as a day rather
// than as zero, which would tell a shop its trial was up a day early.
function trialRemainingDays(store) {
  if (!store || !store.trialEndsAt) return null;
  const left = new Date(store.trialEndsAt).getTime() - Date.now();
  if (!Number.isFinite(left)) return null;
  return Math.max(0, Math.ceil(left / 86400000));
}

function storeIsActive(store) {
  return Boolean(store) && store.status === STORE_STATUS.ACTIVE;
}

function revokePlatformJti(jti, expiresAt) {
  if (!jti) return;
  const list = state.revokedPlatformTokens;
  if (!list.some((entry) => entry.jti === jti)) {
    list.push({ jti, expiresAt });
    const nowMs = Date.now();
    state.revokedPlatformTokens = list.filter((entry) => Number(entry.expiresAt) > nowMs);
    persist(state);
  }
}

// What the storage engine currently holds, for the health report.
function storageInfo() {
  return storage.describe();
}

function persist(snapshot, previous) {
  storage.commit(snapshot, previous || null);
}

function touch() {
  if (repo) return repo.touch();
  return persist(state, null);
}

function transaction(mutator) {
  if (repo) return repo.transaction(mutator);
  const previous = state;
  const candidate = clone(state);
  state = candidate;
  try {
    const result = mutator(candidate);
    persist(candidate, previous);
    return result;
  } catch (e) {
    // The in-memory state is put back, and nothing reached the adapter, so
    // disk and memory still agree. A half-applied change is the one thing a
    // till cannot recover from.
    state = previous;
    throw e;
  }
}

function tierFor(points) {
  const value = Number(points) || 0;
  const settings = coll('settings');
  if (value >= (Number(settings.loyaltyTierVip) || 500)) return 'vip';
  if (value >= (Number(settings.loyaltyTierGold) || 200)) return 'gold';
  return 'standard';
}

function netOrderTotal(order) {
  return Math.max(0, (Number(order.total) || 0) - (Number(order.refundedAmount) || 0));
}

function recalculateSession(id) {
  const session = coll('sessions').find((s) => s.id === Number(id));
  if (!session) return;
  const settled = coll('orders').filter((o) => o.sessionId === session.id && !o.draft && ['paid', 'partially_refunded', 'refunded'].includes(o.paymentStatus));
  session.total = Math.round(settled.reduce((sum, o) => sum + netOrderTotal(o), 0) * 100) / 100;
  session.orderCount = settled.length;
}

function releaseStockForOrder(orderId) {
  const items = coll('orderItems').filter((i) => i.orderId === Number(orderId) && i.stockReserved === true && i.status !== 'cancelled' && !i.refunded);
  for (const item of items) {
    const product = coll('products').find((p) => p.id === Number(item.productId));
    if (product && product.trackStock) product.stockCount = Math.max(0, (Number(product.stockCount) || 0) + (Number(item.quantity) || 0));
    item.stockReserved = false;
  }
}

function migrateBucket(bucket) {
  let dirty = false;
  for (const group of bucket.modifierGroups) {
    if (!Array.isArray(group.productIds)) {
      group.productIds = group.productId == null ? [] : [group.productId];
      delete group.productId;
      dirty = true;
    }
  }
  for (const user of bucket.users) {
    if (user.pin && !user.pinHash) {
      user.pinHash = bcrypt.hashSync(String(user.pin), 10);
      delete user.pin;
      dirty = true;
    } else if (user.pin) {
      delete user.pin;
      dirty = true;
    }
    if (!Number.isInteger(Number(user.authVersion)) || Number(user.authVersion) < 1) {
      user.authVersion = 1;
      dirty = true;
    }
    if (user.language !== 'en' && user.language !== 'th') {
      user.language = 'th';
      dirty = true;
    }
  }
  for (const discount of bucket.discounts) {
    if (discount.pointsCost === undefined) { discount.pointsCost = 0; dirty = true; }
    if (discount.stackable === undefined) { discount.stackable = true; dirty = true; }
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (bucket.settings[key] === undefined) { bucket.settings[key] = value; dirty = true; }
  }
  if ('staffLanguage' in bucket.settings) { delete bucket.settings.staffLanguage; dirty = true; }
  for (const order of bucket.orders) {
    if (order.draft && order.paymentStatus === 'paid') {
      order.draft = false;
      dirty = true;
    }
    if (order.refundedAmount === undefined) { order.refundedAmount = 0; dirty = true; }
  }
  for (const session of bucket.sessions) {
    const before = `${session.total}:${session.orderCount}`;
    recalculateSession(session.id);
    if (before !== `${session.total}:${session.orderCount}`) dirty = true;
  }
  const nowMs = Date.now();
  bucket.revokedTokens = bucket.revokedTokens.filter((entry) => Number(entry.expiresAt) > nowMs);
  const activeLocks = bucket.securityLocks.filter((entry) => {
    const blockedUntil = entry.blockedUntil ? new Date(entry.blockedUntil).getTime() : 0;
    const lastFailure = entry.lastFailureAt ? new Date(entry.lastFailureAt).getTime() : 0;
    return blockedUntil > nowMs || nowMs - lastFailure < 24 * 60 * 60 * 1000;
  });
  if (activeLocks.length !== bucket.securityLocks.length) { bucket.securityLocks = activeLocks; dirty = true; }
  return dirty;
}

// Turns a pre-multi-store data.json into a single-store v3 document. The shop
// keeps every record; it just gains a home.
function adoptLegacy(raw) {
  const legacySettings = (raw && typeof raw.settings === 'object' && !Array.isArray(raw.settings)) ? raw.settings : {};
  const name = String(legacySettings.restaurantName || process.env.POS_DEFAULT_STORE_NAME || 'Restaurant').trim() || 'Restaurant';
  const store = {
    id: 1,
    slug: DEFAULT_STORE_SLUG,
    name,
    status: STORE_STATUS.ACTIVE,
    plan: PLANS.enterprise.id,
    planMonths: 0,
    keyHash: null,
    keyIssuedAt: null,
    keyExpiresAt: null,
    keyUsedAt: null,
    keyRevokedAt: null,
    contactName: null,
    contactEmail: null,
    contactPhone: null,
    note: 'Migrated from the original single-store installation.',
    source: 'migration',
    createdAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
    suspendedAt: null,
  };
  const bucket = blankBucket();
  bucket.settings = { ...DEFAULT_SETTINGS, ...legacySettings };
  for (const name2 of STORE_COLLECTIONS) {
    if (raw[name2] !== undefined) bucket[name2] = raw[name2];
  }
  if (raw.nextIds && typeof raw.nextIds === 'object' && !Array.isArray(raw.nextIds)) {
    bucket.nextIds = { ...raw.nextIds };
  }
  const next = blankState();
  ensureDefaultBranch(bucket);
  next.stores.push(store);
  next.storeData[String(store.id)] = bucket;
  next.nextIds = { stores: 1, platformAdmins: 0 };
  // The original admin also runs the platform, so the shop can be managed
  // without inventing a second set of credentials.
  const admins = (bucket.users || []).filter((user) => user.role === 'admin').map((user, index) => ({
    id: index + 1,
    username: user.username,
    name: user.name || user.username,
    role: 'platform_admin',
    passwordHash: user.passwordHash || null,
    pinHash: null,
    active: user.active !== false,
    authVersion: Number(user.authVersion) || 1,
    createdAt: user.createdAt || new Date().toISOString(),
  }));
  next.platformAdmins = admins;
  return markNeedsPersist(next);
}

/**
 * Hand the app's wording back to the shops.
 *
 * These strings were briefly held in one platform-wide table on the reasoning
 * that every shop shows the same buttons. That was wrong about who owns them: a
 * shop that wants "Add to your order" instead changes its own shop, and an
 * install running its own server does it without asking anyone. So they go back.
 *
 * Only the platform's own pages, the home page and the privacy notice, are
 * platform-owned, and those live in platformContent.
 *
 * Merged into each shop rather than copied, so a shop's own menu wording already
 * sitting in storeTranslations is kept, and every shop ends up with the full set.
 * Runs against the raw document because normalizeBucket() rebuilds buckets from
 * STORE_COLLECTIONS only, so a migration reading buckets afterwards finds
 * nothing and loses the work silently.
 */
function returnTranslationsToStores(raw, result) {
  const shared = Array.isArray(raw.translations) ? raw.translations : [];
  if (!shared.length) return;

  const keep = (existing, incoming) => {
    if (!existing) return incoming;
    if (existing.status === 'published') return existing;
    if (incoming.status === 'published') return incoming;
    return String(incoming.th || '').trim() ? incoming : existing;
  };
  const key = (entry) => String(entry.source || '').trim().replace(/\s+/g, ' ');

  for (const store of result.stores) {
    const bucket = result.storeData[String(store.id)];
    if (!bucket) continue;
    // Read the shop's own wording off the RAW bucket, not the normalised one.
    // storeTranslations is no longer a store collection, so normalizeBucket()
    // has already dropped it by the time this runs, and reading the normalised
    // bucket silently loses a shop's menu translations.
    const rawBucket = (raw.storeData && raw.storeData[String(store.id)]) || {};
    const merged = new Map();
    // The shop's own wording first, so it wins where the two tables disagree.
    for (const entry of (Array.isArray(rawBucket.storeTranslations) ? rawBucket.storeTranslations : [])) {
      if (entry && key(entry)) merged.set(key(entry), entry);
    }
    for (const entry of shared) {
      if (entry && typeof entry === 'object' && key(entry)) {
        merged.set(key(entry), keep(merged.get(key(entry)), entry));
      }
    }
    bucket.translations = [...merged.values()];
    // Both tables were the shop's own wording; one is enough now.
    bucket.storeTranslations = [];

    // Ids were renumbered when these were global, so the shop's own counter has
    // to clear the highest one or the next entry collides with an existing row.
    const highest = bucket.translations.length
      ? Math.max(...bucket.translations.map((e) => Number(e.id) || 0))
      : 0;
    if (!bucket.nextIds || typeof bucket.nextIds !== 'object') bucket.nextIds = {};
    if (Number(bucket.nextIds.translations || 0) <= highest) bucket.nextIds.translations = highest;
  }
  markNeedsPersist(result);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid data root');
  if (raw.schemaVersion >= SCHEMA_VERSION && raw.storeData && Array.isArray(raw.stores)) {
    const result = blankState();
    result.schemaVersion = SCHEMA_VERSION;
    for (const store of raw.stores) {
      if (!store || typeof store !== 'object') continue;
      result.stores.push({
        ...store,
        id: Number(store.id),
        slug: slugify(store.slug),
        name: String(store.name || 'Store'),
        status: Object.values(STORE_STATUS).includes(store.status) ? store.status : STORE_STATUS.PENDING,
        plan: PLANS[store.plan] ? store.plan : PLANS.starter.id,
      });
    }
    if (!Array.isArray(raw.platformAdmins)) throw new Error('Invalid platformAdmins');
    result.platformAdmins = raw.platformAdmins;
    // Every plain array global is carried across from disk, from the list rather
    // than from a hand-written block per collection.
    //
    // This was one block per collection, and cookieConsents was never given one,
    // so it was silently reset to [] on every load: the server came back up
    // having forgotten that every visitor had already agreed, and asked them all
    // again. A collection that is in GLOBAL_COLLECTIONS but missing here is not
    // inert, it is emptied, and the next persist writes the loss to disk. So
    // anything added to GLOBAL_COLLECTIONS is now carried across automatically
    // and this list cannot fall behind it.
    for (const name of PLAIN_GLOBAL_ARRAYS) {
      if (raw[name] === undefined || raw[name] === null) continue;
      if (!Array.isArray(raw[name])) throw new Error(`Invalid ${name}`);
      result[name] = raw[name];
    }
    if (raw.platformSettings !== undefined) {
      if (!raw.platformSettings || typeof raw.platformSettings !== 'object' || Array.isArray(raw.platformSettings)) {
        throw new Error('Invalid platformSettings');
      }
      result.platformSettings = { ...DEFAULT_PLATFORM_SETTINGS, ...raw.platformSettings };
      // A stored LINE link is re-validated on load, so a hand-edited file
      // cannot smuggle in a javascript: or off-host URL.
      const checked = validateLineUrl(result.platformSettings.lineOpenChatUrl);
      result.platformSettings.lineOpenChatUrl = checked.error ? '' : checked.value;
    }
    if (raw.platformContent !== undefined) {
      if (!Array.isArray(raw.platformContent)) throw new Error('Invalid platformContent');
      result.platformContent = raw.platformContent;
    }
    if (raw.nextIds !== undefined) {
      if (!raw.nextIds || typeof raw.nextIds !== 'object' || Array.isArray(raw.nextIds)) throw new Error('Invalid nextIds');
      result.nextIds = { ...raw.nextIds };
    }
    for (const store of result.stores) {
      const raw2 = raw.storeData[String(store.id)];
      const bucket = raw2 ? normalizeBucket(raw2, store.name) : blankBucket();
      // normalize() only reshapes memory, so anything it fills in has to be
      // written out, otherwise the upgrade silently never lands on disk.
      if (JSON.stringify(bucket) !== JSON.stringify(raw2)) markNeedsPersist(result);
      ensureDefaultBranch(bucket);
      result.storeData[String(store.id)] = bucket;
    }
    // After the buckets, while the raw copy is still in hand.
    returnTranslationsToStores(raw, result);
    return result;
  }
  return adoptLegacy(raw);
}

function migrate() {
  let dirty = false;
  eachStore((store) => {
    const bucket = bucketFor(store.id);
    const before = JSON.stringify([bucket.branches || [], bucket.tables, bucket.orders, bucket.sessions, bucket.cashSessions]);
    ensureDefaultBranch(bucket);
    if (JSON.stringify([bucket.branches, bucket.tables, bucket.orders, bucket.sessions, bucket.cashSessions]) !== before) dirty = true;
    if (migrateBucket(bucket)) dirty = true;
  });
  if (state.stores.length && !state.nextIds.stores) {
    state.nextIds.stores = Math.max(...state.stores.map((s) => Number(s.id) || 0));
    dirty = true;
  }
  if (state.platformAdmins.length && !state.nextIds.platformAdmins) {
    state.nextIds.platformAdmins = Math.max(...state.platformAdmins.map((u) => Number(u.id) || 0));
    dirty = true;
  }
  if (dirty) persist(state);
  return state;
}

// The repository is built once the document exists, and it is what owns it
// from then on. Everything below still talks to `state` for the migration
// itself, which is the one place that legitimately has to see the whole
// document rather than one store's view of it.
function bindRepo() {
  repo = createRepo({
    getDoc: () => state,
    setDoc: (next) => { state = next; },
    isGlobal,
    blankBucket,
    bucketFor: (doc, id) => bucketFor(id),
    persist: (snapshot, previous) => persist(snapshot, previous),
    storage,
  });
  return repo;
}

function load() {
  let raw = null;
  try {
    raw = storage.load();
  } catch (e) {
    throw new Error(`Could not read the data store: ${e.message}`);
  }
  if (!raw) {
    // A server started with nothing on disk gets a document with no shops in it,
    // and the setup form creates the first one.
    //
    // This used to fabricate a store named "Restaurant" here, which is right for
    // an upgrade path and wrong for this build: a self-hoster starting from
    // nothing should be asked what their shop is called, not handed a placeholder
    // they have to rename afterwards. It also made POST /platform/setup
    // unreachable, since that route refuses once a shop exists and one always
    // did.
    state = blankState();
    bindRepo();
    persist(repo.document, null);
    console.log('No shops yet. Open the page and use the Set up tab to create one.');
    return repo.document;
  }
  const wasLegacy = !(raw && raw.schemaVersion >= SCHEMA_VERSION && raw.storeData);
  state = normalize(raw);
  const reshaped = Boolean(state.needsPersist);
  bindRepo();
  migrate();
  if (wasLegacy) {
    persist(repo.document, null);
    console.log(`Single-store data migrated into store "${defaultStore()?.slug}"`);
  } else if (reshaped) {
    persist(repo.document, null);
    console.log('Data file upgraded in place');
  }
  return repo.document;
}

function now() {
  return new Date().toISOString();
}

// Abandoned register tickets. Defaults are deliberately short: these are the
// cashier's working tickets, not a customer's in-progress order.
function emptyDraftMs() {
  return Math.max(1, Number(coll('settings').draftEmptyMinutes) || 5) * 60 * 1000;
}
function staleDraftMs() {
  return Math.max(1, Number(coll('settings').draftStaleMinutes) || 45) * 60 * 1000;
}

function cleanupGhosts() {
  let removed = 0;
  eachStore(() => {
    const cutoffEmpty = Date.now() - emptyDraftMs();
    const cutoffStale = Date.now() - staleDraftMs();
    const orders = coll('orders');
    const ghosts = orders.filter((order) => {
      if (!order.draft || order.paymentStatus !== 'pending') return false;
      const touched = new Date(order.updatedAt || order.createdAt).getTime();
      const hasItems = coll('orderItems').some((item) => item.orderId === order.id);
      return hasItems ? touched < cutoffStale : touched < cutoffEmpty;
    });
    if (!ghosts.length) return;
    const ids = new Set(ghosts.map((order) => order.id));
    for (const id of ids) releaseStockForOrder(id);
    const bucket = bucketFor(currentStoreId());
    bucket.orders = bucket.orders.filter((order) => !ids.has(order.id));
    bucket.orderItems = bucket.orderItems.filter((item) => !ids.has(item.orderId));
    bucket.payments = bucket.payments.filter((payment) => !ids.has(payment.orderId));
    for (const session of bucket.sessions) recalculateSession(session.id);
    removed += ghosts.length;
  });
  if (removed) persist(state);
  return removed;
}

module.exports = {
  load, touch, transaction, coll, nextId, now, DATA_DIR, DATA_FILE, BACKUP_FILE, storageInfo,
  migrate, cleanupGhosts, recalculateSession, releaseStockForOrder, netOrderTotal, tierFor,
  revokePlatformJti,
  // multi-store surface
  withStore, runWithStore, eachStore, bucketFor, storeList, findStoreBySlug, findStoreById,
  defaultStore, createStore, updateStore, publicStore, storeIsActive, slugify, slugAvailable,
  // branches
  ensureDefaultBranch, createBranch, nextBranchId, removeStore, DEFAULT_BRANCH_NAME,
  // platform settings
  platformSettings, contactEmail, lineOpenChatUrl, updatePlatformSettings,
  validateLineUrl, DEFAULT_PLATFORM_SETTINGS,
  MissingStoreContextError, PLANS, STORE_STATUS, SCHEMA_VERSION, DEFAULT_STORE_SLUG,
  STORE_COLLECTIONS, GLOBAL_COLLECTIONS, DEFAULT_SETTINGS, TRIAL_DAYS, trialEndFrom, trialRemainingMs,
};
