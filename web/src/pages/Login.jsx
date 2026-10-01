import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, api } from '../lib/api';
import { useStore } from '../lib/store';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { useBranding, brand, BrandLogo } from '../branding';
import { CircleAlert } from 'lucide-react';

export default function Login() {
  const { t } = useI18n();
  const { name: brandName } = useBranding();
  const { slug, store } = useStore();
  const [mode, setMode] = useState('account');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const nav = useNavigate();
  const { setUser } = useAuth();

  const home = slug || '';

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      let body;
      if (mode === 'account') {
        if (!username || !password) throw new Error('Enter username and password');
        body = { username, password, store: slug };
      } else {
        if (!username || !pin) throw new Error('Enter username and PIN');
        body = { username, pin, store: slug };
      }
      const d = await post('/auth/login', body);
      const target = d.store?.slug || slug;
      api.setSession(d.token, d.user, target);
      setUser(d.user);
      // A store that has not activated can sign in, but there is nothing to
      // show yet, so send the owner straight to the activation screen.
      if (d.activationRequired) {
        nav(`/${target}/activate`, { replace: true });
        return;
      }
      const dest = d.user.role === 'kds' ? `/${target}/kds` : d.user.role === 'display' ? `/${target}/display` : `/${target}`;
      nav(dest, { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="logo-row">
          <BrandLogo size={40} />
          <div>
            <h2>{brand(store ? (store.restaurantName || store.name) : brandName)}</h2>
            <div className="sub">{t('Restaurant operations')}</div>
          </div>
        </div>
        {slug ? (
          <div className="login-store">
            <span>Store</span>
            <code>/{slug}</code>
            <a href="/" className="link">change</a>
          </div>
        ) : null}
        <div className="login-tabs">
          <button type="button" className={mode === 'account' ? 'on' : ''} onClick={() => setMode('account')}>{t('Password')}</button>
          <button type="button" className={mode === 'pin' ? 'on' : ''} onClick={() => setMode('pin')}>{t('Staff PIN')}</button>
        </div>
        <div className="field">
          <label>{t('Username')}</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </div>
        {mode === 'account' ? (
          <div className="field">
            <label>{t('Password')}</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </div>
        ) : (
          <div className="field">
            <label>PIN</label>
            <input inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={6} />
          </div>
        )}
        {err && <div className="login-error"><CircleAlert size={16} /> <span>{err}</span></div>}
        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? <span className="spin" style={{ borderColor: '#fff3', borderTopColor: '#fff', width: 16, height: 16 }} /> : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
