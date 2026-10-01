import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { get, setApiStore, api } from './api.js';
import { usePlatformConfig } from './config.jsx';

// Which shop this is.
//
// The app lives at the root of the host on a single-shop install, so there is
// usually no store name in the path at all: the server publishes the one slug in
// /api/platform/config and that is the answer. A name in the path still wins, so
// the QR codes printed before this change -- which all carry it -- keep working.
const StoreCtx = createContext({
  slug: '',
  store: null,
  status: 'unknown',
  ready: true,
  contactEmail: 'you@example.com',
  refresh: () => {},
  base: '/',
});

export function StoreProvider({ children }) {
  const { storeId } = useParams();
  const { storeSlug } = usePlatformConfig();
  // A fresh install has no shop yet, so the server says null and there is nothing
  // to fall back to. That is a real state, not a loading one, and the caller
  // shows the set-up form.
  const slug = String(storeId || storeSlug || '').toLowerCase();
  // Whether this page was reached at the root of the host or under the old
  // prefixed path. It decides where a redirect should send someone: at the root
  // the answer is /login, and under the prefix it has to stay inside it or a
  // staff member following an old link would silently leave the prefixed path and
  // land somewhere that still works, which is fine, but the URL would change
  // underneath them mid-session.
  const prefixed = Boolean(storeId);
  const [state, setState] = useState({ store: null, status: 'unknown', ready: true });

  // Point the API client at this store before any child effect fires a request.
  useEffect(() => {
    setApiStore(slug);
    if (slug) api.rememberStore(slug);
  }, [slug]);

  const load = useCallback(() => {
    if (!slug) {
      setState({ store: null, status: 'none', ready: true });
      return Promise.resolve();
    }
    setState((s) => ({ ...s, ready: false }));
    return get(`/platform/store/${encodeURIComponent(slug)}`, { noStore: true })
      .then((d) => {
        const store = (d && d.store) || null;
        setState({
          store,
          status: store ? store.status : 'missing',
          // The trial countdown comes from the same endpoint that enforces
          // it, so the number on screen is the number the server will act on.
          daysLeft: store ? store.trialDaysLeft : null,
          onTrial: store ? store.onTrial : false,
          trialEnded: store ? store.trialEnded : false,
          ready: true,
        });
        if (store) document.title = `${store.restaurantName || store.name} · Everlyce POS`;
      })
      .catch(() => setState({ store: null, status: 'missing', ready: true }));
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  const value = {
    slug,
    store: state.store,
    status: state.status,
    daysLeft: state.daysLeft,
    onTrial: state.onTrial,
    trialEnded: state.trialEnded,
    ready: state.ready,
    contactEmail: 'you@example.com',
    refresh: load,
    base: prefixed && slug ? `/${slug}` : '',
  };

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export const useStore = () => useContext(StoreCtx);

// A link that stays inside this store.
//
// The prefix comes from the store context rather than being built here, because
// on a single-shop install there is no prefix: the shop is at the root of the
// host, so /login is the address. A page that has the store context builds its
// own links with this; the fallback keeps the old signature working for anything
// still called with a bare slug.
export function storePath(slug, path = '/', base = '') {
  const prefix = base;
  const tail = String(path).startsWith('/') ? String(path) : `/${path}`;
  return `${prefix}${tail === '/' ? '' : tail}`;
}
