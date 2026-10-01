// Session state is per store. Signing in at shop A must never hand shop A's
// token to shop B, and two shops on the same browser stay separate.
const PLATFORM = '__platform__';

let currentStore = '';
// Which branch of the store the till is on. Sent as X-POS-Branch so the server
// stamps orders, sessions and the cash drawer with it.
let currentBranch = '';

export function setApiStore(slug, branch) {
  currentStore = String(slug || '').trim().toLowerCase();
  if (branch !== undefined) currentBranch = String(branch || '');
}

export function getApiBranch() {
  return currentBranch;
}

export function getApiStore() {
  return currentStore;
}

function scopeKey(key, scope) {
  return `${key}:${scope || currentStore || '_root'}`;
}

function readStored(key, scope) {
  try {
    const current = sessionStorage.getItem(scopeKey(key, scope));
    if (current) return current;
    const legacy = localStorage.getItem(scopeKey(key, scope));
    if (legacy) {
      sessionStorage.setItem(scopeKey(key, scope), legacy);
      localStorage.removeItem(scopeKey(key, scope));
    }
    return legacy;
  } catch (e) { return null; }
}

function writeStored(key, value, scope) {
  try {
    sessionStorage.setItem(scopeKey(key, scope), value);
    localStorage.removeItem(scopeKey(key, scope));
  } catch (e) {}
}

function clearStored(key, scope) {
  try { sessionStorage.removeItem(scopeKey(key, scope)); } catch (e) {}
  try { localStorage.removeItem(scopeKey(key, scope)); } catch (e) {}
}

export const api = {
  get store() { return currentStore; },
  setStore(slug) { setApiStore(slug); },
  get token() {
    return readStored('pos_token');
  },
  get platformToken() {
    return readStored('pos_token', PLATFORM);
  },
  setSession(token, user, scope) {
    writeStored('pos_token', token, scope);
    writeStored('pos_user', JSON.stringify(user || null), scope);
  },
  setPlatformSession(token, user) {
    writeStored('pos_token', token, PLATFORM);
    writeStored('pos_user', JSON.stringify(user || null), PLATFORM);
  },
  getUser(scope) {
    try {
      return JSON.parse(readStored('pos_user', scope));
    } catch (e) {
      return null;
    }
  },
  clear(scope) {
    clearStored('pos_token', scope);
    clearStored('pos_user', scope);
  },
  clearPlatform() {
    clearStored('pos_token', PLATFORM);
    clearStored('pos_user', PLATFORM);
  },
  // The store every signed-in user last worked in, so the root sign-in box can
  // pre-fill it next time.
  lastStore() {
    try {
      const value = localStorage.getItem('pos_last_store');
      return value ? String(value) : '';
    } catch (e) { return ''; }
  },
  rememberStore(slug) {
    try { if (slug) localStorage.setItem('pos_last_store', String(slug)); } catch (e) {}
  },
  // The branch is remembered per store, so a cashier who works two locations
  // does not start each shift on the wrong one.
  lastBranch(slug) {
    try {
      const value = localStorage.getItem(`pos_branch:${slug || currentStore}`);
      return value ? String(value) : '';
    } catch (e) { return ''; }
  },
  rememberBranch(slug, branchId) {
    try {
      if (slug) localStorage.setItem(`pos_branch:${slug}`, String(branchId || ''));
    } catch (e) {}
  },
};

async function request(method, path, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const platform = opts.platform === true;
  const token = platform ? api.platformToken : api.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  // Public endpoints resolve the store from their token; everything else says
  // which store it is talking to.
  if (!platform && currentStore && !opts.noStore) {
    headers['X-POS-Store'] = currentStore;
    if (currentBranch) headers['X-POS-Branch'] = currentBranch;
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: opts.signal,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (e) {
    data = text;
  }
  if (!res.ok) {
    const message = typeof data === 'object' && data && (data.detail || data.message)
      ? (data.detail || data.message)
      : `Request failed (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const get = (p, opts) => request('GET', p, undefined, opts);
export const post = (p, b, opts) => request('POST', p, b, opts);
export const patch = (p, b, opts) => request('PATCH', p, b, opts);
// put and del used to drop opts, which silently threw away { platform: true } and
// sent the request with no token at all. Every helper now forwards it.
export const put = (p, b, opts) => request('PUT', p, b, opts);
export const del = (p, opts) => request('DELETE', p, undefined, opts);

export function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '0.00';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Dates and times follow the language the user picked, not the browser.
export const LOCALE = { th: 'th-TH', en: 'en-GB' };

export function fmtDateTime(value, lang = 'th') {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE[lang] || LOCALE.th, {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtTime(value, lang = 'th') {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(LOCALE[lang] || LOCALE.th, { hour: '2-digit', minute: '2-digit' });
}
