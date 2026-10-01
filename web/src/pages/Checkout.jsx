import React, { useCallback, useEffect, useRef, useState } from 'react';
import { get, post, put, del } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { Modal } from '../components/ui';
import LoyaltyModal from '../components/LoyaltyModal';
import Numpad, { NumpadDisplay } from '../components/Numpad';
import { useToast } from '../components/Toast';
import { X, Minus, Plus, SlidersHorizontal, Table2, ChevronDown, ChevronUp, Receipt, Check } from 'lucide-react';
import { useI18n } from '../i18n';

function createClientKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function Checkout() {
  const { t } = useI18n();
  const [cats, setCats] = useState([]);
  const [tables, setTables] = useState([]);
  const [cat, setCat] = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [orderType, setOrderType] = useState('dine_in');
  const [customer, setCustomer] = useState('');
  const [cart, setCart] = useState([]);
  const [modal, setModal] = useState(null);
  const [pickTableOpen, setPickTableOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState('cash');
  const [cdsLanguage, setCdsLanguage] = useState('th');
  const [received, setReceived] = useState('');
  const [draft, setDraft] = useState(null);
  const [ticketTotal, setTicketTotal] = useState(0);
  const ticketTotalRef = useRef(0);
  const [tableOrders, setTableOrders] = useState([]);
  const [promptPayRequest, setPromptPayRequest] = useState(null);
  const [orderDetail, setOrderDetail] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [syncState, setSyncState] = useState('idle');
  const [loyaltyRules, setLoyaltyRules] = useState(null);
  const [loyaltyTarget, setLoyaltyTarget] = useState(null);
  const toast = useToast();
  const translateRef = useRef(t);
  const selectedTableIdRef = useRef(null);
  const tableOrdersRequestRef = useRef(0);
  const draftRef = useRef(null);
  const draftKeyRef = useRef(null);
  const batchAttemptRef = useRef(null);
  const ticketGenerationRef = useRef(0);
  translateRef.current = t;
  selectedTableIdRef.current = selectedTable?.id ?? null;
  const pendingPromptPayId = promptPayRequest?.id || tableOrders.find((order) => order.paymentStatus === 'pending' && order.promptPayRequestId)?.promptPayRequestId || null;

  const [products, setProducts] = useState([]);
  const [modifiers, setModifiers] = useState([]);

  useEffect(() => {
    get('/loyalty/lookup?phone=').then((d) => setLoyaltyRules(d.rules)).catch(() => {});
    Promise.all([get('/categories'), get('/tables'), get('/products'), get('/modifier-groups'), get('/settings')])
      .then(([c, t, p, m, settings]) => {
        setCats(c);
        setTables(t);
        setProducts(p);
        setModifiers(m);
        setCdsLanguage(settings?.cdsLanguage === 'en' ? 'en' : 'th');
        setCat(c[0]?.id);
      })
      .catch((e) => toast(t(e.message), 'error'));
  }, []);

  function reloadTables() { get('/tables').then(setTables).catch(() => {}); }

  async function changeCdsLanguage(language) {
    const next = language === 'en' ? 'en' : 'th';
    const previous = cdsLanguage;
    setCdsLanguage(next);
    try { await put('/settings/cds-language', { language: next }); }
    catch (e) { setCdsLanguage(previous); toast(t(e.message), 'error'); }
  }

  function loadTableOrders(tid) {
    if (!tid) { tableOrdersRequestRef.current += 1; setTableOrders([]); return Promise.resolve([]); }
    const request = tableOrdersRequestRef.current + 1;
    tableOrdersRequestRef.current = request;
    return get('/orders?status=active')
      .then((all) => {
        if (request !== tableOrdersRequestRef.current || Number(selectedTableIdRef.current) !== Number(tid)) return [];
        const mine = all.filter((o) => Number(o.tableId) === Number(tid) && o.paymentStatus === 'pending' && o.status !== 'cancelled');
        setTableOrders(mine);
        return mine;
      })
      .catch(() => {
        if (request === tableOrdersRequestRef.current && Number(selectedTableIdRef.current) === Number(tid)) setTableOrders([]);
        return [];
      });
  }

  useEffect(() => {
    const tableId = selectedTable?.id;
    if (!tableId) {
      setTableOrders([]);
      return undefined;
    }
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const all = await get('/orders?status=active');
        if (active) setTableOrders(all.filter((o) => Number(o.tableId) === Number(tableId) && o.paymentStatus === 'pending' && o.status !== 'cancelled'));
      } catch (e) {
        // Keep the latest known table orders visible during brief network failures.
      } finally {
        inFlight = false;
      }
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedTable?.id]);

  async function chooseTable(table) {
    if (busy || pendingPromptPayId) return;
    setPickTableOpen(false);
    tableOrdersRequestRef.current += 1;
    setTableOrders([]);
    if (!table) {
      setSelectedTable(null);
      setOrderType('takeaway');
      setTableOrders([]);
      return;
    }
    if (table.status === 'occupied') {
      setSelectedTable(table);
      setOrderType('dine_in');
      return;
    }
    setBusy(true);
    try {
      const session = await post('/sessions', { tableId: table.id, guestCount: 1 });
      setSelectedTable({ ...table, status: 'occupied', session });
      setOrderType('dine_in');
      reloadTables();
      toast(`${t(table.name)} ${t('opened')}`, 'ok');
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  function addToCart(p) {
    const gs = modifiers.filter((g) => g.productId === p.id);
    if (gs.length) setModal({ product: p, groups: gs, chosen: {}, notes: '' });
    else pushLine(p, [], '');
  }

  function pushLine(p, chosen, notes) {
    if (busy || pendingPromptPayId) return;
    const mods = Object.values(chosen).flat().map((opt) => ({ group: opt.groupName, option: opt.name, adj: opt.priceAdj }));
    setCart((c) => {
      const key = JSON.stringify(mods);
      const i = c.findIndex((l) => l.productId === p.id && l.key === key && l.notes === notes);
      if (i >= 0) {
        const n = [...c];
        n[i] = { ...n[i], qty: n[i].qty + 1 };
        return n;
      }
      return [...c, { productId: p.id, name: p.name, unitPrice: p.price, qty: 1, mods, key, notes, adj: mods.reduce((s, m) => s + m.adj, 0) }];
    });
  }

  function changeQty(i, d) {
    if (busy || pendingPromptPayId) return;
    setCart((c) => {
      const n = [...c];
      const q = n[i].qty + d;
      if (q <= 0) n.splice(i, 1);
      else n[i] = { ...n[i], qty: q };
      return n;
    });
  }

  function removeLine(index) {
    if (busy || pendingPromptPayId) return;
    setCart((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  const subtotal = cart.reduce((s, l) => s + (l.unitPrice + l.adj) * l.qty, 0);
  const tableDue = tableOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const grandTotal = tableDue + (ticketTotal || subtotal);
  const changeDue = (Number(received) || 0) - grandTotal;

  const pendingRef = useRef(null);
  const syncPromiseRef = useRef(null);
  const syncErrorRef = useRef(false);

  const sendTicket = useCallback(async () => {
    if (syncPromiseRef.current) return syncPromiseRef.current;
    const request = (async () => {
      let allSent = true;
      while (pendingRef.current?.items?.length) {
        const pending = pendingRef.current;
        const payload = structuredClone(pending);
        const generation = ticketGenerationRef.current;
        const existingDraftId = draftRef.current;
        try {
          let order;
          if (existingDraftId) {
            order = await post(`/orders/${existingDraftId}/sync`, payload);
          } else {
            if (!draftKeyRef.current) draftKeyRef.current = createClientKey();
            order = await post('/orders', { ...payload, draft: true, clientKey: draftKeyRef.current });
            if (order.reused) order = await post(`/orders/${order.id}/sync`, payload);
          }
          if (generation !== ticketGenerationRef.current) {
            allSent = false;
            if (!existingDraftId && order.draft) await del(`/orders/${order.id}`).catch(() => {});
            return allSent;
          }
          if (!existingDraftId) {
            draftRef.current = order.id;
            setDraft(order);
          }
          ticketTotalRef.current = Number(order.total) || 0;
          setTicketTotal(order.total);
          setSyncState('ok');
          syncErrorRef.current = false;
        } catch (e) {
          allSent = false;
          if (generation !== ticketGenerationRef.current) return allSent;
          setSyncState('error');
          if (!syncErrorRef.current) toast(`${translateRef.current('Register sync failed')}: ${translateRef.current(e.message)}`, 'error');
          syncErrorRef.current = true;
        }
        if (JSON.stringify(pendingRef.current) === JSON.stringify(payload)) return allSent;
      }
      return false;
    })();
    syncPromiseRef.current = request;
    const result = await request;
    if (syncPromiseRef.current === request) syncPromiseRef.current = null;
    return result;
  }, [toast]);

  const clearTicket = useCallback(() => {
    ticketGenerationRef.current += 1;
    draftRef.current = null;
    draftKeyRef.current = null;
    pendingRef.current = null;
    syncErrorRef.current = false;
    ticketTotalRef.current = 0;
    setDraft(null);
    setTicketTotal(0);
    setSyncState('idle');
    setCartOpen(false);
  }, []);

  const discardDraft = useCallback(async () => {
    const id = draftRef.current;
    ticketGenerationRef.current += 1;
    draftRef.current = null;
    draftKeyRef.current = null;
    pendingRef.current = null;
    syncErrorRef.current = false;
    ticketTotalRef.current = 0;
    setDraft(null);
    setTicketTotal(0);
    setSyncState('idle');
    if (!id) return;
    try { await del(`/orders/${id}`); } catch (e) { /* already gone */ }
  }, []);

  useEffect(() => {
    if (!cart.length) {
      discardDraft();
      return;
    }
    pendingRef.current = {
      items: cart.map((l) => ({ productId: l.productId, quantity: l.qty, notes: l.notes || null, modifiers: l.mods })),
      tableId: selectedTable ? selectedTable.id : null,
      customerName: customer || null,
      orderType,
    };
    sendTicket();
  }, [cart, selectedTable, customer, orderType, sendTicket, discardDraft]);

  useEffect(() => {
    const tick = setInterval(sendTicket, 1000);
    const flush = () => {
      if (document.visibilityState === 'hidden' && pendingRef.current) sendTicket();
    };
    document.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      clearInterval(tick);
      document.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [sendTicket]);

  async function closePaidTable(sessionId, tableId) {
    if (!sessionId || !tableId) return false;
    return post(`/sessions/${sessionId}/close`, {});
  }

  async function finishPaidTable(sessionId, tableId) {
    if (!sessionId || !tableId) return false;
    if (!selectedTable || Number(selectedTable.id) !== Number(tableId) || Number(selectedTable.session?.id) !== Number(sessionId)) return false;
    try {
      const closed = await closePaidTable(sessionId, tableId);
      if (Number(closed.id) !== Number(sessionId) || closed.status !== 'closed') throw new Error('Table session changed; refresh the table and try again');
      tableOrdersRequestRef.current += 1;
      setSelectedTable((current) => current && Number(current.id) === Number(tableId) && Number(current.session?.id) === Number(sessionId) ? null : current);
      toast(t('Table closed · QR deactivated'), 'ok');
      return true;
    } catch (e) {
      toast(t(e.message), 'error');
      await loadTableOrders(tableId);
      return false;
    }
  }

  async function createPromptPayRequest(orderIds) {
    const signature = orderIds.slice().sort((a, b) => a - b).join(',');
    if (!batchAttemptRef.current || batchAttemptRef.current.signature !== signature) {
      batchAttemptRef.current = { signature, key: createClientKey() };
    }
    const result = await post('/orders/promptpay', { orderIds, idempotencyKey: batchAttemptRef.current.key });
    batchAttemptRef.current = null;
    return result;
  }

  async function confirmPromptPay(requestId) {
    if (!requestId || busy) return;
    setBusy(true);
    try {
      const result = await post(`/orders/promptpay/${requestId}/confirm`, {});
      setPromptPayRequest(null);
      clearTicket();
      setCart([]);
      setTableOrders([]);
      setReceived('');
      toast(t('PromptPay payment confirmed'), 'ok');
      const first = result.orders[0];
      if (first?.tableId && selectedTable && Number(first.tableId) === Number(selectedTable.id)) {
        const remaining = await get('/orders?status=active');
        if (remaining.some((order) => Number(order.tableId) === Number(first.tableId) && order.paymentStatus === 'pending')) await loadTableOrders(first.tableId);
        else await finishPaidTable(first.sessionId, first.tableId);
      }
      reloadTables();
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  async function payOneOrder(o) {
    if (busy) return;
    setBusy(true);
    try {
      if (method === 'promptpay') {
        const request = await createPromptPayRequest([o.id]);
        setPromptPayRequest(request);
        clearTicket();
        setOrderDetail(null);
        if (selectedTable && Number(selectedTable.id) === Number(o.tableId)) await loadTableOrders(selectedTable.id);
        toast(t('PromptPay QR sent to customer display'), 'ok');
        reloadTables();
        return;
      }
      const tendered = method === 'cash' && received ? Number(received) : Number(o.total);
      if (method === 'cash' && tendered < Number(o.total)) throw new Error('Cash received is less than the amount due');
      const change = method === 'cash' ? Math.max(0, tendered - Number(o.total)) : 0;
      const paid = await post(`/orders/${o.id}/checkout`, { method, received: tendered, change });
      toast(`${paid.orderNumber} · ${t('Order paid')} · ${fmtMoney(paid.total)}`, 'ok');
      setOrderDetail(null);
      if (selectedTable) {
        await finishPaidTable(paid.sessionId, selectedTable.id);
        reloadTables();
      }
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  // Charge is only reachable through here so loyalty is offered before money moves.
  async function startCharge() {
    if (busy) return;
    const r = loyaltyRules;
    if (!r || r.enabled === false || r.prompt === 'never') return placeOrder();
    const pending = tableOrders.filter((o) => o.paymentStatus === 'pending');
    let target = null;
    if (cart.length) {
      try {
        if (!await sendTicket()) throw new Error('Could not save the latest register ticket; payment was not taken.');
        target = draftRef.current;
      } catch (e) { toast(t(e.message), 'error'); return; }
    } else {
      target = pending.length ? pending[pending.length - 1].id : null;
    }
    if (!target) return placeOrder();
    setLoyaltyTarget(target);
  }

  async function onLoyaltyApplied() {
    setLoyaltyTarget(null);
    if (selectedTable) await loadTableOrders(selectedTable.id).catch(() => {});
    reloadTables();
    placeOrder();
  }

  async function placeOrder() {
    const pending = tableOrders.filter((o) => o.paymentStatus === 'pending');
    if (!cart.length && !pending.length) return;
    if (busy || pendingPromptPayId) return;
    setBusy(true);
    try {
      if (cart.length) {
        pendingRef.current = {
          items: cart.map((l) => ({ productId: l.productId, quantity: l.qty, notes: l.notes || null, modifiers: l.mods })),
          tableId: selectedTable ? selectedTable.id : null,
          customerName: customer || null,
          orderType,
        };
        if (!await sendTicket()) throw new Error('Could not save the latest register ticket; payment was not taken.');
      }

      const amountDue = tableDue + (cart.length ? ticketTotalRef.current : 0);
      if (method === 'cash' && received && Number(received) < amountDue) {
        throw new Error('Cash received is less than the amount due');
      }
      const tableId = selectedTable ? selectedTable.id : null;
      const paymentOrders = pending.map((order) => ({ id: order.id }));
      const draftId = cart.length ? draftRef.current : null;
      if (cart.length && !draftId) throw new Error('Could not save the latest register ticket; payment was not taken.');
      if (draftId) paymentOrders.push({ id: draftId });
      if (method === 'promptpay') {
        const request = await createPromptPayRequest(paymentOrders.map((order) => order.id));
        setPromptPayRequest(request);
        clearTicket();
        setCart([]);
        setTableOrders([]);
        setReceived('');
        setOrderType('dine_in');
        setCustomer('');
        if (tableId) await loadTableOrders(tableId);
        toast(t('PromptPay QR sent to customer display'), 'ok');
        reloadTables();
        return;
      }
      const signature = paymentOrders.map((order) => order.id).sort((a, b) => a - b).join(',');
      if (!batchAttemptRef.current || batchAttemptRef.current.signature !== signature) {
        batchAttemptRef.current = { signature, key: createClientKey() };
      }

      const result = await post('/orders/checkout-batch', {
        orders: paymentOrders,
        idempotencyKey: batchAttemptRef.current.key,
        method,
        received: method === 'cash' && received ? Number(received) : undefined,
      });
      batchAttemptRef.current = null;
      const paidNumbers = result.orders.map((order) => order.orderNumber);
      const amountPaid = Number(result.total) || 0;
      let sessionId = null;
      for (const order of result.orders) if (order.sessionId) sessionId = order.sessionId;

      toast(
        paidNumbers.length > 1
          ? `${paidNumbers.length} ${t('Orders paid')} · ${fmtMoney(amountPaid)}`
          : `${paidNumbers[0]} · ${t('Paid with')} ${t(method)}`,
        'ok'
      );

      const tid = tableId;
      clearTicket();
      setCart([]);
      setTableOrders([]);
      setReceived('');
      setOrderType('dine_in');
      setCustomer('');

      if (tid) {
        await finishPaidTable(sessionId, tid);
        reloadTables();
      }
    } catch (e) {
      if (selectedTable) await loadTableOrders(selectedTable.id);
      toast(t(e.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  const activeCat = cats.find((c) => c.id === cat) || cats[0];
  const catProducts = products.filter((p) => p.categoryId === activeCat?.id && p.available);
  const itemCount = cart.reduce((s, l) => s + l.qty, 0)
    + tableOrders.reduce((s, o) => s + (o.items || []).reduce((a, i) => a + i.quantity, 0), 0);
  const hasItems = cart.length > 0 || tableOrders.length > 0 || Boolean(promptPayRequest);

  return (
    <div className="content pos-page" style={{ paddingTop: 18 }}>
      <div className="pos-wrap">
        <div>
          <div className="pos-controls">
            <button className="ctrl-btn" onClick={() => setPickTableOpen(true)} disabled={busy || Boolean(pendingPromptPayId)}>
              <Table2 size={15} />
              <span>{selectedTable ? t(selectedTable.name) : `${t('Takeaway')} / ${t('Walk-in')}`}</span>
              <ChevronDown size={15} />
            </button>
            <div className="seg">
              {['dine_in', 'takeaway', 'delivery'].map((k) => (
                <button key={k} className={orderType === k ? 'on' : ''} onClick={() => setOrderType(k)} disabled={busy || Boolean(pendingPromptPayId)}>
                  {t(k === 'dine_in' ? 'Dine-in' : k === 'takeaway' ? 'Takeaway' : 'Delivery')}
                </button>
              ))}
            </div>
            <input className="ctrl-input" placeholder={t('Customer name')} value={customer} onChange={(e) => setCustomer(e.target.value)} disabled={busy || Boolean(pendingPromptPayId)} />
            <label className="cds-language-control">
              <span>CDS</span>
              <select value={cdsLanguage} onChange={(e) => changeCdsLanguage(e.target.value)}>
                <option value="th">ไทย</option>
                <option value="en">EN</option>
              </select>
            </label>
          </div>

          <div className="pub-menu pos-cats">
            {cats.map((c) => <button key={c.id} className={activeCat?.id === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>{t(c.name)}</button>)}
          </div>

          <div className="pos-menu mt">
            {catProducts.map((p) => (
              <button key={p.id} className="pos-item" onClick={() => addToCart(p)} disabled={busy || Boolean(pendingPromptPayId)}>
                <div className="nm">{t(p.name)}</div>
                <div className="pr">{fmtMoney(p.price)}</div>
                {modifiers.some((g) => g.productId === p.id) && <div className="muted" style={{ fontSize: 11, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}><SlidersHorizontal size={11} /> {t('options')}</div>}
              </button>
            ))}
            {catProducts.length === 0 && <div className="muted" style={{ gridColumn: '1 / -1' }}>{t('No items in this category.')}</div>}
          </div>
        </div>

        <aside className={`pos-cart${cartOpen ? ' open' : ''}${hasItems ? '' : ' empty'}`}>
          <div
            className="cart-dock-head"
            role="button"
            tabIndex={0}
            aria-expanded={cartOpen}
            onClick={() => setCartOpen((o) => !o)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCartOpen((o) => !o); } }}
          >
            <div className="cd-info">
              <strong>{itemCount} {t(itemCount === 1 ? 'item' : 'items')}</strong>
              <span className="muted">{selectedTable ? `${t('Table')} ${t(selectedTable.name)}` : t('Takeaway')} · {fmtMoney(grandTotal)}</span>
            </div>
            <div className="cd-actions">
              <button
                className="btn success cd-charge"
                onClick={(e) => { e.stopPropagation(); startCharge(); }}
                disabled={busy || Boolean(pendingPromptPayId)}
              >
                {pendingPromptPayId ? t('PromptPay pending') : busy ? '…' : `${t('Charge')} ${fmtMoney(grandTotal)}`}
              </button>
              <span className="cd-chevron">{cartOpen ? <ChevronDown size={17} /> : <ChevronUp size={17} />}</span>
            </div>
          </div>

          <div className="cart-body">
          <h3>{t('Current order')}</h3>
          {draft && (
            <div className="spread" style={{ marginBottom: 8 }}>
              <span className="badge indigo">{t('Ticket')} {draft.orderNumber}</span>
              <span className={`sync-pill ${syncState}`} title={t('Sends to the customer display every second')}>
                <span className="dot" /> {t(syncState === 'error' ? 'Sync error' : 'Synced')}
              </span>
            </div>
          )}

          {tableOrders.length > 0 && (
            <div className="table-orders">
              <div className="to-head">
                {t('Ordered at')} {selectedTable ? t(selectedTable.name) : t('table')}
                <span className="badge amber">{tableOrders.length}</span>
              </div>
              {tableOrders.map((o) => (
                <button className="to-order" key={o.id} onClick={() => setOrderDetail(o)}>
                  <div className="spread" style={{ alignItems: 'center' }}>
                    <span className="mono" style={{ fontWeight: 650, fontSize: 12.5 }}>{o.orderNumber}</span>
                    <span className="row" style={{ gap: 8 }}>
                      <strong style={{ fontSize: 13.5 }}>{fmtMoney(o.total)}</strong>
                      <Receipt size={13} />
                    </span>
                  </div>
                  {o.items.map((i) => (
                    <div className="to-item" key={i.id}>
                      <span>{i.quantity}× {t(i.productName)}</span>
                      <span className="muted">{fmtMoney(i.unitPrice * i.quantity)}</span>
                    </div>
                  ))}
                  <div className="to-tap">{t('Tap to open · pay on its own or with the whole table')}</div>
                </button>
              ))}
            </div>
          )}

          {!cart.length && tableOrders.length === 0 && !pendingPromptPayId && <div className="muted" style={{ padding: '12px 0' }}>{t('Cart is empty. Tap a menu item.')}</div>}
          {cart.map((l, i) => (
            <div className="cart-line" key={i}>
              <div className="ln">
                {t(l.name)}
                {l.mods?.map((m, j) => <span key={j} className="mod">+ {t(m.option)}</span>)}
                {l.notes && <span className="mod">“{l.notes}”</span>}
              </div>
              <div className="qty">
                <button onClick={() => changeQty(i, -1)} aria-label={t('Decrease')} disabled={busy}><Minus /></button>
                <span style={{ width: 18, textAlign: 'center' }}>{l.qty}</span>
                <button onClick={() => changeQty(i, 1)} aria-label={t('Increase')} disabled={busy}><Plus /></button>
              </div>
              <strong style={{ width: 62, textAlign: 'right' }}>{fmtMoney((l.unitPrice + l.adj) * l.qty)}</strong>
              <button className="btn sm ghost" onClick={() => removeLine(i)} aria-label={t('Remove')} disabled={busy}><X /></button>
            </div>
          ))}
          {(cart.length > 0 || tableOrders.length > 0 || promptPayRequest) && (
            <>
              <div className="cart-total">
                <span>{t('Due')}{tableOrders.length > 0 ? ` (${tableOrders.length + (cart.length ? 1 : 0)} ${t('order(s)')})` : ''}</span>
                <span>{fmtMoney(promptPayRequest?.amount || grandTotal)}</span>
              </div>
              {pendingPromptPayId ? (
                <div className="promptpay-pending">
                  <strong>PromptPay</strong>
                  <span>{t('QR sent to customer display. Confirm after the customer has paid.')}</span>
                  <button className="btn success" onClick={() => confirmPromptPay(pendingPromptPayId)} disabled={busy}>
                    {busy ? t('Processing…') : t('Confirm PromptPay received')}
                  </button>
                </div>
              ) : (
                <>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <div className="muted">{t('Pay with')}</div>
                    <div className="row">
                      {['cash', 'card', 'other', 'promptpay'].map((m) => (
                        <button key={m} className={`btn sm ${method === m ? 'primary' : ''}`} onClick={() => setMethod(m)} disabled={busy}>{t(m)}</button>
                      ))}
                    </div>
                  </div>
                  {method === 'cash' && (
                    <div className="field" style={{ marginTop: 10 }}>
                      <label>{t('Cash received')}</label>
                      <NumpadDisplay value={received} placeholder="0" />
                      <div className="change-row">
                        <span className="muted">{t('Change')}</span>
                        <strong className={changeDue > 0 ? 'change-ok' : 'change-none'}>
                          {fmtMoney(Math.max(0, changeDue))}
                        </strong>
                      </div>
                      <Numpad value={received} onChange={setReceived} compact />
                    </div>
                  )}
                  <button className="btn success" style={{ width: '100%', padding: 12, marginTop: 8 }} onClick={startCharge} disabled={busy}>
                    {busy ? t('Processing…') : `${t('Charge')} ${fmtMoney(grandTotal)}`}
                  </button>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 8, textAlign: 'center' }}>
                    {t('Charge')} {selectedTable ? t(selectedTable.name) : t('This ticket')} · {t('Tax & service included.')}
                  </div>
                </>
              )}
            </>
          )}
          </div>
        </aside>
      </div>

      {orderDetail && (
        <Modal title={`${orderDetail.orderNumber} · ${t('Ordered by customer')}`} onClose={() => setOrderDetail(null)}
          footer={<>
            <button className="btn" onClick={() => setOrderDetail(null)}>{t('Close')}</button>
            {orderDetail.paymentStatus === 'pending' && (
              <button className="btn success" onClick={() => orderDetail.promptPayRequestId ? confirmPromptPay(orderDetail.promptPayRequestId) : payOneOrder(orderDetail)} disabled={busy}>
                {busy ? t('Processing…') : orderDetail.promptPayRequestId ? t('Confirm PromptPay received') : `${t('Pay')} ${fmtMoney(orderDetail.total)}`}
              </button>
            )}
          </>}>
          <div className="row" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
            {selectedTable && <span className="badge amber">{t(selectedTable.name)}</span>}
            <span className="muted">{new Date(orderDetail.createdAt).toLocaleString()}</span>
          </div>
          {orderDetail.items.map((i) => (
            <div className="cart-line" key={i.id}>
              <div className="ln">
                {t(i.productName)} × {i.quantity}
                {i.notes && <span className="mod">“{i.notes}”</span>}
              </div>
              <strong>{fmtMoney(i.unitPrice * i.quantity)}</strong>
            </div>
          ))}
          <div style={{ marginTop: 10 }}>
            <div className="spread"><span className="muted">{t('Subtotal')}</span><span>{fmtMoney(orderDetail.subtotal)}</span></div>
            <div className="spread"><span className="muted">{t('Tax')}</span><span>{fmtMoney(orderDetail.tax)}</span></div>
            <div className="spread"><span className="muted">{t('Service charge')}</span><span>{fmtMoney(orderDetail.serviceCharge)}</span></div>
            <div className="spread" style={{ fontWeight: 700, fontSize: 16, marginTop: 6 }}><span>{t('Total')}</span><span>{fmtMoney(orderDetail.total)}</span></div>
          </div>
          {!orderDetail.promptPayRequestId && <div className="row mt" style={{ justifyContent: 'space-between' }}>
            <span className="muted">{t('Pay with')}</span>
            <div className="row">
              {['cash', 'card', 'other', 'promptpay'].map((m) => (
                <button key={m} className={`btn sm ${method === m ? 'primary' : ''}`} onClick={() => setMethod(m)}>{t(m)}</button>
              ))}
            </div>
          </div>}
        </Modal>
      )}

      {pickTableOpen && (
        <Modal title={t('Choose a table')} onClose={() => setPickTableOpen(false)}>
          <button className="table-pick" onClick={() => chooseTable(null)}>
            <Receipt size={17} />
            <span className="tp-name">{t('Takeaway')} / {t('Walk-in')}</span>
          </button>
          <div className="table-grid">
            {tables.map((tbl) => (
              <button key={tbl.id} className={`table-pick ${tbl.status}`} disabled={busy} onClick={() => chooseTable(tbl)}>
                <span className="tp-name">{t(tbl.name)}</span>
                <span className="tp-meta">{tbl.status === 'occupied' ? t('occupied') : `${tbl.seats} ${t('seats')}`}</span>
              </button>
            ))}
          </div>
          {tables.length === 0 && <p className="muted">{t('No tables configured. Add them in Settings.')}</p>}
        </Modal>
      )}

      {modal && (
        <Modal title={t(modal.product.name)} onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn" onClick={() => setModal(null)}>{t('Cancel')}</button>
              <button className="btn primary" onClick={() => { pushLine(modal.product, modal.chosen, modal.notes); setModal(null); }}>{t('Add to order')}</button>
            </>
          }>
          {modal.groups.map((g) => (
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
        </Modal>
      )}

      {loyaltyTarget && (
        <LoyaltyModal
          orderId={loyaltyTarget}
          onClose={loyaltyRules?.requirePhone ? () => {} : () => setLoyaltyTarget(null)}
          onApplied={onLoyaltyApplied}
        />
      )}
    </div>
  );
}
