import React, { useEffect, useState } from 'react';
import { get, post, del, fmtDateTime } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { Modal, Empty, StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import QrView, { downloadQr } from '../components/QrView';
import { Table2, Download, XCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import { useStore } from '../lib/store';

export default function Tables() {
  const { t, lang } = useI18n();
  const { slug } = useStore();
  const [tables, setTables] = useState([]);
  const [opening, setOpening] = useState(null);
  const [qr, setQr] = useState(null);
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const base = `${window.location.origin}/${slug}`;

  function load() { get('/tables').then(setTables).catch(() => {}); }
  useEffect(() => { load(); }, []);

  async function openSession() {
    setBusy(true);
    try {
      const s = await post('/sessions', { tableId: opening.id, guestCount: opening.guestCount });
      load();
      setOpening(null);
      setQr(s);
      toast(`${t(opening.name)} ${t('opened')}`, 'ok');
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  async function closeSession(s) {
    try {
      const closed = await post(`/sessions/${s.id}/close`, {});
      if (Number(closed.id) !== Number(s.id) || closed.status !== 'closed') throw new Error('Table session changed; refresh and try again');
      toast(t('Session closed · QR deactivated'), 'ok');
      setQr(null);
      setDetail(null);
      load();
    } catch (e) { toast(t(e.message), 'error'); load(); }
  }

  async function discardRegisterDraft(order) {
    if (!window.confirm(t('Discard this register ticket?'))) return;
    setBusy(true);
    try {
      await del(`/orders/${order.id}`);
      toast(t('Register ticket discarded'), 'ok');
      setDetail(null);
      load();
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  const unsavedDrafts = detail?.openDrafts?.filter((order) => order.itemCount > 0) || [];
  const detailCanClose = detail ? detail.canClose !== false : false;

  return (
    <>
      <div className="topbar">
        <h1>{t('Tables')}</h1>
        <div className="page-actions">
          <span className="muted" style={{ fontSize: 12.5 }}>{t('Configured in Settings')}</span>
        </div>
      </div>
      <div className="content">
        <p className="muted" style={{ marginTop: 0 }}>{t('Tap an available table to open it and generate its QR code. The code stays active only while the table is occupied.')}</p>
        <div className="floor">
          {tables.map((tbl) => (
            <div key={tbl.id} className={`ftable ${tbl.status}`} onClick={() => (tbl.status === 'occupied' ? setDetail(tbl) : setOpening({ id: tbl.id, name: tbl.name, guestCount: 1 }))}>
              <span className="dot" />
              <div>
                <div className="tname">{t(tbl.name)}</div>
                <div className="tmeta">{tbl.seats} {t('seat(s)')} · {t(tbl.status)}</div>
              </div>
              {tbl.session && (
                <div className="tmeta">{tbl.activeOrders.length} {t('open')} · {tbl.session.orderCount} {t('order(s)')}</div>
              )}
            </div>
          ))}
        </div>
        {tables.length === 0 && <Empty icon={Table2} title={t('No tables configured')}>{t('Add tables in Settings, then open them here.')}</Empty>}

        <div className="card mt">
          <div className="section-title mb0">{t('Occupied')}</div>
          {tables.filter((tbl) => tbl.status === 'occupied').length === 0 && <div className="muted mt">{t('No occupied tables.')}</div>}
          <div className="table-wrap mt">
            <table className="data">
              <thead><tr><th>{t('Table')}</th><th>{t('Guests')}</th><th>{t('Opened')}</th><th>{t('Orders')}</th><th className="num">{t('Total due')}</th><th></th></tr></thead>
              <tbody>
                {tables.filter((tbl) => tbl.status === 'occupied').map((tbl) => (
                  <tr key={tbl.id}>
                    <td><strong>{t(tbl.name)}</strong></td>
                    <td>{tbl.session.guestCount}</td>
                    <td className="muted">{fmtDateTime(tbl.session.openedAt, lang)}</td>
                    <td>{tbl.pendingOrderCount ?? tbl.activeOrders.length}</td>
                    <td className="num"><strong>{fmtMoney(tbl.pendingTotal ?? tbl.session.total)}</strong></td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setQr({ ...tbl.session, tableName: tbl.name })}>{t('Show QR')}</button>
                      <button className="btn sm" onClick={() => setDetail(tbl)}>{t('Manage')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {opening && (
        <Modal title={`${t('Open')} ${t(opening.name)}`} onClose={() => setOpening(null)}
          footer={<><button className="btn" onClick={() => setOpening(null)}>{t('Cancel')}</button><button className="btn primary" onClick={openSession} disabled={busy}>{busy ? t('Opening…') : t('Open & generate QR')}</button></>}>
          <p className="muted" style={{ marginTop: 0 }}>{t('A unique QR code will be generated for this customer visit. Guests scan it to order; it deactivates when the table is closed.')}</p>
          <div className="field"><label>{t('Guest count')}</label><input type="number" min={1} value={opening.guestCount} onChange={(e) => setOpening({ ...opening, guestCount: Math.max(1, Number(e.target.value) || 1) })} /></div>
        </Modal>
      )}

      {detail && (
        <Modal title={`${t(detail.name)} · ${t('Session')}`} onClose={() => setDetail(null)}
          footer={<>
            {detailCanClose ? (
              <button className="btn danger" onClick={() => closeSession(detail.session)}><XCircle size={15} /> {t('Close & clear')}</button>
            ) : (
              <button className="btn" onClick={() => toast(t('Unpaid orders remain — collect payment first'), 'error')}>{t('Settle orders first')}</button>
            )}
            <button className="btn" onClick={() => { setDetail(null); setQr({ ...detail.session, tableName: detail.name }); }}>{t('Show QR')}</button>
            <button className="btn" onClick={() => setDetail(null)}>{t('Close')}</button>
          </>}>
          <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}><StatusBadge status={detail.status} /><span className="muted">{t('opened')} {fmtDateTime(detail.session.openedAt, lang)}</span></div>
          {detail.activeOrders.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{t('Order')}</th><th>{t('Status')}</th><th className="num">{t('Total')}</th></tr></thead>
                <tbody>
                  {detail.activeOrders.map((o) => (
                    <tr key={o.id}><td className="mono">{o.orderNumber}</td><td><StatusBadge status={o.status} /></td><td className="num">{fmtMoney(o.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {unsavedDrafts.length > 0 && (
            <div className="table-wrap">
              <p className="muted">{t('Register ticket has unsaved items. Discard it here before closing the table.')}</p>
              <table className="data">
                <thead><tr><th>{t('Ticket')}</th><th>{t('Items')}</th><th className="num"></th></tr></thead>
                <tbody>
                  {unsavedDrafts.map((order) => (
                    <tr key={order.id}>
                      <td className="mono">{order.orderNumber}</td>
                      <td>{order.itemCount}</td>
                      <td className="num">{order.canDiscard && <button className="btn sm danger" onClick={() => discardRegisterDraft(order)} disabled={busy}>{t('Discard')}</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {detailCanClose && <p className="muted">{t('No unpaid orders. Table is ready to close.')}</p>}
        </Modal>
      )}

      {qr && (
        <Modal title={`${t(qr.tableName || 'Table')} · ${t('QR code')}`} onClose={() => setQr(null)}
          footer={<>
            <button className="btn danger" onClick={() => closeSession(qr)}><XCircle size={15} /> {t('Close table')}</button>
            <button className="btn" onClick={() => setQr(null)}>{t('Close')}</button>
            <button className="btn primary" onClick={() => downloadQr(`${base}/order/${qr.token}`, `qr-${qr.tableName || qr.id}`).catch(() => toast(t('Could not create image'), 'error'))}><Download size={15} /> {t('Download')}</button>
          </>}>
          <div style={{ textAlign: 'center' }}>
            <QrView url={`${base}/order/${qr.token}`} size={188} />
            <p style={{ margin: '10px 0 4px' }}><strong>{t('Active')}</strong> {t('— orders accepted while this table stays open.')}</p>
            <p className="muted" style={{ margin: '0 0 12px', fontSize: 12, wordBreak: 'break-all' }}>{base}/order/{qr.token}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
