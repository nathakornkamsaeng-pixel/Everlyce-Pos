import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { get, setApiStore, api } from './api.js';

// The store is the first path segment: /your-store/checkout. Everything below
// that prefix is the existing single-store app, unchanged.
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
  const slug = String(storeId || '').toLowerCase();
  const [state, setState] = useState({ store: null, status: 'unknown', ready: true });

  // Point the API client at this store before any child effect fires a request.
  useEffect(() => {
    setApiStore(slug);
    if (slug) api.rememberStore(slug);
  }, [slug]);

  const load = useCallback(() => {
    if (!slug) {
      setState({ store: null, status: 'unknown', ready: true });
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
    base: slug ? `/${slug}` : '',
  };

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export const useStore = () => useContext(StoreCtx);

// A link that stays inside this store.
export function storePath(slug, path = '/') {
  const tail = String(path).startsWith('/') ? String(path) : `/${path}`;
  return `/${slug}${tail === '/' ? '' : tail}`;
}
