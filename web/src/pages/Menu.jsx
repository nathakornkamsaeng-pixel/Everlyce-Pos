import React, { useEffect, useState } from 'react';
import { get, post, put, del, fmtMoney } from '../lib/api';
import { Modal, Confirm, StatusBadge, Empty } from '../components/ui';
import { useToast } from '../components/Toast';
import { TriangleAlert, UtensilsCrossed } from 'lucide-react';
import { useI18n } from '../i18n';

const EMPTY = { name: '', categoryId: '', price: 0, cost: 0, available: true, trackStock: false, stockCount: 0, lowStockThreshold: 5, allergens: '', sku: '', barcode: '', description: '', modifierGroupIds: [] };

export default function Menu() {
  const { t } = useI18n();
  const [cats, setCats] = useState([]);
  const [prods, setProds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [tab, setTab] = useState('products');
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [delId, setDelId] = useState(null);
  const [catName, setCatName] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function load() {
    Promise.all([get('/categories'), get('/products'), get('/modifier-groups')])
      .then(([c, p, g]) => { setCats(c); setProds(p); setGroups(g); })
      .catch(() => toast(t('Failed to load'), 'error'));
  }
  useEffect(() => { load(); }, []);

  function openNew() {
    if (!cats.length) {
      setTab('categories');
      toast(t('Create a category first — items need one to show on the customer menu'), 'error');
      return;
    }
    setForm({ ...EMPTY, categoryId: cats[0].id });
    setEditing(false);
  }

  async function save() {
    if (!form.name.trim()) return toast(t('Name is required'), 'error');
    if (form.categoryId === '' || form.categoryId === null) return toast(t('Choose a category — items need one to show on the customer menu'), 'error');
    setBusy(true);
    try {
      const body = { ...form, categoryId: Number(form.categoryId) };
      if (editing) await put(`/products/${editing}`, body);
      else await post('/products', body);
      toast(t('Saved'), 'ok');
      setEditing(null);
      load();
    } catch (e) { toast(t(e.message), 'error'); } finally { setBusy(false); }
  }

  async function addCat() {
    if (!catName.trim()) return;
    try { await post('/categories', { name: catName, sortOrder: cats.length }); setCatName(''); load(); toast(t('Category added'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  async function removeCat(id) {
    try { await del(`/categories/${id}`); load(); toast(t('Category deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  async function removeProduct() {
    if (!delId) return;
    try { await del(`/products/${delId}`); setDelId(null); load(); toast(t('Product deleted'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <>
      <div className="topbar">
        <h1>{t('Menu')}</h1>
        <div className="page-actions">
          <button className="btn" onClick={() => setTab('categories')}>{t('Categories')}</button>
          <button className="btn primary" onClick={openNew}>+ New product</button>
        </div>
      </div>
      <div className="content">
        {tab === 'products' ? (
          <>
            <div className="grid cols-auto">
              {prods.map((p) => {
                const cat = cats.find((c) => c.id === p.categoryId);
                return (
                  <div className="card" key={p.id}>
                    <div className="spread">
                      <strong>{t(p.name)}</strong>
                      <StatusBadge status={p.available ? 'active' : 'closed'} />
                    </div>
                    <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>
                      {cat ? cat.name : <span style={{ color: 'var(--red)' }}>{t('No category')}</span>} · {fmtMoney(p.price)}
                      {p.trackStock && <div style={{ color: p.stockCount <= p.lowStockThreshold ? 'var(--red)' : 'var(--muted)', fontWeight: p.stockCount <= p.lowStockThreshold ? 700 : 400 }}>Stock: {p.stockCount} / low at {p.lowStockThreshold}</div>}
                      {p.modifierGroups?.length > 0 && <div>{p.modifierGroups.length} modifier group(s)</div>}
                      {p.allergens && <div style={{ color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 5 }}><TriangleAlert size={13} /> {p.allergens}</div>}
                    </div>
                    {(!cat || !p.available) && (
                      <div className="badge red" style={{ marginTop: 8 }}>{t('Hidden from customer menu')}</div>
                    )}
                    <div className="row mt" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn sm" onClick={() => { setForm({ name: p.name, categoryId: p.categoryId ?? '', price: p.price, cost: p.cost, available: p.available, trackStock: p.trackStock, stockCount: p.stockCount, lowStockThreshold: p.lowStockThreshold, allergens: p.allergens || '', sku: p.sku || '', barcode: p.barcode || '', description: p.description || '', modifierGroupIds: (p.modifierGroups || []).map((g) => g.id) }); setEditing(p.id); }}>{t('Edit')}</button>
                      <button className="btn sm danger" onClick={() => setDelId(p.id)}>{t('Delete')}</button>
                    </div>
                  </div>
                );
              })}
            </div>
            {prods.length === 0 && <Empty icon={UtensilsCrossed} title={t('No products yet')}>{t('Add your first product to start building the menu.')}</Empty>}
          </>
        ) : (
          <div className="card" style={{ maxWidth: 560 }}>
            <div className="section-title mb0">{t('Categories')}</div>
            <div className="row mt">
              <input style={{ flex: 1, padding: 9, border: '1px solid var(--border)', borderRadius: 9 }} placeholder={t('New category name')} value={catName} onChange={(e) => setCatName(e.target.value)} />
              <button className="btn" onClick={addCat}>{t('Add')}</button>
            </div>
            <div className="table-wrap mt">
              <table className="data">
                <tbody>
                  {cats.map((c, i) => (
                    <tr key={c.id}>
                      <td><strong>{t(c.name)}</strong></td>
                      <td className="muted">{prods.filter((p) => p.categoryId === c.id).length} item(s)</td>
                      <td className="num"><button className="btn sm danger" onClick={() => removeCat(c.id)}>{t('Delete')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {cats.length === 0 && <div className="muted mt">{t('No categories yet.')}</div>}
          </div>
        )}
      </div>

      {editing !== null && editing !== false && (
        <Modal title={editing ? 'Edit product' : ''} onClose={() => setEditing(null)}
          footer={<><button className="btn" onClick={() => setEditing(null)}>{t('Cancel')}</button><button className="btn primary" onClick={save} disabled={busy}>{t('Save')}</button></>}>
          <ProductForm form={form} set={set} setForm={setForm} cats={cats} groups={groups} />
        </Modal>
      )}
      {editing === false && (
        <Modal title={t('New product')} onClose={() => setEditing(null)}
          footer={<><button className="btn" onClick={() => setEditing(null)}>{t('Cancel')}</button><button className="btn primary" onClick={save} disabled={busy}>{t('Save')}</button></>}>
          <ProductForm form={form} set={set} setForm={setForm} cats={cats} groups={groups} />
        </Modal>
      )}
      {delId && <Confirm title={t('Delete product')} message="This cannot be undone." onYes={removeProduct} onCancel={() => setDelId(null)} />}
    </>
  );
}

function ProductForm({ form, set, setForm, cats, groups }) {
  const { t } = useI18n();
  const toggleGroup = (id) => {
    const has = form.modifierGroupIds.includes(id);
    setForm((f) => ({ ...f, modifierGroupIds: has ? f.modifierGroupIds.filter((x) => x !== id) : [...f.modifierGroupIds, id] }));
  };
  return (
    <>
      <div className="form-grid">
        <div className="field"><label>Name *</label><input value={form.name} onChange={set('name')} /></div>
        <div className="field"><label>Category *</label>
          <select value={form.categoryId} onChange={set('categoryId')}>
            <option value="" disabled>{t('Choose a category')}</option>
            {cats.map((c) => <option key={c.id} value={c.id}>{t(c.name)}</option>)}
          </select>
        </div>
        <div className="field"><label>{t('Price')}</label><input type="number" step="0.01" value={form.price} onChange={set('price')} /></div>
        <div className="field"><label>{t('Cost')}</label><input type="number" step="0.01" value={form.cost} onChange={set('cost')} /></div>
        <div className="field"><label>{t('SKU')}</label><input value={form.sku} onChange={set('sku')} /></div>
        <div className="field"><label>{t('Barcode')}</label><input value={form.barcode} onChange={set('barcode')} /></div>
      </div>
      <div className="field"><label>{t('Description')}</label><input value={form.description} onChange={set('description')} /></div>
      <div className="field"><label>{t('Allergens')}</label><input value={form.allergens} onChange={set('allergens')} placeholder={t('e.g. shrimp, dairy, peanuts')} /></div>
      <div className="row">
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={form.available} onChange={set('available')} /> {t('Available')}</label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13.5 }}><input type="checkbox" checked={form.trackStock} onChange={set('trackStock')} /> Track stock</label>
      </div>
      {form.trackStock && (
        <div className="form-grid">
          <div className="field"><label>{t('Stock count')}</label><input type="number" value={form.stockCount} onChange={set('stockCount')} /></div>
          <div className="field"><label>{t('Low-stock alert at')}</label><input type="number" value={form.lowStockThreshold} onChange={set('lowStockThreshold')} /></div>
        </div>
      )}
      <div className="field">
        <label>{t('Modifier groups')}<span className="muted" style={{ fontWeight: 400 }}>(optional — shared across products)</span></label>
        {groups.length === 0 ? (
          <span className="muted">{t('No groups yet. Create them in the Modifiers page.')}</span>
        ) : (
          <div className="product-chips">
            {groups.map((g) => (
              <button key={g.id} type="button" className={`chip ${form.modifierGroupIds.includes(g.id) ? 'on' : ''}`} onClick={() => toggleGroup(g.id)}>
                {g.name}{g.required ? ' *' : ''}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}