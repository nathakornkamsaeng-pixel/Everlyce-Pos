import React, { useCallback, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { put, api, setApiStore } from './lib/api';
import { StoreProvider, useStore, storePath } from './lib/store';
import { BranchProvider, useBranch } from './lib/branch';
import { PlatformConfigProvider } from './lib/config.jsx';
import { ToastProvider } from './components/Toast';
import { I18nProvider } from './i18n';
import { BrandingProvider } from './branding';
import ErrorBoundary from './components/ErrorBoundary';
import { CookieConsentProvider } from './components/CookieConsent';
import Layout, { useUiMode } from './components/Layout';
import Landing from './pages/Landing';
import Privacy from './pages/Privacy';
import PlatformConsole from './pages/PlatformConsole';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Checkout from './pages/Checkout';
import Orders from './pages/Orders';
import Tables from './pages/Tables';
import Menu from './pages/Menu';
import Modifiers from './pages/Modifiers';
import Discounts from './pages/Discounts';
import Inventory from './pages/Inventory';
import Loyalty from './pages/Loyalty';
import Users from './pages/Users';
import QRCodes from './pages/QRCodes';
import Branches from './pages/Branches';
import Sessions from './pages/Sessions';
import CashDrawer from './pages/CashDrawer';
import Reports from './pages/Reports';
import Settings from './pages/Settings';
import Printers from './pages/Printers';
import StoreTranslations from './pages/StoreTranslations';
import Integrations from './pages/Integrations';
import DataCenter from './pages/DataCenter';
import KDS from './pages/KDS';
import PublicOrder from './pages/PublicOrder';
import Receipt from './pages/Receipt';
import Display from './pages/Display';
import CashierHome from './pages/CashierHome';

function Guard({ children, roles }) {
  const { user, ready } = useAuth();
  const { slug } = useStore();
  const loc = useLocation();
  const home = slug ? `/${slug}` : '/';
  if (!ready) {
    return (
      <div className="loading">
        <div className="spin" />
      </div>
    );
  }
  if (!user) return <Navigate to={storePath(slug, '/login')} replace />;
  if (user.role === 'kds' && !loc.pathname.endsWith('/kds')) return <Navigate to={storePath(slug, '/kds')} replace />;
  if (user.role === 'display' && !loc.pathname.endsWith('/display')) return <Navigate to={storePath(slug, '/display')} replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={home} replace />;
  return children;
}

function Shell() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/orders" element={<Orders />} />
        <Route path="/tables" element={<Tables />} />
        <Route path="/menu" element={<Guard roles={['admin']}><Menu /></Guard>} />
        <Route path="/modifiers" element={<Guard roles={['admin']}><Modifiers /></Guard>} />
        <Route path="/discounts" element={<Guard roles={['admin']}><Discounts /></Guard>} />
        <Route path="/inventory" element={<Guard roles={['admin']}><Inventory /></Guard>} />
        <Route path="/loyalty" element={<Guard roles={['admin']}><Loyalty /></Guard>} />
        <Route path="/users" element={<Guard roles={['admin']}><Users /></Guard>} />
        <Route path="/qr-codes" element={<Guard roles={['admin']}><QRCodes /></Guard>} />
        <Route path="/branches" element={<Guard roles={['admin']}><Branches /></Guard>} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/cash-drawer" element={<CashDrawer />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Guard roles={['admin']}><Settings /></Guard>} />
        <Route path="/printers" element={<Guard roles={['admin']}><Printers /></Guard>} />
        <Route path="/translations" element={<Guard roles={['admin']}><StoreTranslations /></Guard>} />
        <Route path="/integrations" element={<Guard roles={['admin']}><Integrations /></Guard>} />
        <Route path="/data" element={<Guard roles={['admin']}><DataCenter /></Guard>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

// The whole existing app, mounted under the store's own URL.
//
// Sign-in and activation must work for a store that is not live yet, otherwise
// an owner who has just registered has no way in and nowhere to type their key.
// Only the rest of the app is gated on the store being active.
function StoreApp() {
  const { slug, status, ready, contactEmail, daysLeft, onTrial, trialEnded } = useStore();
  if (!ready) {
    return (
      <div className="loading">
        <div className="spin" />
      </div>
    );
  }
  if (status === 'missing') {
    return (
      <Waiting
        slug={slug}
        status="missing"
      />
    );
  }

  const suspended = status === 'suspended';
  const live = status === 'active';
  return (
    <AuthProvider>
      <I18nBridge>
        <BranchProvider slug={slug}>
          <ToastProvider>
            <CookieConsentProvider>
            <ErrorBoundary>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/kds" element={live ? <Guard><KDS /></Guard> : <Waiting slug={slug} status={status} />} />
                <Route path="/display" element={live ? <Guard roles={['display']}><Display /></Guard> : <Waiting slug={slug} status={status} />} />
                {/* A suspended shop keeps its pages but every call is refused by
                    the server, so show why rather than an empty shell. */}
                <Route
                  path="/order/:token"
                  element={live ? <PublicOrder /> : <Waiting slug={slug} status={status} />}
                />
                <Route
                  path="/receipt/:token"
                  element={live ? <Receipt /> : <Waiting slug={slug} status={status} />}
                />
                <Route path="/*" element={live
                  ? <Guard><Shell /></Guard>
                  : <Waiting slug={slug} status={status} />} />
              </Routes>
            </ErrorBoundary>
            </CookieConsentProvider>
          </ToastProvider>
        </BranchProvider>
      </I18nBridge>
    </AuthProvider>
  );
}

// The chosen branch has to reach the API client before any child effect makes a
// request, so the binding lives above the store's routes.
function BranchBinder({ children }) {
  const { slug } = useStore();
  const { branchId } = useBranch();
  useEffect(() => {
    setApiStore(slug, branchId == null ? '' : branchId);
  }, [slug, branchId]);
  return children;
}

// The card a shop that is not trading yet lands on.
//
// A self-hosted install has exactly one shop, created live, so in practice this
// only appears for a shop that was deliberately suspended. There is no key form
// here and no "I have an activation key" link: activation is not a thing on this
// install, and a screen that offers it is offering something the server answers
// with a 404.
function Waiting({ slug, contactEmail, status, trialEnded }) {
  const suspended = status === 'suspended';
  const { user } = useAuth();
  return (
    <div className="activate-wrap">
      <div className="activate-card">
        <h1>{suspended ? 'This shop is paused' : 'Not set up yet'}</h1>
        <p className="sub">
          {suspended
            ? `The shop at /${slug} has been paused, so it cannot be used. Nothing has been deleted.`
            : `There is no shop at /${slug} yet. Open the main site and use the Set up tab to create one.`}
        </p>
        <div className="waiting-actions">
          {suspended
            ? <a className="btn primary wide" href={`/${slug}/login`}>Sign in</a>
            : <a className="btn primary wide" href="/">Set up this install</a>}
        </div>
        <div className="activate-foot">
          {user ? <span className="link muted-as">Signed in as {user.username}</span> : <a className="link" href={`/${slug}/login`}>Sign in</a>}
          <a className="link" href="/">Back to the main site</a>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    // Contact details are set by the platform admin, so they are fetched rather
    // than compiled in, and shared through context so every screen picks up a
    // change as soon as it is saved.
    <PlatformConfigProvider>
    <Routes>
      {/* The main page advertises the platform and is where every store signs in. */}
      <Route path="/" element={<Landing />} />
      {/* The privacy notice is public and bilingual, because a notice a
          customer cannot read is not a notice. */}
      <Route path="/privacy" element={<Privacy />} />
      {/* The console is outside every provider, so it gets its own boundary: a
          crash there used to leave a blank white page with nothing to go on. */}
      <Route path="/platform" element={<ErrorBoundary><PlatformConsole /></ErrorBoundary>} />
      <Route path="/platform/*" element={<ErrorBoundary><PlatformConsole /></ErrorBoundary>} />

      {/* Everything else belongs to one store. */}
      <Route
        path="/:storeId/*"
        element={(
          <StoreProvider>
            <BrandingProvider>
              <BranchBinder>
                <StoreApp />
              </BranchBinder>
            </BrandingProvider>
          </StoreProvider>
        )}
      />
    </Routes>
    </PlatformConfigProvider>
  );
}

// Admin sees the dashboard; cashier mode shows the large-button home screen.
function Home() {
  const { mode } = useUiMode();
  return mode === 'cashier' ? <CashierHome /> : <Dashboard />;
}

// Feeds the signed-in user's own language into I18nProvider and saves changes to their profile.
function I18nBridge({ children }) {
  const { user, setUser } = useAuth();
  const saveLanguage = useCallback(async (language) => {
    try {
      const d = await put('/auth/language', { language });
      api.setSession(api.token, d.user);
      setUser(d.user);
    } catch (e) { /* keep the local choice for this session */ }
  }, [setUser]);
  return (
    <I18nProvider authed={!!user} userLang={user?.language || null} onUserLangChange={saveLanguage}>
      {children}
    </I18nProvider>
  );
}