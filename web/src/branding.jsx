import React, { createContext, useContext, useEffect, useState } from 'react';
import { get } from './lib/api';
import { BRAND_LOGO } from './lib/brand-assets';

// The restaurant name typed in Settings is the brand for the whole site.
// Signed-out screens (sign-in, the QR menu, the customer display) need it too,
// so it comes from the public endpoint rather than the authenticated settings.
const BrandingCtx = createContext({ name: '', currency: 'THB', ready: false, refresh: () => {} });

export function BrandingProvider({ children }) {
  // The server inlines the name into the page, so the first paint is correct.
  const injected = typeof window !== 'undefined' && window.__BRAND__ ? window.__BRAND__ : '';
  const [state, setState] = useState({ name: injected, currency: 'THB', ready: false });

  const load = () => {
    get('/public/branding')
      .then((d) => {
        const name = (d && d.restaurantName) || '';
        setState({ name, currency: (d && d.currency) || 'THB', ready: true });
        if (name) document.title = name;
      })
      .catch(() => setState((s) => ({ ...s, ready: true })));
  };

  useEffect(() => { load(); }, []);

  return <BrandingCtx.Provider value={{ ...state, refresh: load }}>{children}</BrandingCtx.Provider>;
}

export const useBranding = () => useContext(BrandingCtx);

export function BrandLogo({ size = 40, className = '', alt = '' }) {
  return <img src={BRAND_LOGO} width={size} height={size} className={`brand-logo ${className}`.trim()} alt={alt} draggable="false" />;
}

// Never show a raw placeholder on screen: fall back to something tidy.
export const brand = (name) => (name && name.trim() ? name.trim() : 'Restaurant');
