import React, { useEffect, useState } from 'react';
import { get, fmtTime } from '../lib/api';
import { useToast } from '../components/Toast';
import { Empty } from '../components/ui';
import QrView, { downloadQr } from '../components/QrView';
import { QrCode, RefreshCw, Download } from 'lucide-react';
import { useI18n } from '../i18n';
import { useStore, storePath } from '../lib/store';

export default function QRCodes() {
  const { t, lang } = useI18n();
  const { slug } = useStore();
  const [sessions, setSessions] = useState([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  // Guests get the store's own address, so the QR keeps working on its own.
  const base = `${window.location.origin}/${slug}`;

  function load() {
    setBusy(true);
    get('/sessions/active').then(setSessions).catch(() => {}).finally(() => setBusy(false));
  }
  useEffect(() => { load(); }, []);

  function download(url, name) {
    downloadQr(url, name).catch(() => toast(t('Could not create image'), 'error'));
  }

  return (
    <>
      <div className="topbar"><h1>{t('QR Codes')}</h1>
        <div className="page-actions">
          <button className="btn" onClick={load} disabled={busy}><RefreshCw size={15} /> {t('Refresh')}</button>
        </div>
      </div>
      <div className="content">
        <p className="muted" style={{ marginTop: 0 }}>{t('Codes are generated on demand when staff open a table. Each code is unique to that visit — it stays active while the table is occupied and is deactivated when the cashier closes it.')}</p>
        {sessions.length > 0 && (
          <div className="grid cols-auto">
            {sessions.map((s) => {
              const url = `${base}/order/${s.token}`;
              return (
                <div className="card" key={s.id} style={{ textAlign: 'center' }}>
                  <strong>{s.tableName}</strong>
                  <span className="badge green" style={{ marginLeft: 6 }}>{t('active')}</span>
                  <QrView url={url} size={168} />
                  <div className="muted" style={{ fontSize: 11.5, wordBreak: 'break-all' }}>{url}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>{s.guestCount} {t('guest(s)')} · {t('opened')} {fmtTime(s.openedAt, lang)}</div>
                  <div className="row mt" style={{ justifyContent: 'center' }}>
                    <button className="btn sm primary" onClick={() => download(url, `qr-${s.tableName || s.id}`)}><Download size={13} /> {t('Download')}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!busy && sessions.length === 0 && (
          <Empty icon={QrCode} title={t('No active QR codes')}>{t('Open a table to generate its QR code. It will appear here and in the Tables floor.')}</Empty>
        )}
      </div>
    </>
  );
}