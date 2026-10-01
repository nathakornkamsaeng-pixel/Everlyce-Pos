import React, { useEffect, useState } from 'react';
import { get, post, put, del } from '../lib/api';
import { Modal, Confirm, StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function Discounts() {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [delId, setDelId] = useState(null);
  const toast = useToast();

  function load() { get('/discounts').then(setList).catch(() => {}); }
  useEffect(() => { load(); }, []);

  async function save() {
    try {
      if (edit.id) await put(`/discounts/${edit.id}`, edit);
      else await post('/discounts', edit);
      toast(t('Saved'), 'ok'); setEdit(null); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function remove() {
    try { await del(`/discounts/${delId}`); setDelId(null); load(); toast(t('Deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  return (
    <>
      <div className="topbar">
        <h1>{t('Discounts')}</h1>
        <button className="btn primary" onClick={() => setEdit({ code: '', name: '', type: 'percent', value: 0, active: true })}>+ New discount</button>
      </div>
      <div className="content">
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Code')}</th><th>{t('Name')}</th><th>{t('Type')}</th><th className="num">{t('Value')}</th><th className="num">{t('Points')}</th><th>{t('Coupons')}</th><th>{t('Status')}</th><th></th></tr></thead>
              <tbody>
                {list.length === 0 && <tr><td colSpan={6} className="muted">{t('No discounts yet.')}</td></tr>}
                {list.map((d) => (
                  <tr key={d.id}>
                    <td className="mono"><strong>{d.code}</strong></td>
                    <td>{d.name}</td>
                    <td><span className="badge">{d.type}</span></td>
                    <td className="num">{d.type === 'percent' ? `${d.value}%` : d.value}</td>
                    <td className="num">{Number(d.pointsCost) > 0 ? `${d.pointsCost} pts` : '—'}</td>
                    <td>{d.stackable === false ? <span className="badge gray">{t('Single use only')}</span> : <span className="badge green">{t('Can combine')}</span>}</td>
                    <td><StatusBadge status={d.active ? 'active' : 'closed'} /></td>
                    <td className="num"><button className="btn sm" onClick={() => setEdit(d)}>{t('Edit')}</button> <button className="btn sm danger" onClick={() => setDelId(d.id)}>{t('Delete')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? 'Edit discount' : 'New discount'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>{t('Cancel')}</button><button className="btn primary" onClick={save}>{t('Save')}</button></>}>
          <div className="form-grid">
            <div className="field"><label>{t('Code')}</label><input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} /></div>
            <div className="field"><label>{t('Name')}</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>{t('Type')}</label>
              <select value={edit.type} onChange={(e) => setEdit({ ...edit, type: e.target.value })}>
                <option value="percent">{t('Percent')}</option>
                <option value="fixed">{t('Fixed amount')}</option>
              </select>
            </div>
            <div className="field"><label>{t('Value')}</label><input type="number" value={edit.value} onChange={(e) => setEdit({ ...edit, value: Number(e.target.value) })} /></div>
            <div className="field">
              <label>{t('Points needed to use')}</label>
              <input type="number" min="0" inputMode="numeric" value={edit.pointsCost ?? 0} onChange={(e) => setEdit({ ...edit, pointsCost: Number(e.target.value) || 0 })} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('A coupon that costs points can only be used by a loyalty member with enough points. Leave at 0 for a free coupon.')}</div>
          <label className="switch-row">
            <input type="checkbox" checked={edit.stackable !== false} onChange={(e) => setEdit({ ...edit, stackable: e.target.checked })} />
            <span>{t('Can be used with other coupons')}</span>
          </label>
          <label style={{ fontSize: 13.5 }}><input style={{ marginRight: 6 }} type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {t('Active')}</label>
        </Modal>
      )}
      {delId && <Confirm title={t('Delete discount')} message="This cannot be undone." onYes={remove} onCancel={() => setDelId(null)} />}
    </>
  );
}