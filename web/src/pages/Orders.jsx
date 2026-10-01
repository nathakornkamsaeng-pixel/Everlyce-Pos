import React, { useEffect, useState } from 'react';
import { get, put, post } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { Modal, StatusBadge, Confirm } from '../components/ui';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

const STATUSES = ['pending', 'preparing', 'ready', 'served', 'cancelled'];

function clientKey() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function Orders() {
  const { t } = useI18n();
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('active');
  const [open, setOpen] = useState(null);
  const [payMethod, setPayMethod] = useState('cash');
  const [tip, setTip] = useState('');
  const toast = useToast();

  function load() {
    const q = filter === 'active' ? '?status=active' : '';
    get(`/orders${q}`).then(setOrders).catch(() => {});
  }
  useEffect(() => { load(); }, [filter]);

  async function setStatus(o, status) {
    try { await put(`/orders/${o.id}/status`, { status }); toast(t('Updated'), 'ok'); load(); if (open?.id === o.id) setOpen({ ...open, status }); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  async function confirmPromptPay() {
    if (!open?.promptPayRequestId) return;
    try {
      const result = await post(`/orders/promptpay/${open.promptPayRequestId}/confirm`, {});
      toast(t('PromptPay payment confirmed'), 'ok');
      setOpen(null);
      load();
      const first = result.orders[0];
      if (first?.sessionId && first.tableId) {
        try { await post(`/sessions/${first.sessionId}/close`, {}); }
        catch (e) { toast(t(e.message), 'error'); }
      }
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function checkout() {
    if (open?.promptPayRequestId) return confirmPromptPay();
    if (payMethod === 'promptpay') {
      try {
        const result = await post('/orders/promptpay', { orderIds: [open.id], idempotencyKey: clientKey() });
        toast(t('PromptPay QR sent to customer display'), 'ok');
        setOpen(result.orders[0]);
        load();
      } catch (e) { toast(t(e.message), 'error'); }
      return;
    }
    let paid;
    try {
      paid = await post(`/orders/${open.id}/checkout`, { method: payMethod, tip: tip ? Number(tip) : 0 });
    } catch (e) {
      toast(t(e.message), 'error');
      return;
    }
    toast(t('Order paid'), 'ok');
    setOpen(null);
    load();
    if (paid.sessionId && open.tableId) {
      try { await post(`/sessions/${paid.sessionId}/close`, {}); }
      catch (e) { toast(t(e.message), 'error'); }
    }
  }

  async function voidOrder() {
    try { await post(`/orders/${open.id}/void`, {}); toast(t('Order voided'), 'ok'); setOpen(null); load(); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  const isActive = (o) => o.paymentStatus === 'pending' && o.status !== 'cancelled';

  return (
    <>
      <div className="topbar">
        <h1>{t('Orders')}</h1>
        <div className="row">
          {['active', 'all'].map((f) => (
            <button key={f} className={`btn ${filter === f ? 'primary' : ''}`} onClick={() => setFilter(f)}>{t(f === 'active' ? 'Active' : 'All')}</button>
          ))}
        </div>
      </div>
      <div className="content">
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Order')}</th><th>{t('Type')}</th><th>{t('Customer')}</th><th>{t('Status')}</th><th>{t('Payment')}</th><th className="num">{t('Total')}</th><th></th></tr></thead>
              <tbody>
                {orders.length === 0 && <tr><td colSpan={7} className="muted">{t('No orders.')}</td></tr>}
                {orders.map((o) => (
                  <tr key={o.id} className="clickable" onClick={() => setOpen(o)}>
                    <td className="mono">{o.orderNumber}</td>
                    <td>{t(o.orderType === 'dine_in' ? 'Dine-in' : o.orderType)} {o.tableName && `· ${t(o.tableName)}`}</td>
                    <td>{o.customerName || '—'}</td>
                    <td><StatusBadge status={o.status} /></td>
                    <td>{o.paymentStatus === 'paid' ? <span className="badge green">{t('paid')} · {t(o.paymentMethod)}</span> : o.paymentStatus === 'voided' ? <span className="badge red">{t('voided')}</span> : o.promptPayRequestId ? <span className="badge amber">PromptPay · {t('pending')}</span> : <span className="badge amber">{t('unpaid')}</span>}</td>
                    <td className="num"><strong>{fmtMoney(o.total)}</strong></td>
                    <td className="num">
                      <button className="btn sm" onClick={(e) => { e.stopPropagation(); setOpen(o); }}>{t('View')}</button>
                      {isActive(o) && <button className="btn sm success" onClick={(e) => { e.stopPropagation(); setOpen(o); }}>{o.promptPayRequestId ? t('Confirm') : t('Pay')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {open && (
        <Modal title={`${open.orderNumber} · ${t(open.orderType === 'dine_in' ? 'Dine-in' : open.orderType)}`} onClose={() => setOpen(null)}
          footer={<>
            <button className="btn danger" onClick={voidOrder} disabled={open.paymentStatus === 'paid' || Boolean(open.promptPayRequestId)}>{t('Void')}</button>
            <button className="btn" onClick={() => setOpen(null)}>{t('Close')}</button>
            {isActive(open) && <button className="btn success" onClick={checkout}>{open.promptPayRequestId ? t('Confirm PromptPay received') : `${t('Pay')} ${fmtMoney(open.total)}`}</button>}
          </>}>
          <div className="row" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
            <StatusBadge status={open.status} />
            <StatusBadge status={open.paymentStatus} />
            {open.tableName && <span className="muted">{t(open.tableName)}</span>}
            {open.customerName && <span>{open.customerName}</span>}
          </div>
          <div className="section-title" style={{ marginTop: 0 }}>{t('Items')}</div>
          {open.items.map((it) => {
            let mods = [];
            try { mods = JSON.parse(it.modifiers || '[]'); } catch (e) {}
            return (
              <div key={it.id} className="cart-line" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="ln">{t(it.productName)} × {it.quantity}{mods.map((m, j) => <span key={j} className="mod">+ {t(m.option)}</span>)}</div>
                <strong>{fmtMoney(it.unitPrice * it.quantity)}</strong>
              </div>
            );
          })}
          <div style={{ marginTop: 10 }}>
            <div className="spread"><span className="muted">{t('Subtotal')}</span><span>{fmtMoney(open.subtotal)}</span></div>
            <div className="spread"><span className="muted">{t('Tax')}</span><span>{fmtMoney(open.tax)}</span></div>
            <div className="spread"><span className="muted">{t('Service charge')}</span><span>{fmtMoney(open.serviceCharge)}</span></div>
            {open.discount > 0 && <div className="spread"><span className="muted">{t('Discount')}</span><span>-{fmtMoney(open.discount)}</span></div>}
            {open.tip > 0 && <div className="spread"><span className="muted">{t('Tip')}</span><span>{fmtMoney(open.tip)}</span></div>}
            <div className="spread" style={{ fontWeight: 700, fontSize: 16, marginTop: 6 }}><span>{t('Total')}</span><span>{fmtMoney(open.total)}</span></div>
          </div>
          {isActive(open) && !open.promptPayRequestId && (
            <div className="row mt" style={{ justifyContent: 'flex-end' }}>
              {['cash', 'card', 'other', 'promptpay'].map((m) => (
                <button key={m} className={`btn sm ${payMethod === m ? 'primary' : ''}`} onClick={() => setPayMethod(m)}>{t(m)}</button>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}