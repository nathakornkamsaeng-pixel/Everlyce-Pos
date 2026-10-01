import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post } from '../lib/api';
import { ShieldCheck, Cookie } from 'lucide-react';

// Cookie consent.
//
// The gate, not the banner. There is exactly one function in the whole app that
// writes a cookie, `writeCookie`, and it refuses unless consent has been given.
// A component that forgets to check cannot set one, which is the only arrangement
// where "nothing is stored until they agree" is true rather than intended.
//
// When there are no cookies to set the gate reports nothing and this renders
// nothing at all. Asking a visitor to agree to nothing is worse than saying
// nothing: it teaches them that consent notices are decoration.

const ConsentCtx = createContext({
  status: null, ready: false, required: false, granted: false, decide: async () => {}, writeCookie: () => false,
});

export function CookieConsentProvider({ children }) {
  const [status, setStatus] = useState(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await get('/cookie-consent/status', { noStore: true });
      setStatus(d || null);
    } catch (e) {
      // A failed check must not silently unlock the gate. If consent is unknown,
      // it is withheld.
      setStatus({ required: true, granted: false, unknown: true });
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const decide = useCallback(async (granted) => {
    setBusy(true);
    try {
      const d = await post('/cookie-consent', { granted }, { noStore: true });
      setStatus((d && d.status) || { required: false, granted });
      return true;
    } catch (e) {
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * The only way this app writes a cookie.
   *
   * Returns whether it was allowed, so a caller that genuinely needs the value
   * can react rather than carrying on with a missing one.
   */
  const writeCookie = useCallback((name, value, options = {}) => {
    const allowed = Boolean(status && status.granted && status.version === status.agreedVersion);
    if (!allowed) return false;
    const days = options.days || 365;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    const parts = [
      `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
      `Path=${options.path || '/'}`,
      `Max-Age=${days * 86400}`,
      'SameSite=Lax',
      secure,
    ];
    if (options.httpOnly === false) parts.push('Path=/');
    document.cookie = parts.filter(Boolean).join('; ');
    return true;
  }, [status]);

  const value = useMemo(() => ({
    status,
    ready,
    required: Boolean(status && status.required),
    granted: Boolean(status && status.granted),
    decide,
    writeCookie,
  }), [status, ready, decide, writeCookie]);

  return (
    <ConsentCtx.Provider value={value}>
      {children}
      {ready && status && status.required && !status.unknown ? (
        <CookieBanner status={status} busy={busy} onDecide={decide} />
      ) : null}
    </ConsentCtx.Provider>
  );
}

function CookieBanner({ status, busy, onDecide }) {
  const cats = status.cookies || [];
  return (
    <div className="consent-bar" role="dialog" aria-live="polite" aria-label="Cookie consent">
      <div className="consent-inner">
        <Cookie size={20} className="consent-icon" />
        <div className="consent-text">
          <strong>We use cookies</strong>
          <p>
            We only store a cookie once you agree, and only the ones listed below.
            Refusing means none are set and nothing here stops working.
          </p>
          {cats.length ? (
            <ul>
              {cats.map((c) => (
                <li key={c.name}><code>{c.name}</code> — {c.purpose}</li>
              ))}
            </ul>
          ) : null}
          <a className="consent-link" href="/privacy#storage">Read the details</a>
        </div>
        <div className="consent-actions">
          <button className="btn" disabled={busy} onClick={() => onDecide(false)}>
            {busy ? 'Saving' : 'No thanks'}
          </button>
          <button className="btn primary" disabled={busy} onClick={() => onDecide(true)}>
            <ShieldCheck size={15} /> {busy ? 'Saving' : 'Agree'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function useCookieConsent() {
  return useContext(ConsentCtx);
}