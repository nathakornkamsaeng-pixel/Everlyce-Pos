import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { get } from './lib/api';

export const I18nCtx = createContext({ t: (k) => k, lang: 'th', setLang: () => {}, setLanguage: () => {}, ready: false, reloadTranslations: async () => ({}) });

// The canonical English label for each key. The published translation map is keyed
// by this same English string, so an untranslated label simply falls back to English.
const UI_STRINGS = {
  'Menu': 'Menu',
  'Add to basket': 'Add to basket',
  'Add to order': 'Add to order',
  'Your basket': 'Your basket',
  'Your order': 'Your order',
  'Your orders': 'Your orders',
  'Place order': 'Place order',
  'Confirm order': 'Confirm order',
  'Cancel': 'Cancel',
  'Close': 'Close',
  'Done': 'Done',
  'Back': 'Back',
  'Save': 'Save',
  'Delete': 'Delete',
  'Edit': 'Edit',
  'Total': 'Total',
  'Subtotal': 'Subtotal',
  'Tax': 'Tax',
  'Service charge': 'Service charge',
  'Discount': 'Discount',
  'Cash': 'Cash',
  'Card': 'Card',
  'Charge': 'Charge',
  'Special request': 'Special request',
  'Notes': 'Notes',
  'Note': 'Note',
  'Quantity': 'Quantity',
  'Price': 'Price',
  'Items': 'Items',
  'Item': 'Item',
  'Name': 'Name',
  'Description': 'Description',
  'Table': 'Table',
  'Tables': 'Tables',
  'Order': 'Order',
  'Orders': 'Orders',
  'Checkout': 'Checkout',
  'Dashboard': 'Dashboard',
  'Settings': 'Settings',
  'Users': 'Users',
  'Categories': 'Categories',
  'Category': 'Category',
  'Modifiers': 'Modifiers',
  'Options': 'Options',
  'No menu items yet': 'No menu items yet',
  'Your orders this visit': 'Your orders this visit',
  'No orders yet': 'No orders yet',
  'Sent to kitchen': 'Sent to kitchen',
  'Preparing': 'Preparing',
  'Ready for pickup': 'Ready for pickup',
  'Served': 'Served',
  'Paid': 'Paid',
  'Cancelled': 'Cancelled',
  'Pending': 'Pending',
  'Available': 'Available',
  'Occupied': 'Occupied',
  'New order': 'New order',
  'Keep ordering': 'Keep ordering',
  'Takeaway': 'Takeaway',
  'Delivery': 'Delivery',
  'Dine-in': 'Dine-in',
  'Customer name': 'Customer name',
  'Thank you': 'Thank you',
  'Thank you!': 'Thank you!',
  'Ready to serve': 'Ready to serve',
  'Payment received': 'Payment received',
  'This visit has ended': 'This visit has ended',
  'Kitchen Display': 'Kitchen Display',
  'Customer Display': 'Customer Display',
  'Sign out': 'Sign out',
  'Order placed!': 'Order placed!',
  'No items': 'No items',
  'Other': 'Other',
};

export function I18nProvider({ children, authed = false, userLang = null, onUserLangChange = null }) {
  const [lang, setLangState] = useState('th');
  const [map, setMap] = useState({});
  const [ready, setReady] = useState(false);
  const translationRequestRef = useRef(0);

  const reloadTranslations = useCallback(async () => {
    const request = translationRequestRef.current + 1;
    translationRequestRef.current = request;
    setReady(false);
    try {
      const next = await get(authed ? '/i18n' : '/i18n/public');
      if (translationRequestRef.current === request) setMap(next || {});
      return next || {};
    } catch (e) {
      return {};
    } finally {
      if (translationRequestRef.current === request) setReady(true);
    }
  }, [authed]);

  useEffect(() => {
    reloadTranslations();
  }, [reloadTranslations]);

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') reloadTranslations();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [reloadTranslations]);

  useEffect(() => {
    if (authed) {
      if (userLang === 'th' || userLang === 'en') setLangState(userLang);
    } else {
      try {
        const saved = localStorage.getItem('pos_lang');
        setLangState(saved === 'en' ? 'en' : 'th');
      } catch (e) {}
    }
  }, [authed, userLang]);

  const setLang = useCallback((next) => {
    const l = next === 'en' ? 'en' : 'th';
    setLangState(l);
    if (authed && onUserLangChange) onUserLangChange(l);
    else { try { localStorage.setItem('pos_lang', l); } catch (e) {} }
  }, [authed, onUserLangChange]);

  const setLanguage = useCallback((next) => {
    setLangState(next === 'en' ? 'en' : 'th');
  }, []);

  const t = useCallback((key) => {
    if (!key) return key;
    const source = String(key);
    if (lang === 'en') return source;
    const normalized = source.trim().replace(/\s+/g, ' ');
    const lookupKey = [normalized.toLowerCase(), normalized, source].find((candidate) => Object.prototype.hasOwnProperty.call(map, candidate));
    return lookupKey ? map[lookupKey] : source;
  }, [lang, map]);

  const value = useMemo(() => ({ t, lang, setLang, setLanguage, ready, reloadTranslations }), [t, lang, setLang, setLanguage, ready, reloadTranslations]);
  return <I18nCtx.Provider value={value}>{children}</I18nCtx.Provider>;
}

export const useI18n = () => useContext(I18nCtx);
export { UI_STRINGS };