import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, get, post } from './lib/api';
import { getApiStore } from './lib/api';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => api.getUser());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!api.token) {
      setReady(true);
      return;
    }
    get('/auth/me')
      .then((d) => {
        if (alive) {
          api.setSession(api.token, d.user);
          setUser(d.user);
        }
      })
      .catch(() => {
        if (alive) {
          api.clear();
          setUser(null);
        }
      })
      .finally(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);

  const logout = useCallback(() => {
    // Clear this store's session only, so signing out of one shop on a shared
    // tablet leaves the other shops signed in.
    const scope = getApiStore();
    try { post('/auth/logout', {}).catch(() => {}); } catch (e) {}
    api.clear(scope);
    setUser(null);
    window.location.hash = '';
    window.location.href = scope ? `/${scope}/login` : '/';
  }, []);

  return (
    <AuthCtx.Provider value={{ user, setUser, ready, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}