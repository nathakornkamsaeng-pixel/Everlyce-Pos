import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { get } from './api';

// Where a visitor should go when they need a key. The platform admin can change
// both of these from the console, so the app asks the server rather than
// carrying its own copy that can drift.
//
// This is a context rather than a module variable on purpose: the value arrives
// after the first paint, and a plain variable would never re-render the screens
// that read it, so a newly saved link would silently not appear.
const FALLBACK = { contactEmail: 'you@example.com', lineOpenChatUrl: '', plans: [], recaptchaSiteKey: null, trialDays: 0, registrationOpen: false };

const ConfigCtx = createContext({ ...FALLBACK });

export function PlatformConfigProvider({ children }) {
  const [config, setConfig] = useState(FALLBACK);

  const load = useCallback(async () => {
    try {
      const d = await get('/platform/config', { noStore: true });
      setConfig({
        // Spread the server's answer, then override only the few fields that
        // need a fallback of their own.
        //
        // This provider used to rebuild the object field by field, and every
        // new server field had to be remembered here or it arrived as
        // undefined with no error anywhere. That is how the pricing section
        // silently fell back to "unavailable", and how the registration form
        // rendered no captcha while the server was enforcing one. A field added
        // to the endpoint now works without touching this file at all.
        ...d,
        contactEmail: (d && d.contactEmail) || FALLBACK.contactEmail,
        lineOpenChatUrl: (d && d.lineOpenChatUrl) || '',
        // Plans come from the server so the advertised price is the price
        // charged. A missing or malformed list reads as no plans rather than
        // as a crash in the middle of the page.
        plans: (d && Array.isArray(d.plans)) ? d.plans : [],
        // The public half of the captcha pair. The secret half never leaves
        // the server, and the registration form renders no widget without this.
        recaptchaSiteKey: (d && d.recaptchaSiteKey) || null,
        // The trial offer. Zero and closed are the safe readings: a page that
        // cannot reach the server must not claim seven days it cannot promise,
        // and must not offer a registration form that does not exist.
        trialDays: Number((d && d.trialDays) || 0),
        registrationOpen: Boolean(d && d.registrationOpen),
      });
      return true;
    } catch (e) {
      return false;
    }
  }, []);

  // One load for the whole app, so switching screens does not refetch.
  useEffect(() => { load(); }, [load]);

  // Exposed so a screen that just saved new details can push them straight
  // into every other view without waiting for a refetch.
  const value = { ...config, refresh: load };
  return <ConfigCtx.Provider value={value}>{children}</ConfigCtx.Provider>;
}

export function usePlatformConfig() {
  return useContext(ConfigCtx);
}

// A LINE button, rendered only when a link has actually been configured.
export function LineJoinButton({ className = 'btn line-join', label = 'Chat on LINE', compact = false }) {
  const { lineOpenChatUrl } = usePlatformConfig();
  if (!lineOpenChatUrl) return null;
  return (
    <a className={className} href={lineOpenChatUrl} target="_blank" rel="noreferrer noopener">
      {compact ? 'LINE' : label}
    </a>
  );
}
