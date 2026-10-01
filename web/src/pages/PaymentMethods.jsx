import React, { useEffect, useState } from 'react';
import { get, put } from '../lib/api';
import { useToast } from '../components/Toast';
import { Check, Plus, X, CreditCard, AlertTriangle, GripVertical } from 'lucide-react';
import { useI18n } from '../i18n';

// The payment methods this shop takes.
//
// Per shop, and the shop's own list: what it has switched on, in the order its
// staff will meet it, plus anything it has added itself. Custom methods are real
// and needed. A Thai shop taking TrueMoney over the counter, or a market stall
// on bank transfer, is not covered by any gateway we ship.
//
// "Immediate" is the part that matters and is easy to get wrong. Immediate means
// the till treats the money as in the drawer and a cashier can void the order.
// Deferred means it waits for a confirmation nobody can rush, and cannot be
// voided at the till. Getting that the wrong way round lets a cashier take money
// for a payment that never arrived.

const IMMEDIATE_HINT = 'Cashier can void this at the till.';
const DEFERRED_HINT = 'Waits for confirmation. Cannot be voided at the till.';

export default function PaymentMethods() {
  const { t } = useI18n();
  const toast = useToast();
  const [methods, setMethods] = useState(null);
  const [available, setAvailable] = useState([]);
  const [busy, setBusy] = useState(false);

  function load() {
    get('/shop-settings/methods').then((d) => {
      setMethods(d.methods || []);
      setAvailable(d.available || []);
    }).catch((e) => toast(e.message, 'error'));
  }
  useEffect(() => { load(); }, []);

  if (!methods) return null;

  function update(next) {
    setMethods(next);
  }

  function toggle(gatewayId, label, deferred) {
    const on = methods.some((m) => m.id === gatewayId);
    const next = on
      ? methods.filter((m) => m.id !== gatewayId)
      : [...methods, { id: gatewayId, label, kind: deferred ? 'deferred' : 'immediate', custom: false }];
    update(next);
  }

  function setKind(id, kind) {
    update(methods.map((m) => (m.id === id ? { ...m, kind } : m)));
  }

  function remove(id) {
    update(methods.filter((m) => m.id !== id));
  }

  function move(id, delta) {
    const at = methods.findIndex((m) => m.id === id);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= methods.length) return;
    const next = methods.slice();
    const [moved] = next.splice(at, 1);
    next.splice(to, 0, moved);
    update(next);
  }

  async function save() {
    setBusy(true);
    try {
      const d = await put('/shop-settings/methods', { methods });
      setMethods(d.methods || []);
      toast(t('Saved. Your till will show these in this order.'), 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  const active = methods.filter((m) => m.id !== 'cash');
  const off = available.filter((p) => p.id !== 'cash' && !methods.some((m) => m.id === p.id));

  return (
    <div className="card mt" style={{ maxWidth: 720 }}>
      <div className="section-title mb0" style={{ marginTop: 0 }}>
        <CreditCard size={16} /> {t('Payment methods')}
      </div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 14 }}>
        {t('What your till offers at the counter, in the order your staff see them. Cash is always there.')}
      </div>

      <ul className="method-list">
        {methods.map((m, i) => (
          <li key={m.id} className="method-row">
            <div className="method-grip">
              <button className="linkish" onClick={() => move(m.id, -1)} disabled={i === 0} aria-label={t('Move up')}>↑</button>
              <button className="linkish" onClick={() => move(m.id, 1)} disabled={i === methods.length - 1} aria-label={t('Move down')}>↓</button>
            </div>
            <div className="method-info">
              <strong>{m.label}{m.custom ? <span className="badge blue" style={{ marginLeft: 6 }}>{t('yours')}</span> : null}</strong>
              {m.id === 'cash' ? (
                <span className="muted">{t('Always available. Cash is not a setting.')}</span>
              ) : (
                <select
                  value={m.kind}
                  onChange={(e) => setKind(m.id, e.target.value)}
                  style={{ marginTop: 4, maxWidth: 380 }}
                >
                  <option value="immediate">{t('Takes money straight away')}</option>
                  <option value="deferred">{t('Waits for confirmation')}</option>
                </select>
              )}
            </div>
            {m.id !== 'cash' ? (
              <button className="btn sm danger" onClick={() => remove(m.id)}>
                <X size={14} /> {t('Remove')}
              </button>
            ) : null}
          </li>
        ))}
      </ul>

      {active.some((m) => m.kind === 'deferred') ? (
        <p className="warn-strip" style={{ marginTop: 12 }}>
          <AlertTriangle size={14} />
          <span>
            {t('A method that waits cannot be voided at the till. If the money never arrives the order has to be cancelled from the order list instead.')}
          </span>
        </p>
      ) : null}

      {off.length ? (
        <>
          <div className="section-title mt">{t('Add one of these')}</div>
          <div className="chips">
            {off.map((p) => (
              <button key={p.id} className="chip" onClick={() => toggle(p.id, p.label, !p.settledSynchronously)}>
                <Plus size={13} /> {p.label}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          <Check size={15} /> {busy ? t('Saving') : t('Save payment methods')}
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {t('Settings are saved when you click Save. Nothing changes on the till until then.')}
        </span>
      </div>
    </div>
  );
}