import React, { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { useBranch } from '../lib/branch';
import { useI18n } from '../i18n';
import { useToast } from '../components/Toast';
import { Modal, Empty } from '../components/ui';
import { Building2, Plus, Pencil, Trash2, MapPin, Phone, X } from 'lucide-react';

// One store can run several locations. Each branch has its own tables, orders,
// cash drawer and reports, while the menu, staff and discounts stay shared.
export default function Branches() {
  const { t } = useI18n();
  const toast = useToast();
  const { branches, reload, create, update, remove, multi } = useBranch();
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  useEffect(() => { reload(); }, [reload]);

  async function save(payload, id) {
    setBusy(true);
    try {
      if (id) await update(id, payload);
      else await create(payload);
      setEditing(null);
      toast(id ? t('Branch updated') : t('Branch created'));
    } catch (e) {
      toast(e.message || t('Could not save'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function destroy(branch) {
    setBusy(true);
    try {
      await remove(branch.id);
      setConfirmDelete(null);
      toast(t('Branch removed'));
    } catch (e) {
      toast(e.message || t('Could not remove'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <h1>{t('Branches')}</h1>
        <button className="btn primary" onClick={() => setEditing({})} disabled={busy}>
          <Plus size={16} /> {t('Add branch')}
        </button>
      </div>
      <div className="content">
        <p className="muted" style={{ marginTop: 0 }}>
          {multi
            ? t('New orders, tables and cash drawers are recorded against the branch you are working at.')
            : t('This store has one branch. Add another to run a second location with its own tables and reports.')}
        </p>
        {branches.length === 0 ? (
          <Empty icon={Building2} title={t('No branches yet')} />
        ) : (
          <div className="branch-grid">
            {branches.map((b) => (
              <article className="branch-card" key={b.id}>
                <div className="branch-card-head">
                  <div>
                    <h3>{b.name}</h3>
                    <code className="slug">{b.code}</code>
                    {b.isDefault ? <span className="bm-tag">default</span> : null}
                  </div>
                  <div className="row-actions">
                    <button className="btn sm" onClick={() => setEditing(b)} aria-label={t('Edit')}><Pencil size={15} /></button>
                    {!b.isDefault ? (
                      <button className="btn sm danger" onClick={() => setConfirmDelete(b)} aria-label={t('Remove')}>
                        <Trash2 size={15} />
                      </button>
                    ) : null}
                  </div>
                </div>
                {b.address ? <p className="bc-line"><MapPin size={14} /> {b.address}</p> : null}
                {b.phone ? <p className="bc-line"><Phone size={14} /> {b.phone}</p> : null}
                <div className="bc-stats">
                  <span><b>{b.tableCount}</b> {t('tables')}</span>
                  <span><b>{b.orderCount}</b> {t('orders')}</span>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <BranchForm
          branch={editing.id ? editing : null}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      ) : null}

      {confirmDelete ? (
        <Modal title={t('Remove branch')} onClose={() => setConfirmDelete(null)}>
          <p>
            {t('Remove')} <b>{confirmDelete.name}</b>? {t('Only possible when it has no tables and no orders in its history.')}
          </p>
          <div className="modal-actions">
            <button className="btn" onClick={() => setConfirmDelete(null)}>{t('Cancel')}</button>
            <button className="btn danger" disabled={busy} onClick={() => destroy(confirmDelete)}>{t('Remove')}</button>
          </div>
        </Modal>
      ) : null}
    </>
  );
}

function BranchForm({ branch, busy, onCancel, onSave }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: branch?.name || '',
    code: branch?.code || '',
    address: branch?.address || '',
    phone: branch?.phone || '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e) {
    e.preventDefault();
    setErr('');
    if (!form.name.trim()) return setErr(t('Branch name is required'));
    onSave({ ...form }, branch?.id);
  }

  return (
    <Modal title={branch ? t('Edit branch') : t('Add branch')} onClose={onCancel}>
      <form onSubmit={submit}>
        <label>
          {t('Name')}
          <input value={form.name} onChange={set('name')} autoFocus required />
        </label>
        <label>
          {t('Code')}
          <input
            value={form.code}
            onChange={set('code')}
            placeholder="downtown"
            spellCheck="false"
            readOnly={Boolean(branch)}
          />
          {branch ? null : <small className="hint">{t('Short name used in reports, e.g. downtown')}</small>}
        </label>
        <label>
          {t('Address')}
          <input value={form.address} onChange={set('address')} />
        </label>
        <label>
          {t('Phone')}
          <input value={form.phone} onChange={set('phone')} />
        </label>
        {err ? <p className="form-error">{err}</p> : null}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}><X size={15} /> {t('Cancel')}</button>
          <button className="btn primary" disabled={busy} type="submit">{branch ? t('Save') : t('Add branch')}</button>
        </div>
      </form>
    </Modal>
  );
}
