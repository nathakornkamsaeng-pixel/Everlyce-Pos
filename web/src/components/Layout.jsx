import React, { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, ClipboardList, Table2, UtensilsCrossed,
  SlidersHorizontal, Tag, Boxes, Heart, Users, QrCode, Timer, Banknote,
  BarChart3, Settings, LogOut, Languages, Grid3x3, ArrowLeft, ClipboardPen, Database, Printer,
  Building2, ChevronDown, Check,
} from 'lucide-react';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { useBranding, brand, BrandLogo } from '../branding';
import { useStore, storePath } from '../lib/store';
import Clock from './Clock';
import LangSwitch from './LangSwitch';
import BranchPicker from './BranchPicker';

const NAV = [
  { group: 'Operations', items: [
    { to: '/', label: 'Dashboard', Icon: LayoutDashboard, end: true, roles: ['admin', 'cashier'] },
    { to: '/checkout', label: 'Checkout', Icon: ShoppingCart, roles: ['admin', 'cashier'] },
    { to: '/orders', label: 'Orders', Icon: ClipboardList, roles: ['admin', 'cashier'] },
    { to: '/tables', label: 'Tables', Icon: Table2, roles: ['admin', 'cashier'] },
  ]},
  { group: 'Restaurant', items: [
    { to: '/menu', label: 'Menu', Icon: UtensilsCrossed, roles: ['admin'] },
    { to: '/modifiers', label: 'Modifiers', Icon: SlidersHorizontal, roles: ['admin'] },
    { to: '/inventory', label: 'Inventory', Icon: Boxes, roles: ['admin'] },
  ]},
  { group: 'Engagement', items: [
    { to: '/discounts', label: 'Discounts', Icon: Tag, roles: ['admin'] },
    { to: '/loyalty', label: 'Loyalty', Icon: Heart, roles: ['admin'] },
    { to: '/qr-codes', label: 'QR Codes', Icon: QrCode, roles: ['admin'] },
  ]},
  { group: 'Management', items: [
    { to: '/branches', label: 'Branches', Icon: Building2, roles: ['admin'] },
    { to: '/sessions', label: 'Sessions', Icon: Timer, roles: ['admin', 'cashier'] },
    { to: '/cash-drawer', label: 'Cash Drawer', Icon: Banknote, roles: ['admin', 'cashier'] },
    { to: '/reports', label: 'Reports', Icon: BarChart3, roles: ['admin', 'cashier'] },
    { to: '/kds', label: 'Kitchen Display', Icon: ClipboardList, roles: ['admin', 'cashier'] },
    { to: '/users', label: 'Users', Icon: Users, roles: ['admin'] },
    { to: '/data', label: 'Data', Icon: Database, roles: ['admin'] },
    { to: '/printers', label: 'Printers', Icon: Printer, roles: ['admin'] },
    { to: '/translations', label: 'Menu translations', Icon: Languages, roles: ['admin'] },
    { to: '/settings', label: 'Settings', Icon: Settings, roles: ['admin'] },
  ]},
];

const MODE_KEY = 'pos_ui_mode';

const PAGE_TITLES = {
  '/': 'Home',
  '/checkout': 'Checkout',
  '/orders': 'Orders',
  '/tables': 'Tables',
  '/branches': 'Branches',
  '/sessions': 'Sessions',
  '/cash-drawer': 'Cash Drawer',
  '/reports': 'Reports',
  '/kds': 'Kitchen Display',
  '/menu': 'Menu',
  '/modifiers': 'Modifiers',
  '/inventory': 'Inventory',
  '/discounts': 'Discounts',
  '/loyalty': 'Loyalty',
  '/qr-codes': 'QR Codes',
  '/users': 'Users',
  '/data': 'Data',
  '/settings': 'Settings',
};
const pageTitle = (path) => PAGE_TITLES[path] || 'POS';

// Lets pages react to cashier vs management mode (e.g. the home screen).
const UiCtx = createContext({ mode: 'management', openMenu: () => {}, isAdmin: false });
export const useUiMode = () => useContext(UiCtx);

export default function Layout({ children }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const { name: brandName } = useBranding();
  const { slug, base } = useStore();
  const nav = useNavigate();
  const loc = useLocation();
  const isAdmin = user?.role === 'admin';
  const isCashier = user?.role === 'cashier';

  // Every internal link and redirect stays inside this shop's URL space, which on
  // a single-shop install is the root of the host. base carries the old prefix
  // only when the page was reached through it, so an old link keeps working and
  // keeps its own shape.
  const go = (path) => nav(storePath(slug, path, base));
  const at = (path) => storePath(slug, path, base);
  const here = (path) => loc.pathname === at(path) || loc.pathname === `${at(path)}/`;
  // The part of the path after the prefix, for the breadcrumb. With no prefix
  // this is the path itself, which is why the slice is guarded rather than
  // assumed: `/${slug}` on an empty slug would slice to '' and show nothing.
  const prefixed = Boolean(base) && loc.pathname.startsWith(base);
  const tail = prefixed ? loc.pathname.slice(base.length) || '/' : loc.pathname;

  const [mode, setMode] = useState(() => {
    if (isCashier) return 'cashier';
    try { return localStorage.getItem(MODE_KEY) === 'cashier' ? 'cashier' : 'management'; } catch (e) { return 'management'; }
  });
  const [drawer, setDrawer] = useState(false);
  const [menu, setMenu] = useState(false);

  // Cashiers are always in cashier mode; admins remember their choice.
  useEffect(() => {
    if (isCashier) setMode('cashier');
  }, [isCashier]);

  function switchMode(next) {
    setMode(next);
    setMenu(false);
    setDrawer(false);
    try { localStorage.setItem(MODE_KEY, next); } catch (e) {}
    if (next === 'cashier') {
      // Always land on the big-button home when entering cashier mode.
      if (tail !== '/') go('/');
    } else if (['/checkout', '/orders', '/tables', '/'].includes(tail)) {
      go('/menu');
    }
  }

  const groups = NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(user?.role)) }))
    .filter((g) => g.items.length > 0);

  /* ---------------- Cashier mode: touch buttons, no sidebar ---------------- */
  if (mode === 'cashier') {
    const onHome = tail === '/';
    const ctx = { mode, openMenu: () => setMenu(true), isAdmin, exitToManagement: () => switchMode('management') };
    return (
      <UiCtx.Provider value={ctx}>
      <div className={`pos-scope cashier-shell${onHome ? ' is-home' : ''}`}>
        {!onHome && (
          <div className="tk-navbar">
            <button className="tk-back" onClick={() => go('/')} aria-label={t('Back')}>
              <ArrowLeft size={22} />
              <span>{t('Back')}</span>
            </button>
            <BrandLogo size={32} />
            <div className="tk-crumb">{t(pageTitle(tail))}</div>
            <Clock />
          </div>
        )}

        <main className="cashier-main">{children}</main>

        {onHome && (
          <div className="tk-statusbar">
            <span className="cashier-brand"><BrandLogo size={24} /><strong>{brand(brandName)}</strong></span>
            <span>· {user?.name} · {user?.role}</span>
            <span className="tk-spring" />
            {isAdmin && (
              <button className="tk-exit" onClick={() => switchMode('management')}>
                <ClipboardPen size={14} /> {t('Management')}
              </button>
            )}
          </div>
        )}

        {!onHome && isAdmin && (
          <button className="tk-exit-float" onClick={() => switchMode('management')} title={t('Back to management')}>
            <ClipboardPen size={16} /> {t('Management')}
          </button>
        )}

        {menu && (
          <div className="menu-overlay" role="dialog" aria-label={t('Menu')}>
            <div className="menu-top">
              <div className="menu-brand">
                <BrandLogo size={42} />
                <div>
                  <div className="menu-title">{brand(brandName)}</div>
                  <div className="menu-sub">{t('Menu')} · {user?.name} · {user?.role}</div>
                </div>
              </div>
              <button className="tk-back" onClick={() => setMenu(false)}><ArrowLeft size={20} /><span>{t('Close')}</span></button>
            </div>
            <div className="menu-scroll">
              {groups.map((g) => (
                <div className="menu-section" key={g.group}>
                  <div className="menu-section-title">{t(g.group)}</div>
                  <div className="menu-grid">
                    {g.items.map((n) => (
                      <button key={n.to} className="menu-tile" onClick={() => { setMenu(false); go(n.to); }}>
                        <span className="tile-icon"><n.Icon size={20} /></span>
                        <span className="tile-label">{t(n.label)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <div className="menu-section">
                <div className="menu-section-title">{t('Account')}</div>
                <div className="menu-grid">
                  <div className="menu-tile" style={{ cursor: 'default' }}>
                    <span className="tile-icon"><Languages size={20} /></span>
                    <span className="tile-label"><LangSwitch /></span>
                  </div>
                  <button className="menu-tile" onClick={logout}>
                    <span className="tile-icon" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}><LogOut size={22} /></span>
                    <span className="tile-label">{t('Sign out')}</span>
                  </button>
                  {isAdmin && (
                    <button className="menu-tile" onClick={() => switchMode('management')}>
                      <span className="tile-icon"><ClipboardPen size={22} /></span>
                      <span className="tile-label">{t('Management')}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      </UiCtx.Provider>
    );
  }

  /* ---------------- Management mode: sidebar ---------------- */
  return (
    <>
      <div className={`scrim${drawer ? ' show' : ''}`} onClick={() => setDrawer(false)} />
      <div className="layout">
        <aside className={`sidebar${drawer ? ' open' : ''}`}>
          <div className="brand">
            <BrandLogo size={38} />
            <div className="titles">
              <strong>{brand(brandName)}</strong>
              <span>{t('Management')}</span>
            </div>
          </div>
          <nav className="nav">
            {groups.map((g) => (
              <React.Fragment key={g.group}>
                <div className="nav-group">{t(g.group)}</div>
                {g.items.map((n) => (
                  <NavLink key={n.to} to={at(n.to)} end={n.end} onClick={() => setDrawer(false)}>
                    <n.Icon />
                    {t(n.label)}
                  </NavLink>
                ))}
              </React.Fragment>
            ))}
          </nav>
          <div className="foot">
            {isAdmin && (
              <button className="side-mode" onClick={() => switchMode('cashier')} title={t('Switch to the touch-first cashier view')}>
                <Grid3x3 size={16} /> {t('Cashier view')}
              </button>
            )}
            <div className="foot-row">
              <div className="who">
                <strong>{user?.name}</strong>
                <small>{user?.role}</small>
              </div>
              <button className="btn-link" onClick={logout} title={t('Sign out')} aria-label={t('Sign out')}><LogOut /></button>
            </div>
          </div>
        </aside>

        <div className="main">
          <div className="mobile-bar">
            <button className="hamburger" onClick={() => setDrawer(true)} aria-label={t('Open menu')}><Grid3x3 /></button>
            <div className="m-brand"><BrandLogo size={28} /><span>{brand(brandName)}</span></div>
            <BranchPicker compact />
            <LangSwitch className="m-lang" />
            {isAdmin && (
              <button className="btn sm m-mode" onClick={() => switchMode('cashier')}>{t('Cashier')}</button>
            )}
          </div>
          <BranchPicker />
          {children}
        </div>
      </div>
    </>
  );
}