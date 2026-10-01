import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, put } from '../lib/api';
import { useToast } from '../components/Toast';
import { Empty } from '../components/ui';
import { useAuth } from '../auth';
import { ClipboardList, LogOut, ArrowLeft, Check, Timer } from 'lucide-react';
import { useI18n } from '../i18n';
import { useBranding, brand, BrandLogo } from '../branding';
import { useStore, storePath } from '../lib/store';
import LangSwitch from '../components/LangSwitch';
import Clock from '../components/Clock';

const MIN = 60 * 1000;

function elapsed(from, now) {
  if (!from) return '';
  const ms = Math.max(0, now - new Date(from).getTime());
  const m = Math.floor(ms / MIN);
  const s = Math.floor((ms % MIN) / 1000);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function KDS() {
  const [data, setData] = useState({ active: [], overdueMinutes: 15 });
  const [stats, setStats] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const { name: brandName } = useBranding();
  const { slug, base } = useStore();
  const nav = useNavigate();

  const load = useCallback(() => {
    get('/kds/orders').then(setData).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const poll = setInterval(load, 4000);
    const statsPoll = setInterval(() => { get('/kds/stats').then(setStats).catch(() => {}); }, 30000);
    get('/kds/stats').then(setStats).catch(() => {});
    return () => { clearInterval(poll); clearInterval(statsPoll); };
  }, [load]);

  // tick the clocks once a second
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  async function done(o) {
    setBusyId(o.id);
    try {
      // The server only allows one legal step at a time, so walk the ticket
      // through to the finished state. That drops it off this board.
      if (o.status === 'pending') {
        await put(`/orders/${o.id}/status`, { status: 'preparing' });
      }
      await put(`/orders/${o.id}/status`, { status: 'ready' });
      load();
    }
    catch (e) { toast(t(e.message), 'error'); }
    finally { setBusyId(null); }
  }

  const limitMs = (Number(data.overdueMinutes) || 15) * MIN;
  const isKdsOnly = user?.role === 'kds';

  return (
    <div className="pos-scope kds-shell">
      <div className="tk-navbar">
        {!isKdsOnly ? (
          <button className="tk-back" onClick={() => nav(storePath(slug, '/', base))} aria-label={t('Back')}>
            <ArrowLeft size={22} /><span>{t('Back')}</span>
          </button>
        ) : (
          <span className="kds-brand"><BrandLogo size={38} /></span>
        )}
        <div className="tk-brand-name">{brand(brandName)}</div>
        <div className="tk-crumb">{t('Kitchen Display')}</div>
        <span className="tk-spring" />
        <div className="kds-stats">
          <span className="kds-stat"><b>{data.active.length}</b> {t('preparing')}</span>
          {stats && stats.todayCount > 0 && (
            <span className="kds-stat"><b>{elapsed(stats.todayAverageMs === null ? 0 : Date.now() - stats.todayAverageMs, now)}</b> {t('avg today')}</span>
          )}
        </div>
        <Clock />
        <LangSwitch className="tk-lang" />
        <button className="tk-exit" onClick={logout}><LogOut size={14} /> {t('Sign out')}</button>
      </div>

      <div className="kds-body">
        {data.active.length === 0 ? (
          <Empty icon={ClipboardList} title={t('No orders waiting')}>{t('New orders from the front of house appear here.')}</Empty>
        ) : (
          <div className="kds-cols">
            <section className="kds-col">
              <div className="kds-col-head prep">{t('preparing')} <span>{data.active.length}</span></div>
              <div className="kds-list">
              {data.active.map((o) => {
                const ms = now - new Date(o.startedAt || o.createdAt).getTime();
                const late = ms > limitMs;
                return (
                  <div key={o.id} className={`kds-card ${late ? 'late' : 'cooking'}`}>
                    <div className="kds-head">
                      <div>
                        <strong>{o.orderNumber}</strong>
                        <div className="muted">{o.tableName || t('Takeaway')}{o.customerName ? ` · ${o.customerName}` : ''}</div>
                      </div>
                      <span className={`kds-timer${late ? ' late' : ''}`}><Timer size={15} /> {elapsed(o.startedAt || o.createdAt, now)}</span>
                    </div>
                    <div className="kds-items">
                      {o.items.map((it) => (
                        <div key={it.id} className="kds-item">
                          <div>
                            <strong><span className="kds-qty">{it.quantity}×</span> {t(it.productName)}</strong>
                            {it.modifiers?.map((m, i) => <span key={i} className="mod">+ {t(m.group)}: {t(m.option)}</span>)}
                            {it.notes && <span className="mod">“{it.notes}”</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="kds-actions">
                      <button className="btn done-btn" onClick={() => done(o)} disabled={busyId === o.id}>
                        <Check size={18} /> {busyId === o.id ? '…' : t('done')}
                      </button>
                    </div>
                  </div>
                );
              })}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
