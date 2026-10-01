import React, { useEffect, useState } from 'react';
import { get, post, fmtDateTime } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function Sessions() {
  const { t, lang } = useI18n();
  const [sessions, setSessions] = useState([]);
  const toast = useToast();
  function load() { get('/sessions').then(setSessions).catch(() => {}); }
  useEffect(() => { load(); }, []);

  async function close(s) {
    try { await post(`/sessions/${s.id}/close`, {}); toast(t('Session closed'), 'ok'); load(); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  return (
    <>
      <div className="topbar"><h1>{t('Sessions')}</h1></div>
      <div className="content">
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>{t('Table')}</th><th>{t('Opened')}</th><th>{t('Guests')}</th><th>{t('Orders')}</th><th className="num">{t('Total')}</th><th>{t('Status')}</th><th></th></tr></thead>
              <tbody>
                {sessions.length === 0 && <tr><td colSpan={8} className="muted">{t('No sessions yet.')}</td></tr>}
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="muted">#{s.id}</td>
                    <td><strong>{s.tableName || `Table ${s.tableId}`}</strong></td>
                    <td>{fmtDateTime(s.openedAt, lang)}</td>
                    <td>{s.guestCount}</td>
                    <td>{s.orderCount || (s.orders?.length || 0)}</td>
                    <td className="num">{fmtMoney(s.total || 0)}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="num">{s.status === 'open' && <button className="btn sm" onClick={() => close(s)}>{t('Close')}</button>}</td>
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