import React, { useEffect, useState } from 'react';
import { get, fmtDateTime } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { StatusBadge } from '../components/ui';
import { useI18n } from '../i18n';

export default function Dashboard() {
  const { t, lang } = useI18n();
  const [d, setD] = useState(null);
  useEffect(() => {
    get('/dashboard').then(setD).catch(() => {});
  }, []);

  if (!d) return <div className="loading"><div className="spin" /></div>;

  return (
    <>
      <div className="topbar">
        <div className="page-heading">
          <h1>{t('Dashboard')}</h1>
        </div>
      </div>
      <div className="content">
        <div className="grid cols-4">
          <div className="card stat"><div className="label">{t('Total revenue')}</div><div className="value">{fmtMoney(d.totalRevenue)}</div><div className="sub">{t('Across all time')}</div></div>
          <div className="card stat"><div className="label">{t('Today')}</div><div className="value">{fmtMoney(d.todayRevenue)}</div><div className="sub">{d.todayOrderCount} orders today</div></div>
          <div className="card stat"><div className="label">{t('Completed orders')}</div><div className="value">{d.completedOrders}</div><div className="sub">Avg. {fmtMoney(d.avgOrderValue)} per order</div></div>
          <div className="card stat"><div className="label">{t('Active orders')}</div><div className="value">{d.activeOrders}</div><div className="sub">{d.voidedOrders} voided</div></div>
        </div>

        <div className="grid cols-3 mt">
          <div className="card">
            <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Status breakdown')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {Object.entries(d.statusBreakdown).map(([k, v]) => (
                <div key={k} className="spread">
                  <StatusBadge status={k} />
                  <strong>{v}</strong>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Payments')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
              {Object.entries(d.paymentMethods).length === 0 && <div className="muted">{t('No payments yet')}</div>}
              {Object.entries(d.paymentMethods).map(([k, v]) => (
                <div key={k} className="spread"><span className="badge blue">{k}</span><strong>{fmtMoney(v)}</strong></div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Top items')}</div>
            <div style={{ marginTop: 12 }}>
              {d.topItems.map((row) => (
                <div key={row.name} className="spread" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                  <span>{t(row.name)} <span className="muted">×{row.qty}</span></span>
                  <strong>{fmtMoney(row.revenue)}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="card mt">
          <div className="section-title mb0">{t('Recent orders')}</div>
          <div className="table-wrap mt">
            <table className="data">
              <thead><tr><th>{t('Order')}</th><th>{t('Table')}</th><th>{t('Status')}</th><th>{t('Payment')}</th><th className="num">{t('Total')}</th><th>{t('Placed')}</th></tr></thead>
              <tbody>
                {d.recentOrders.length === 0 && <tr><td colSpan={6} className="muted">{t('No orders yet')}</td></tr>}
                {d.recentOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="mono">{o.orderNumber}</td>
                    <td>{o.tableName || '—'}</td>
                    <td><StatusBadge status={o.paymentStatus === 'paid' ? o.status : o.status} /></td>
                    <td>{o.paymentStatus === 'paid' ? <span className="badge green">paid · {o.paymentMethod}</span> : <span className="badge gray">{t('unpaid')}</span>}</td>
                    <td className="num">{fmtMoney(o.total)}</td>
                    <td className="muted">{fmtDateTime(o.createdAt, lang)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
