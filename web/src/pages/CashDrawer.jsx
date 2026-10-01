import React, { useEffect, useState } from 'react';
import { get, post, fmtDateTime } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { Modal, StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function CashDrawer() {
  const { t, lang } = useI18n();
  const [sessions, setSessions] = useState([]);
  const [active, setActive] = useState(null);
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const [showClose, setShowClose] = useState(false);
  const toast = useToast();

  function load() {
    get('/cash-sessions').then(setSessions).catch(() => {});
    get('/cash-sessions/active').then(setActive).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function openSession() {
    try {
      await post('/cash-sessions', { openingAmount: opening ? Number(opening) : 0 });
      toast(t('Cash drawer opened'), 'ok'); setOpening(''); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function closeSession() {
    try {
      await post(`/cash-sessions/${active.id}/close`, { closingAmount: closing ? Number(closing) : 0 });
      toast(t('Cash drawer closed'), 'ok'); setClosing(''); setShowClose(false); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  return (
    <>
      <div className="topbar"><h1>{t('Cash Drawer')}</h1></div>
      <div className="content">
        <div className="grid cols-2">
          {active ? (
            <div className="card stat">
              <div className="label">{t('Session open')}</div>
              <div className="value">{fmtMoney(active.openingAmount)}</div>
              <div className="sub">{t('opened')} {fmtDateTime(active.openedAt, lang)} {t('by')} {active.openedByUsername}</div>
              <button className="btn mt" onClick={() => setShowClose(true)}>{t('Close drawer')}</button>
            </div>
          ) : (
            <div className="card">
              <div className="section-title mb0">{t('Open cash drawer')}</div>
              <div className="row mt">
                <input style={{ flex: 1, padding: 9, border: '1px solid var(--border)', borderRadius: 9 }} type="number" placeholder={t('Opening float')} value={opening} onChange={(e) => setOpening(e.target.value)} />
                <button className="btn primary" onClick={openSession}>{t('Open')}</button>
              </div>
            </div>
          )}
        </div>

        <div className="card mt">
          <div className="section-title mb0">{t('History')}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Opened')}</th><th>{t('By')}</th><th className="num">{t('Opening')}</th><th className="num">{t('Expected')}</th><th className="num">{t('Counted')}</th><th className="num">{t('Variance')}</th><th>{t('Status')}</th><th>{t('Closed')}</th></tr></thead>
              <tbody>
                {sessions.length === 0 && <tr><td colSpan={8} className="muted">{t('No cash sessions recorded.')}</td></tr>}
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{new Date(s.openedAt).toLocaleString()}</td>
                    <td>{s.openedByUsername}</td>
                    <td className="num">{fmtMoney(s.openingAmount)}</td>
                    <td className="num">{s.expectedAmount !== null ? fmtMoney(s.expectedAmount) : '—'}</td>
                    <td className="num">{s.closingAmount !== null ? fmtMoney(s.closingAmount) : '—'}</td>
                    <td className="num">{s.expectedAmount !== null && s.closingAmount !== null ? fmtMoney(s.closingAmount - s.expectedAmount) : '—'}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="muted">{s.closedAt ? new Date(s.closedAt).toLocaleString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {showClose && (
        <Modal title={t('Close cash drawer')} onClose={() => setShowClose(false)}
          footer={<><button className="btn" onClick={() => setShowClose(false)}>{t('Cancel')}</button><button className="btn primary" onClick={closeSession}>{t('Close')}</button></>}>
          <p className="muted">{t('Expected:')} <strong>{fmtMoney(active.expectedAmount || 0)}</strong></p>
          <div className="field"><label>{t('Counted amount')}</label><input type="number" value={closing} onChange={(e) => setClosing(e.target.value)} autoFocus /></div>
        </Modal>
      )}
    </>
  );
}