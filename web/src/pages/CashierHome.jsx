import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ShoppingCart, Table2, ClipboardList, Grid3x3 } from 'lucide-react';
import { useUiMode } from '../components/Layout';
import { useI18n } from '../i18n';
import { useStore, storePath } from '../lib/store';

// The cashier's entire home screen: a few very large targets and nothing else.
const BUTTONS = [
  { to: '/checkout', label: 'Checkout', hint: 'New order & payment', Icon: ShoppingCart },
  { to: '/tables', label: 'Tables', hint: 'Open a table · show QR', Icon: Table2 },
  { to: '/orders', label: 'Orders', hint: 'View & pay orders', Icon: ClipboardList },
  { all: true, label: 'All', hint: 'Everything else', Icon: Grid3x3 },
];

export default function CashierHome() {
  const nav = useNavigate();
  const { slug } = useStore();
  const { openMenu } = useUiMode();
  const { t } = useI18n();

  return (
    <div className="cashier-home">
      <div className="home-grid">
        {BUTTONS.map((b) => (
          <button
            key={b.label}
            type="button"
            className={`home-btn ${b.all ? 'all' : ''}`}
            onClick={() => (b.all ? openMenu() : nav(storePath(slug, b.to)))}
          >
            <span className="home-icon"><b.Icon size={40} strokeWidth={1.7} /></span>
            <span className="home-text">
              <span className="home-label">{t(b.label)}</span>
              <span className="home-hint">{t(b.hint)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}