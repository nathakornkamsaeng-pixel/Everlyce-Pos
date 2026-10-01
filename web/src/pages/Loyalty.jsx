import React, { useEffect, useState } from 'react';
import { get, post, put, del } from '../lib/api';
import { ShieldCheck, Download, UserX, Pin, PinOff } from 'lucide-react';
import { Modal, Confirm, StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function Loyalty() {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [delId, setDelId] = useState(null);
  const toast = useToast();

  function load() { get('/loyalty/members').then(setList).catch(() => {}); }
  useEffect(() => { load(); }, []);

  async function save() {
    try {
      if (edit.id) await put(`/loyalty/members/${edit.id}`, edit);
      else await post('/loyalty/members', edit);
      toast(t('Saved'), 'ok'); setEdit(null); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  // Data subject right of access: hand the customer a copy they can keep.
  async function exportOne(m) {
    try {
      const data = await get(`/loyalty/members/${m.id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `customer-${m.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast(t('Customer data downloaded'), 'ok');
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function withdraw(m) {
    try {
      await post(`/loyalty/members/${m.id}/withdraw-consent`, {});
      toast(t('Consent withdrawn'), 'ok');
      load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function pin(m) {
    try {
      await post(`/loyalty/members/${m.id}/pin`, { pinned: !m.pinned });
      load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function remove() {
    try { await del(`/loyalty/members/${delId}`); setDelId(null); load(); toast(t('Deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  return (
    <>
      <div className="topbar">
        <h1>{t('Loyalty')}</h1>
        <button className="btn primary" onClick={() => setEdit({ name: '', phone: '', email: '', points: 0, tier: 'standard', consentLoyalty: false, consentMarketing: false })}>+ New member</button>
      </div>
      <div className="content">
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Name')}</th><th>{t('Phone')}</th><th>{t('Email')}</th><th className="num">{t('Points')}</th><th>{t('Tier')}</th><th></th></tr></thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={7} className="muted">{t('No loyalty members yet.')}</td></tr>}
                {list.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.name}</strong></td>
                    <td>{m.phone || '—'}</td>
                    <td>{m.email || '—'}</td>
                    <td className="num">{m.points}</td>
                    <td><StatusBadge status={m.tier === 'gold' ? 'active' : m.tier === 'vip' ? 'amber' : 'gray'} /><span className="muted" style={{ marginLeft: 6 }}>{m.tier}</span></td>
                    <td>
                      {!m.phone && !m.email ? <span className="muted">{t('none needed')}</span>
                        : m.consentWithdrawnAt ? <span className="badge-warn">{t('withdrawn')}</span>
                        : (m.consentPurposes || []).includes('loyalty') ? <span className="badge-ok">{(m.consentPurposes || []).map((p) => t(p)).join(', ')}</span>
                        : <span className="muted">{t('service only')}</span>}
                    </td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setEdit(m)}>{t('Edit')}</button>
                      <button className="btn sm" title={t('Give the customer a copy of their data')} onClick={() => exportOne(m)}>
                        <Download size={14} /> {t('Export')}
                      </button>
                      {m.consentWithdrawnAt ? null : (
                        <button className="btn sm" title={t('Withdraw consent')} onClick={() => withdraw(m)}>
                          <UserX size={14} /> {t('Withdraw')}
                        </button>
                      )}
                      <button
                        className="btn sm"
                        title={m.pinned ? t('Unpin: allow the retention sweep to remove this record') : t('Pin: never remove this record automatically')}
                        onClick={() => pin(m)}
                      >
                        {m.pinned ? <PinOff size={14} /> : <Pin size={14} />} {m.pinned ? t('Unpin') : t('Pin')}
                      </button>
                      <button className="btn sm danger" onClick={() => setDelId(m.id)}>{t('Erase')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? 'Edit member' : 'New member'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>{t('Cancel')}</button><button className="btn primary" onClick={save}>{t('Save')}</button></>}>
          <div className="form-grid">
            <div className="field"><label>Name *</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>{t('Phone')}</label><input value={edit.phone || ''} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></div>
            <div className="field"><label>{t('Email')}</label><input value={edit.email || ''} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></div>
            <div className="field"><label>{t('Points')}</label><input type="number" value={edit.points} onChange={(e) => setEdit({ ...edit, points: Number(e.target.value) })} /></div>
            <div className="field"><label>{t('Tier')}</label>
              <select value={edit.tier} onChange={(e) => setEdit({ ...edit, tier: e.target.value })}>
                <option value="standard">Standard</option>
                <option value="gold">Gold</option>
                <option value="vip">VIP</option>
              </select>
            </div>
          </div>

          {(edit.phone || edit.email) ? (
            <div className="consent-box">
              <div className="consent-head">
                <ShieldCheck size={16} />
                <strong>{t('Customer consent')}</strong>
                <a href="/privacy" target="_blank" rel="noreferrer">{t('Read the privacy notice')}</a>
              </div>
              <p className="muted">
                {t('The Personal Data Protection Act requires consent before a phone number or email is stored. Tick what this customer agreed to.')}
              </p>
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={edit.consentLoyalty === true}
                  onChange={(e) => setEdit({ ...edit, consentLoyalty: e.target.checked })}
                />
                <span>
                  <b>{t('Loyalty')}</b>
                  <small>{t('Keep their points and member benefits')} ({t('required to save')})</small>
                </span>
              </label>
              <label className="consent-row">
                <input
                  type="checkbox"
                  checked={edit.consentMarketing === true}
                  onChange={(e) => setEdit({ ...edit, consentMarketing: e.target.checked })}
                />
                <span>
                  <b>{t('Marketing')}</b>
                  <small>{t('Send promotions and offers')} ({t('optional')})</small>
                </span>
              </label>
              <p className="consent-note">
                {t('Consent is recorded with the date, the version of the notice, and who ticked it.')}
              </p>
            </div>
          ) : null}
        </Modal>
      )}
      {delId && (
        <Confirm
          title={t('Erase customer data')}
          message={t('Their name, phone, email and loyalty balance are removed. Financial records are kept but no longer identify anyone. This cannot be undone.')}
          onYes={remove}
          onCancel={() => setDelId(null)}
        />
      )}
    </>
  );
}