import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, post } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { Modal } from '../components/ui';
import { Check, TriangleAlert, SlidersHorizontal, X, UtensilsCrossed, ShoppingBasket, Minus, Plus, ReceiptText, Clock, CheckCircle2, ChefHat } from 'lucide-react';
import { useI18n } from '../i18n';
import { useBranding, brand, BrandLogo } from '../branding';

export default function PublicOrder() {
  const { token } = useParams();
  const { t, lang, setLang } = useI18n();
  const { name: brandName } = useBranding();
  const [cats, setCats] = useState([]);
  const [info, setInfo] = useState(null);
  const [cat, setCat] = useState(null);
  const [cart, setCart] = useState([]);
  const [modal, setModal] = useState(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [done, setDone] = useState(null);
  const [err, setErr] = useState('');
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [myOrders, setMyOrders] = useState([]);

  useEffect(() => {
    function load() {
      return Promise.all([
        get(`/public/session?token=${token}`).catch(() => null),
        get(`/public/menu?token=${token}&lang=${lang}`),
        get(`/public/orders?token=${token}`).catch(() => []),
      ]).then(([info, cats, orders]) => {
        setInfo(info || { table: null, settings: { restaurantName: '' } });
        setCats(cats);
        setCat(cats[0]?.id);
        setMyOrders(orders || []);
        setErr('');
        setClosed(false);
      }).catch((e) => {
        if (e && e.status === 410) setClosed(true);
        else setErr(t('Menu is unavailable for this table.'));
      });
    }
    load();
    const on = () => load();
    const poll = setInterval(load, 12000);
    window.addEventListener('focus', on);
    return () => { clearInterval(poll); window.removeEventListener('focus', on); };
  }, [token, lang, t]);

  if (closed) {
    return (
      <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center' }}>
        <BrandLogo size={58} className="public-card-logo" alt={brand(brandName)} />
        <h2>{t('This visit has ended')}</h2>
        <p className="muted">{t('The table session has been closed. Thank you for dining with us!')}</p>
      </div></div>
    );
  }

  async function placeOrder() {
    if (!cart.length || busy) return;
    setBusy(true);
    try {
      const items = cart.map((l) => ({ productId: l.productId, quantity: l.qty, notes: l.notes || null, modifiers: l.mods }));
      const d = await post('/public/order', { token, items, customerName: name || null, notes: notes || null });
      setDone(d);
      setCart([]);
      setModal(null);
      get(`/public/orders?token=${token}`).then(setMyOrders).catch(() => {});
    } catch (e) {
      if (e && e.status === 410) { setClosed(true); setModal(null); return; }
      setErr(e.message || t('Could not place order'));
    } finally {
      setBusy(false);
    }
  }

  const activeCat = cats.find((c) => c.id === cat);
  const subtotal = cart.reduce((s, l) => s + (l.unitPrice + l.adj) * l.qty, 0);

  // Add a line, merging with an identical existing line (same product + modifiers + note).
  function pushLine(p, chosen, note) {
    const mods = Object.values(chosen).flat().map((o) => ({ group: o.groupName, option: o.name, adj: o.priceAdj }));
    const key = JSON.stringify(mods);
    const noteKey = (note || '').trim();
    setCart((c) => {
      const i = c.findIndex((l) => l.productId === p.id && l.key === key && (l.notes || '') === noteKey);
      if (i >= 0) {
        const next = [...c];
        next[i] = { ...next[i], qty: next[i].qty + 1 };
        return next;
      }
      return [...c, { productId: p.id, name: p.name, unitPrice: p.price, qty: 1, mods, key, notes: noteKey || null, adj: mods.reduce((s, m) => s + (m.adj || 0), 0) }];
    });
  }

  function changeQty(i, d) {
    setCart((c) => {
      const next = [...c];
      const q = next[i].qty + d;
      if (q <= 0) next.splice(i, 1);
      else next[i] = { ...next[i], qty: q };
      return next;
    });
  }

  function chooseProduct(p) {
    setModal({ product: p, groups: p.modifierGroups || [], chosen: {}, notes: '' });
  }

  if (done) {
    return (
      <div className="login-wrap">
        <div className="login-card" style={{ textAlign: 'center' }}>
          <BrandLogo size={58} className="public-card-logo" alt={brand(brandName)} />
          <h2>{t('Order placed!')}</h2>
          <p className="muted">{t('Your order number is')}</p>
          <div className="mono" style={{ fontSize: 22, fontWeight: 800, margin: '8px 0 18px' }}>{done.orderNumber}</div>
          <p className="muted" style={{ fontSize: 13 }}>{t('The kitchen is preparing it now. Thank you!')}</p>
          <button className="btn primary" style={{ width: '100%', padding: 11 }} onClick={() => { setDone(null); setModal(null); setNotes(''); }}>{t('New order')}</button>
        </div>
      </div>
    );
  }

  const { settings } = info || {};
  const taxRate = parseFloat(settings?.taxRate) || 0;
  const scRate = parseFloat(settings?.serviceChargeRate) || 0;
  const tax = subtotal * taxRate / 100;
  const sc = subtotal * scRate / 100;
  const total = subtotal + tax + sc;
  const itemCount = cart.reduce((s, l) => s + l.qty, 0);

  return (
    <div className="public-wrap">
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <div className="public-brand">
          <BrandLogo size={54} />
          <div>
            <h1>{brand(brandName || settings?.restaurantName)}</h1>
            {info?.table && <div className="muted">{t('Table')} {t(info.table.name)} {info.table.seats ? `· ${info.table.seats} ${t('seats')}` : ''}</div>}
          </div>
        </div>
        <div className="lang-switch" role="group" aria-label={t('Language')}>
          <button className={lang === 'th' ? 'on' : ''} onClick={() => setLang('th')}>ไทย</button>
          <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
        </div>
      </div>

      {err && <div className="card mt" style={{ borderColor: 'var(--red)' }}>{err}</div>}

      {cats.length === 0 ? (
        <div className="empty mt"><UtensilsCrossed className="empty-icon" /><div className="empty-title">{t('No menu items yet')}</div><div className="empty-hint">{t('Please ask a member of staff to set up the menu.')}</div></div>
      ) : (
        <>
      <div className="pub-menu">
        {cats.map((c) => <button key={c.id} className={activeCat?.id === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{t(c.name)}</button>)}
      </div>

      {activeCat && activeCat.products.map((p) => (
        <div className="pub-card" key={p.id} onClick={() => chooseProduct(p)}>
          <div>
            <strong>{t(p.name)}</strong>
            {p.description && <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{t(p.description)}</div>}
            {p.allergens && <div style={{ fontSize: 11.5, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 4 }}><TriangleAlert size={12} /> {p.allergens}</div>}
            {p.modifierGroups?.length > 0 && <div className="muted" style={{ fontSize: 11.5, display: 'flex', alignItems: 'center', gap: 4 }}><SlidersHorizontal size={12} /> {p.modifierGroups.length} option group(s)</div>}
          </div>
          <div className="price">{fmtMoney(p.price)}</div>
        </div>
      ))}
        </>
      )}

      {/* static basket bar, always visible */}
      <div className={`basket-bar${cart.length ? '' : ' empty'}`}>
        <button className="basket-left" onClick={() => setModal({ cart: true })}>
          <span className="basket-icon"><ShoppingBasket size={19} /></span>
          <span className="basket-text">
            <strong>{cart.length ? t('View basket') : t('Your basket')}</strong>
            <small>{cart.length ? `${itemCount} item${itemCount === 1 ? '' : 's'} · ${fmtMoney(total)}` : t('Empty — tap to add items')}</small>
          </span>
        </button>
        <button className="btn basket-orders" onClick={() => setModal({ orders: true })}>
          <ReceiptText size={15} /> {t('Order History')}{myOrders.length > 0 ? ` (${myOrders.length})` : ''}
        </button>
      </div>

      {modal && !modal.confirm && (
        <Modal title={modal.cart ? t('Your basket') : modal.orders ? t('Your orders') : t(modal.product.name)}
          onClose={() => setModal(null)}
          footer={modal.cart ? (
            <>
              <button className="btn" onClick={() => setModal(null)}>{t('Keep ordering')}</button>
              <button className="btn primary" disabled={!cart.length} onClick={() => setModal({ confirm: true })}>{t('Place order')}</button>
            </>
          ) : modal.orders ? (
            <button className="btn primary" onClick={() => setModal(null)}>{t('Done')}</button>
          ) : (
            <>
              <button className="btn" onClick={() => setModal(null)}>{t('Cancel')}</button>
              <button className="btn primary" onClick={() => { pushLine(modal.product, modal.chosen, modal.notes); setModal(null); }}>{t('Add to basket')}</button>
            </>
          )}>
          {modal.orders ? (
            <OrdersList orders={myOrders} t={t} />
          ) : modal.cart ? (
            <>
              {cart.map((l, i) => (
                <div className="cart-line" key={i}>
                  <div className="ln">{t(l.name)} × {l.qty}{l.mods.map((m, j) => <span key={j} className="mod">+ {t(m.option)}</span>)}{l.notes && <span className="mod">“{l.notes}”</span>}</div>
                  <div className="qty">
                    <button onClick={() => changeQty(i, -1)} aria-label={t('Decrease')}><Minus size={14} /></button>
                    <span className="qn">{l.qty}</span>
                    <button onClick={() => changeQty(i, 1)} aria-label={t('Increase')}><Plus size={14} /></button>
                  </div>
                  <strong>{fmtMoney((l.unitPrice + l.adj) * l.qty)}</strong>
                  <button className="btn sm ghost" aria-label={t('Remove')} onClick={() => setCart((c) => c.filter((_, j) => j !== i))}><X /></button>
                </div>
              ))}
              {cart.length === 0 && <p className="muted">{t('Your basket is empty.')}</p>}
              <div className="field" style={{ marginTop: 12 }}><label>{t('Your name (optional)')}</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
              <div className="field"><label>{t('Order note (optional)')}</label><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('e.g. no ice')} /></div>
              <div style={{ marginTop: 6 }}>
                <div className="spread"><span className="muted">{t('Subtotal')}</span><span>{fmtMoney(subtotal)}</span></div>
                <div className="spread"><span className="muted">{t('Tax')}</span><span>{fmtMoney(tax)}</span></div>
                <div className="spread"><span className="muted">{t('Service charge')}</span><span>{fmtMoney(sc)}</span></div>
                <div className="spread" style={{ fontWeight: 700, fontSize: 16 }}><span>{t('Total')}</span><span>{fmtMoney(total)}</span></div>
              </div>
            </>
          ) : (
            <>
              {modal.groups.length > 0 && modal.groups.map((g) => (
                <div key={g.id} style={{ marginBottom: 14 }}>
                  <div className="section-title" style={{ marginTop: 0 }}>{t(g.name)} {g.required && <span className="badge red">{t('required')}</span>}</div>
                  <div className="option-list" role={g.type === 'single' ? 'radiogroup' : 'group'}>
                    {g.options.map((o) => {
                      const chosen = modal.chosen[g.id] || [];
                      const sel = g.type === 'single' ? chosen[0]?.id === o.id : chosen.some((x) => x.id === o.id);
                      return (
                        <button
                          type="button"
                          key={o.id}
                          className={`option-row ${sel ? 'on' : ''}`}
                          role={g.type === 'single' ? 'radio' : 'checkbox'}
                          aria-checked={!!sel}
                          onClick={() => {
                            const line = { id: o.id, name: o.name, priceAdj: o.priceAdj, groupName: g.name };
                            setModal((m) => {
                              const cur = m.chosen[g.id] || [];
                              let next;
                              if (g.type === 'single') next = [line];
                              else next = cur.some((x) => x.id === o.id) ? cur.filter((x) => x.id !== o.id) : [...cur, line];
                              if (g.type === 'multiple' && g.maxSelect && next.length > g.maxSelect) next = next.slice(-g.maxSelect);
                              return { ...m, chosen: { ...m.chosen, [g.id]: next } };
                            });
                          }}
                        >
                          <span className="option-mark" aria-hidden="true">{sel && <Check size={13} />}</span>
                          <span className="option-name">{t(o.name)}</span>
                          {o.priceAdj !== 0 && <span className="option-price">{o.priceAdj > 0 ? '+' : ''}{fmtMoney(o.priceAdj)}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              <div className="field" style={{ marginBottom: 0 }}>
                <label>{t('Special request')}</label>
                <input value={modal.notes} onChange={(e) => setModal({ ...modal, notes: e.target.value })} placeholder={t('e.g. less spicy, no onion')} />
              </div>
            </>
          )}
        </Modal>
      )}

      {modal?.confirm && (
        <Modal title={t('Confirm order')} onClose={() => setModal({ cart: true })}>
          <p className="muted">{t('Place this order for')} <strong>{fmtMoney(total)}</strong>?</p>
          <div className="modal-foot">
            <button className="btn" onClick={() => setModal({ cart: true })}>{t('Back')}</button>
            <button className="btn success" onClick={placeOrder} disabled={busy}>{busy ? t('Placing…') : t('Yes, place order')}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

const STATUS_META = {
  pending: { label: 'Sent to kitchen', cls: 'amber', Icon: Clock },
  preparing: { label: 'Preparing', cls: 'amber', Icon: ChefHat },
  ready: { label: 'Ready for pickup', cls: 'blue', Icon: CheckCircle2 },
  served: { label: 'Served', cls: 'green', Icon: CheckCircle2 },
  cancelled: { label: 'Cancelled', cls: 'red', Icon: X },
};

function OrdersList({ orders, t }) {
  if (!orders.length) {
    return (
      <div className="empty">
        <div className="empty-icon"><ReceiptText /></div>
        <strong>{t('No orders yet')}</strong>
        <p>{t('Anything you order at this table will show up here with its status.')}</p>
      </div>
    );
  }
  return (
    <>
      <div className="spread" style={{ marginBottom: 12 }}>
        <span className="muted" style={{ fontSize: 12.5 }}>{orders.length} {t('order(s) this visit')}</span>
        <strong>{fmtMoney(orders.reduce((s, o) => s + o.total, 0))}</strong>
      </div>
      {orders.map((o) => {
        const paid = o.paymentStatus === 'paid';
        const base = paid ? STATUS_META.served : (STATUS_META[o.status] || STATUS_META.pending);
        const meta = { ...base, label: t(base.label) };
        const StatusIcon = meta.Icon;
        return (
          <div className="order-row" key={o.id}>
            <div className="spread" style={{ alignItems: 'center' }}>
              <span className="mono" style={{ fontWeight: 700 }}>{o.orderNumber}</span>
              <span className={`badge ${meta.cls}`}><StatusIcon size={12} /> {meta.label}</span>
            </div>
            <div className="order-items">
              {o.items.map((i) => <div key={i.productName}><span>{t(i.productName)} ×{i.quantity}</span></div>)}
            </div>
            <div className="spread" style={{ marginTop: 6 }}>
              <span className="muted" style={{ fontSize: 12 }}>{new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <strong style={{ fontSize: 14 }}>{fmtMoney(o.total)}</strong>
            </div>
          </div>
        );
      })}
    </>
  );
}