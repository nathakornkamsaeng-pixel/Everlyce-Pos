import React, { useEffect, useState } from 'react';
import { get, post, put, del, api } from '../lib/api';
import { Modal, Confirm, StatusBadge } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

const ROLES = [
  { id: 'cashier', label: 'Cashier' },
  { id: 'admin', label: 'Admin' },
  { id: 'kds', label: 'Kitchen (KDS)' },
  { id: 'display', label: 'Customer Display' },
];

const ROLE_LABEL = Object.fromEntries(ROLES.map((r) => [r.id, r.label]));

export default function Users() {
  const { t } = useI18n();
  const [list, setList] = useState([]);
  const [edit, setEdit] = useState(null);
  const [delId, setDelId] = useState(null);
  const [me, setMe] = useState(null);
  const toast = useToast();

  function load() {
    get('/users').then((u) => { setList(u); setMe(api.getUser()); }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  const cashiers = list.filter((u) => u.role === 'cashier' || u.role === 'admin');

  async function save() {
    try {
      const body = { ...edit };
      if (!body.password) delete body.password;
      if (edit.id) await put(`/users/${edit.id}`, body);
      else await post('/users', body);
      toast(t('Saved'), 'ok'); setEdit(null); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function remove() {
    try { await del(`/users/${delId}`); setDelId(null); load(); toast(t('Deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  return (
    <>
      <div className="topbar">
        <h1>{t('Users')}</h1>
        <button className="btn primary" onClick={() => setEdit({ username: '', name: '', role: 'cashier', pin: '', password: '' })}>+ New user</button>
      </div>
      <div className="content">
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Username')}</th><th>{t('Name')}</th><th>{t('Role')}</th><th>{t('Language')}</th><th>{t('Linked to')}</th><th>PIN</th><th>{t('Status')}</th><th></th></tr></thead>
              <tbody>
                {list.map((u) => (
                  <tr key={u.id}>
                    <td className="mono"><strong>{u.username}</strong>{u.id === me?.id && <span className="muted"> (you)</span>}</td>
                    <td>{u.name}</td>
                    <td><span className="badge">{ROLE_LABEL[u.role] || u.role}</span></td>
                    <td><span className="badge">{u.language === 'en' ? 'EN' : 'ไทย'}</span></td>
                    <td className="muted">{u.role === 'display' ? (cashiers.find((c) => c.id === u.cashierId)?.name || 'Not linked') : '—'}</td>
                    <td className="mono">{u.pin || '—'}</td>
                    <td><StatusBadge status={u.active ? 'active' : 'closed'} /></td>
                    <td className="num">
                      <button className="btn sm" onClick={() => setEdit({ ...u, password: '' })}>{t('Edit')}</button>
                      <button className="btn sm danger" onClick={() => setDelId(u.id)}>{t('Delete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {edit && (
        <Modal title={edit.id ? `Edit ${edit.username}` : 'New user'} onClose={() => setEdit(null)}
          footer={<><button className="btn" onClick={() => setEdit(null)}>{t('Cancel')}</button><button className="btn primary" onClick={save}>{t('Save')}</button></>}>
          <div className="form-grid">
            <div className="field"><label>Username *</label><input value={edit.username} onChange={(e) => setEdit({ ...edit, username: e.target.value })} /></div>
            <div className="field"><label>{t('Name')}</label><input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></div>
            <div className="field"><label>{t('Role')}</label>
              <select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value, cashierId: e.target.value === 'display' ? edit.cashierId : null })}>
                {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            {edit.role === 'display' && (
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>{t('Link to cashier (this display mirrors their register)')}</label>
                <select value={edit.cashierId || ''} onChange={(e) => setEdit({ ...edit, cashierId: e.target.value || null })}>
                  <option value="">{t('Not linked')}</option>
                  {cashiers.filter((c) => c.id !== edit.id).map((c) => <option key={c.id} value={c.id}>{c.name} ({c.username})</option>)}
                </select>
              </div>
            )}
            <div className="field"><label>{t('Screen language')}</label>
              <select value={edit.language || 'th'} onChange={(e) => setEdit({ ...edit, language: e.target.value })}>
                <option value="th">ไทย (Thai)</option>
                <option value="en">English</option>
              </select>
            </div>
            <div className="field"><label>{t('Staff PIN (cashier login)')}</label><input value={edit.pin || ''} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '') })} maxLength={6} /></div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{edit.id ? 'Reset password (leave blank to keep)' : 'Password'}</label>
              <input type="password" value={edit.password || ''} onChange={(e) => setEdit({ ...edit, password: e.target.value })} />
            </div>
          </div>
          {edit.id && <label style={{ fontSize: 13.5 }}><input style={{ marginRight: 6 }} type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {t('Active')}</label>}
        </Modal>
      )}
      {delId && <Confirm title={t('Delete user')} message="This cannot be undone." onYes={remove} onCancel={() => setDelId(null)} />}
    </>
  );
}