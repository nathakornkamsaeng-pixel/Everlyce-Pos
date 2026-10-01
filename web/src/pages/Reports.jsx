import React, { useEffect, useState } from 'react';
import { get } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { useI18n } from '../i18n';

export default function Reports() {
  const { t } = useI18n();
  const [sales, setSales] = useState(null);
  const [top, setTop] = useState([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function load() {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const qs = q.toString();
    get(`/reports/sales${qs ? `?${qs}` : ''}`).then(setSales).catch(() => {});
    get('/reports/top-items').then(setTop).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  if (!sales) return <div className="loading"><div className="spin" /></div>;

  const days = Object.entries(sales.byDay).sort((a, b) => a[0].localeCompare(b[0]));
  const maxDay = Math.max(1, ...days.map(([, v]) => v.revenue));

  return (
    <>
      <div className="topbar">
        <h1>{t('Reports')}</h1>
        <div className="row">
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setTimeout(load, 0); }} />
          <input type="date" value={to} onChange={(e) => { setTo(e.target.value); setTimeout(load, 0); }} />
        </div>
      </div>
      <div className="content">
        <div className="grid cols-4">
          <div className="card stat"><div className="label">{t('Revenue')}</div><div className="value">{fmtMoney(sales.totalRevenue)}</div><div className="sub">{sales.orderCount} orders</div></div>
          <div className="card stat"><div className="label">{t('Avg order')}</div><div className="value">{fmtMoney(sales.avgOrderValue)}</div></div>
          <div className="card stat"><div className="label">{t('Tax collected')}</div><div className="value">{fmtMoney(sales.totalTax)}</div></div>
          <div className="card stat"><div className="label">{t('Discounts')}</div><div className="value">{fmtMoney(sales.totalDiscounts)}</div></div>
        </div>

        <div className="grid cols-2 mt">
          <div className="card">
            <div className="section-title mb0">{t('Daily revenue')}</div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 150, marginTop: 14 }}>
              {days.map(([day, v]) => (
                <div key={day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <span className="muted" style={{ fontSize: 11.5 }}>{Math.round(v.revenue)}</span>
                  <div style={{ width: '70%', background: 'var(--accent)', borderRadius: 6, height: Math.max(4, (v.revenue / maxDay) * 100) }} />
                  <span className="muted" style={{ fontSize: 11 }}>{day.slice(5)}</span>
                </div>
              ))}
              {days.length === 0 && <div className="muted">{t('No sales in range.')}</div>}
            </div>
          </div>
          <div className="card">
            <div className="section-title mb0">{t('By payment method')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 14 }}>
              {Object.entries(sales.paymentMethods).length === 0 && <div className="muted">{t('No payments.')}</div>}
              {Object.entries(sales.paymentMethods).map(([m, v]) => (
                <div key={m}>
                  <div className="spread"><span className="badge blue">{m}</span><strong>{fmtMoney(v)}</strong></div>
                  <div style={{ background: 'var(--border)', borderRadius: 6, height: 8, marginTop: 6 }}>
                    <div style={{ background: 'var(--accent)', height: 8, borderRadius: 6, width: `${sales.totalRevenue ? (v / sales.totalRevenue) * 100 : 0}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card mt">
          <div className="section-title mb0">{t('Top items')}</div>
          <div className="table-wrap mt">
            <table className="data">
              <thead><tr><th>#</th><th>{t('Item')}</th><th className="num">{t('Qty')}</th><th className="num">{t('Revenue')}</th></tr></thead>
              <tbody>
                {top.map((row, i) => (
                  <tr key={row.name}><td className="muted">{i + 1}</td><td><strong>{t(row.name)}</strong></td><td className="num">{row.qty}</td><td className="num">{fmtMoney(row.revenue)}</td></tr>
                ))}
                {top.length === 0 && <tr><td colSpan={4} className="muted">{t('No data yet.')}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}