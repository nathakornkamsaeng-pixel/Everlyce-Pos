import React, { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { useAuth } from '../auth';
import { MonitorSmartphone, LogOut } from 'lucide-react';
import { useI18n } from '../i18n';
import { useBranding, brand, BrandLogo } from '../branding';
import QrView from '../components/QrView';

export default function Display() {
  const [data, setData] = useState(null);
  const [offline, setOffline] = useState(false);
  const [lastUpdate, setLastUpdate] = useState(0);
  const { user, logout } = useAuth();
  const { t, setLanguage } = useI18n();
  const { name: brandName } = useBranding();

  useEffect(() => {
    let alive = true;
    let busy = false;
    async function load() {
      if (busy) return;
      busy = true;
      try {
        const d = await get('/display/current');
        if (alive) { setData(d); setOffline(false); setLastUpdate(Date.now()); }
      } catch (e) {
        if (alive) setOffline(true);
      } finally {
        busy = false;
      }
    }
    load();
    const poll = setInterval(load, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      alive = false;
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  useEffect(() => {
    if (data?.settings?.cdsLanguage) setLanguage(data.settings.cdsLanguage);
  }, [data?.settings?.cdsLanguage, setLanguage]);

  if (offline) {
    return (
      <div className="display-wrap">
        <div className="display-center">
          <h1>{t('Display disconnected')}</h1>
          <p className="muted">{t('Please check the connection and sign in again.')}</p>
          <button className="display-exit" onClick={logout} style={{ marginTop: 10 }}><LogOut size={15} /> {t('Sign out')}</button>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="display-wrap"><div className="display-center"><div className="spin" /></div></div>;
  }

  const { order, tableOrders = [], promptPay = null, receipt = null, settings = {}, cashier, table = null } = data || {};
  const name = brand(brandName || settings.restaurantName);
  const activePromptPay = order ? null : promptPay;

  const tableName = (order && order.tableName) || (table && table.name) || null;

  const combinedMap = new Map();
  for (const item of [...tableOrders, ...(activePromptPay?.orders || []), ...(order ? [order] : [])]) {
    combinedMap.set(item.id, {
      id: item.id,
      orderNumber: item.orderNumber,
      items: item.items,
      subtotal: item.subtotal,
      discount: item.discount,
      tax: item.tax,
      serviceCharge: item.serviceCharge,
      total: item.total,
    });
  }
  const combined = [...combinedMap.values()];

  const heading = combined.length === 0 ? null
    : tableName
      ? `${t('Table')} ${t(tableName)}`
      : (order && order.orderType === 'takeaway' ? t('Takeaway') : t('Order'));

  const sum = (key) => combined.reduce((s, o) => s + (Number(o[key]) || 0), 0);

  return (
    <div className="display-wrap">
      <header className="display-head">
        <div className="display-brand">
          <BrandLogo size={44} />
          <div>
            <div className="display-name">{name}</div>
            <div className="display-sub">{cashier ? `${t('Register')} · ${cashier.name}` : t('Not linked to a cashier')}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          <span className={`display-live${Date.now() - lastUpdate > 4000 ? ' lag' : ''}`} title={t('Live sync')}>
            <span className="dot" /> {t('live')}
          </span>
          {heading && <div className="display-table">{heading}</div>}
          <button className="display-exit" onClick={logout} title={t('Sign out')} aria-label={t('Sign out')}>
            <LogOut size={15} />
            <span>{t('Sign out')}</span>
          </button>
        </div>
      </header>

      {combined.length > 0 ? (
        <div className={`display-checkout${activePromptPay ? ' has-promptpay' : ''}`}>
          <div className="display-order-column">
            <div className="display-items">
            {combined.map((o) => (
              <React.Fragment key={o.id}>
                {combined.length > 1 && <div className="display-order-tag">{o.orderNumber}</div>}
                {o.items.map((i) => (
                  <div className="display-item" key={`${o.id}-${i.id}`}>
                    <div className="di-qty">{i.quantity}</div>
                    <div className="di-body">
                      <div className="di-name">{t(i.name)}</div>
                      {i.modifiers.length > 0 && <div className="di-mods">{i.modifiers.map((m, j) => <span key={j}>{m.option}</span>)}</div>}
                      {i.notes && <div className="di-note">{i.notes}</div>}
                    </div>
                    <div className="di-price">{fmtMoney(i.lineTotal)}</div>
                  </div>
                ))}
              </React.Fragment>
            ))}
          </div>
          <div className="display-totals">
            <div className="dt-row"><span>{t('Subtotal')}</span><span>{fmtMoney(sum('subtotal'))}</span></div>
            {sum('discount') > 0 && <div className="dt-row"><span>{t('Discount')}</span><span>-{fmtMoney(sum('discount'))}</span></div>}
            <div className="dt-row"><span>{t('Tax')} ({settings.taxRate}%)</span><span>{fmtMoney(sum('tax'))}</span></div>
            <div className="dt-row"><span>{t('Service charge')} ({settings.serviceChargeRate}%)</span><span>{fmtMoney(sum('serviceCharge'))}</span></div>
            <div className="dt-total"><span>{t('Total')}</span><span>{fmtMoney(sum('total'))}</span></div>
          </div>
          </div>
          {activePromptPay && (
            <div className="display-promptpay">
              <BrandLogo size={48} />
              <h2>PromptPay</h2>
              <QrView url={activePromptPay.payload} size={300} />
              <strong>{fmtMoney(activePromptPay.amount)}</strong>
              <span>{t('Scan with your Thai banking app')}</span>
              <small>{t('Waiting for cashier confirmation')}</small>
            </div>
          )}
        </div>
      ) : receipt ? (
        <div className="display-receipt">
          <BrandLogo size={64} />
          <h1>{t('Scan for your bill')}</h1>
          <p>{t('Download the receipt as a PDF or image')}</p>
          <QrView url={`${window.location.origin}/receipt/${receipt.token}`} size={300} />
          <strong>{receipt.orderNumber} · {fmtMoney(receipt.total)}</strong>
          <small>{t('This link expires in 7 days')}</small>
        </div>
      ) : (
        <div className="display-center">
          <MonitorSmartphone size={54} />
          <h1>{t('Ready to serve')}</h1>
          <p className="muted">{t('Your order will appear here as it is rung up.')}</p>
        </div>
      )}
    </div>
  );
}