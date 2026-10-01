import React, { useEffect, useMemo, useState } from 'react';
import { get, post, put, del, fmtMoney } from '../lib/api';
import { Modal, Confirm, Empty } from '../components/ui';
import { useToast } from '../components/Toast';
import { X, SlidersHorizontal, Search } from 'lucide-react';
import { useI18n } from '../i18n';

const EMPTY = { name: '', type: 'single', required: false, maxSelect: 0, productIds: [], options: [] };

export default function Modifiers() {
  const { t } = useI18n();
  const [groups, setGroups] = useState([]);
  const [products, setProducts] = useState([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);
  const [delId, setDelId] = useState(null);
  const toast = useToast();

  function load() {
    Promise.all([get('/modifier-groups'), get('/products')]).then(([g, p]) => { setGroups(g); setProducts(p); }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function saveGroup(body) {
    try {
      const payload = { ...body, options: body.options.filter((o) => o.name && o.name.trim()) };
      if (body.id) await put(`/modifier-groups/${body.id}`, payload);
      else await post('/modifier-groups', payload);
      toast(t('Saved'), 'ok');
      setEditing(null);
      load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function removeGroup() {
    if (!delId) return;
    try { await del(`/modifier-groups/${delId}`); setDelId(null); load(); toast(t('Deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  const shown = useMemo(() => {
    let list = groups;
    if (filter) list = list.filter((g) => (g.productIds || []).includes(Number(filter)));
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((g) => g.name.toLowerCase().includes(q) || g.options.some((o) => o.name.toLowerCase().includes(q)));
    }
    return list;
  }, [groups, filter, query]);

  const usage = (g) => {
    const ids = g.productIds || [];
    if (!ids.length) return 'Not linked to a product';
    if (ids.length === 1) return `On ${products.find((p) => p.id === ids[0])?.name || 'product'}`;
    return `On ${ids.length} products`;
  };

  return (
    <>
      <div className="topbar">
        <h1>{t('Modifiers')}</h1>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing({ ...EMPTY, options: [] })}>+ New group</button>
        </div>
      </div>
      <div className="content">
        <div className="card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search" style={{ flex: 1, minWidth: 200 }}>
            <Search size={15} className="mag" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search groups or options')} />
          </div>
          <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ minWidth: 180 }}>
            <option value="">{t('All products')}</option>
            {products.map((p) => <option key={p.id} value={p.id}>{t(p.name)}</option>)}
          </select>
        </div>

        <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>{t('A group can be linked to many products, and a product can use many groups.')}</p>

        <div className="grid cols-3 mt">
          {shown.map((g) => (
            <div className="card" key={g.id}>
              <div className="spread">
                <strong>{t(g.name)}</strong>
                <span className="badge">{g.type === 'multiple' ? 'multi' : 'single'}{g.required ? ' · required' : ''}</span>
              </div>
              <div className="muted" style={{ marginTop: 4, fontSize: 12.5 }}>{usage(g)}</div>
              <div style={{ marginTop: 10 }}>
                {g.options.map((o) => (
                  <div key={o.id} className="spread" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)', fontSize: 13.5 }}>
                    <span>{t(o.name)}</span>
                    {o.priceAdj !== 0 && <span className="muted">+{fmtMoney(o.priceAdj)}</span>}
                  </div>
                ))}
              </div>
              <div className="row mt" style={{ justifyContent: 'flex-end' }}>
                <button className="btn sm" onClick={() => setEditing({ ...EMPTY, ...g, options: (g.options || []).map((o) => ({ ...o })) })}>{t('Edit')}</button>
                <button className="btn sm danger" onClick={() => setDelId(g.id)}>{t('Delete')}</button>
              </div>
            </div>
          ))}
        </div>
        {shown.length === 0 && <Empty icon={SlidersHorizontal} title={t('No modifier groups')}>{t('Add options like size, spice level, or add-ons, then link them to any products.')}</Empty>}
      </div>

      {editing && <GroupModal products={products} initial={editing} onClose={() => setEditing(null)} onSave={saveGroup} />}
      {delId && <Confirm title={t('Delete group')} message="This also deletes its options. Products stay, but lose these options." onYes={removeGroup} onCancel={() => setDelId(null)} />}
    </>
  );
}

function GroupModal({ products, initial, onClose, onSave }) {
  const { t } = useI18n();
  const [form, setForm] = useState(initial);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const updOpt = (i, k, v) => setForm((f) => ({ ...f, options: f.options.map((o, j) => (j === i ? { ...o, [k]: v } : o)) }));

  const toggleProduct = (id) => setForm((f) => ({
    ...f,
    productIds: f.productIds.includes(id) ? f.productIds.filter((x) => x !== id) : [...f.productIds, id],
  }));

  return (
    <Modal title={initial.id ? 'Edit group' : 'New group'} onClose={onClose} wide
      footer={<><button className="btn" onClick={onClose}>{t('Cancel')}</button><button className="btn primary" onClick={() => onSave(form)}>{t('Save')}</button></>}>
      <div className="form-grid">
        <div className="field"><label>Group name *</label><input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder={t('e.g. Size, Add-ons')} /></div>
        <div className="field"><label>{t('Selection')}</label>
          <select value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="single">{t('Single choice')}</option>
            <option value="multiple">{t('Multiple choice')}</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={form.required} onChange={(e) => set('required', e.target.checked)} /> {t('Required')}</label>
        {form.type === 'multiple' && (
          <div className="field" style={{ margin: 0, maxWidth: 150 }}>
            <label>Max picks (0 = no limit)</label>
            <input type="number" min={0} value={form.maxSelect || 0} onChange={(e) => set('maxSelect', Number(e.target.value))} />
          </div>
        )}
      </div>

      <div className="section-title" style={{ marginTop: 0 }}>{t('Used by products')}<span className="muted" style={{ fontWeight: 400 }}>(select any)</span></div>
      <div className="product-chips">
        {products.length === 0 && <span className="muted">{t('No products yet.')}</span>}
        {products.map((p) => (
          <button key={p.id} type="button" className={`chip ${form.productIds.includes(p.id) ? 'on' : ''}`} onClick={() => toggleProduct(p.id)}>{t(p.name)}</button>
        ))}
      </div>

      <div className="section-title">{t('Options')}</div>
      {form.options.map((o, i) => (
        <div className="row" key={i} style={{ marginBottom: 8 }}>
          <input style={{ flex: 1, padding: 9, border: '1px solid var(--border)', borderRadius: 8 }} placeholder={t('Option name')} value={o.name} onChange={(e) => updOpt(i, 'name', e.target.value)} />
          <input style={{ width: 110, padding: 9, border: '1px solid var(--border)', borderRadius: 8 }} type="number" placeholder={t('+price')} value={o.priceAdj} onChange={(e) => updOpt(i, 'priceAdj', e.target.value)} />
          <button className="btn sm ghost" aria-label={t('Remove option')} onClick={() => setForm((f) => ({ ...f, options: f.options.filter((_, j) => j !== i) }))}><X /></button>
        </div>
      ))}
      <button className="btn sm" onClick={() => setForm((f) => ({ ...f, options: [...f.options, { name: '', priceAdj: 0 }] }))}>+ Add option</button>
    </Modal>
  );
}