import React, { useCallback, useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { useToast } from '../components/Toast';
import { Modal } from '../components/ui';
import { useI18n } from '../i18n';
import { UserPlus, Search, Ticket, Sparkles, Trash2, Check } from 'lucide-react';
import Numpad, { NumpadDisplay } from './Numpad';

const fmt = (n) => `฿${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// The register-side loyalty flow: identify the member, then spend points and
// coupons before the cashier takes any money.
export default function LoyaltyModal({ orderId, onClose, onApplied }) {
  const [step, setStep] = useState('phone');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [member, setMember] = useState(null);
  const [rules, setRules] = useState(null);
  const [maxPoints, setMaxPoints] = useState(0);
  const [points, setPoints] = useState(0);
  const [code, setCode] = useState('');
  const [coupons, setCoupons] = useState([]);
  const [quote, setQuote] = useState(null);
  const [err, setErr] = useState('');
  const [reg, setReg] = useState({ name: '', phone: '', email: '' });
  const toast = useToast();
  const { t } = useI18n();

  const loadRules = useCallback(() => {
    get('/loyalty/lookup?phone=').then((d) => setRules(d.rules)).catch(() => {});
  }, []);
  useEffect(() => { loadRules(); }, [loadRules]);

  const requote = useCallback(async (m, cs, pts) => {
    try {
      const q = await post('/loyalty/quote', { orderId, memberId: m ? m.id : null, codes: cs, pointsToUse: pts });
      setQuote(q);
      setMaxPoints(q.maxRedeemablePoints);
      setErr('');
    } catch (e) {
      setQuote(null);
      setErr(t(e.message));
    }
  }, [orderId]);

  async function find() {
    if (!phone.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const d = await get(`/loyalty/lookup?phone=${encodeURIComponent(phone.trim())}`);
      setRules(d.rules);
      if (d.found) {
        setMember(d.member);
        setMaxPoints(d.maxRedeemablePoints);
        setPhone(d.member.phone || phone);
        setStep('redeem');
        requote(d.member, [], 0);
      } else if (rules?.autoRegister) {
        setReg({ name: '', phone, email: '' });
        setStep('register');
      } else {
        setReg({ name: '', phone, email: '' });
        setStep('register');
      }
    } catch (e) { setErr(t(e.message)); }
    finally { setBusy(false); }
  }

  async function register() {
    if (!reg.name.trim()) return setErr(t('Name is required'));
    if (!reg.phone.trim()) return setErr(t('Phone is required'));
    setBusy(true);
    setErr('');
    try {
      const m = await post('/loyalty/register', { name: reg.name.trim(), phone: reg.phone.trim(), email: reg.email.trim() || null });
      setMember(m);
      setPhone(m.phone);
      setStep('redeem');
      requote(m, [], 0);
      toast(t('Member registered'), 'ok');
    } catch (e) { setErr(t(e.message)); }
    finally { setBusy(false); }
  }

  async function addCode() {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const next = [...coupons, code.trim().toUpperCase()];
      await requote(member, next, points);
      setCoupons(next);
      setCode('');
    } finally { setBusy(false); }
  }

  async function removeCode(c) {
    setBusy(true);
    try {
      const next = coupons.filter((x) => x !== c);
      await requote(member, next, points);
      setCoupons(next);
    } finally { setBusy(false); }
  }

  async function changePoints(next) {
    const v = Math.max(0, Math.min(maxPoints, Number(next) || 0));
    setPoints(v);
    await requote(member, coupons, v);
  }

  async function apply() {
    if (!quote) return;
    setBusy(true);
    try {
      const r = await post('/loyalty/apply', { orderId, memberId: member ? member.id : null, codes: coupons, pointsToUse: points });
      toast(`${t('Applied')} · ${fmt(r.discount)}`, 'ok');
      onApplied(r);
    } catch (e) { setErr(t(e.message)); }
    finally { setBusy(false); }
  }

  async function skip() {
    setBusy(true);
    try {
      await post('/loyalty/clear', { orderId });
      onApplied(null);
    } catch (e) { setErr(t(e.message)); }
    finally { setBusy(false); }
  }

  const canSkip = rules?.allowSkip !== false && !rules?.requirePhone;

  return (
    <Modal title={t('Loyalty')} onClose={onClose} wide
      footer={step === 'redeem' ? (
        <>
          {member && !rules?.requirePhone && <button className="btn" onClick={skip} disabled={busy}>{t('Remove loyalty')}</button>}
          {canSkip && <button className="btn" onClick={skip} disabled={busy}>{t('No thanks')}</button>}
          <button className="btn primary" onClick={apply} disabled={busy || !quote}>{busy ? '…' : t('Apply')}</button>
        </>
      ) : (
        rules?.requirePhone && !member
          ? <div className="muted" style={{ fontSize: 12.5 }}>{t('A member is required before payment.')}</div>
          : <button className="btn" onClick={onClose}>{t('Cancel')}</button>
      )}>
      {rules && rules.enabled === false && (
        <div className="loyalty-new">{t('Loyalty is switched off in Settings.')}</div>
      )}

      {step === 'phone' && (
        <div>
          <div className="muted" style={{ marginBottom: 10 }}>{t('Enter the phone number on the loyalty card, or the member’s mobile number.')}</div>
          <div className="loyalty-phone-row">
            <NumpadDisplay value={phone} placeholder="08x-xxx-xxxx" />
            <button className="btn primary" onClick={find} disabled={busy || !phone.trim()}>
              <Search size={18} /> {t('Find member')}
            </button>
          </div>
          <Numpad value={phone} onChange={setPhone} allowDecimal={false} clearKey maxLength={15} />
          {err && <div className="error-text mt">{err}</div>}
        </div>
      )}

      {step === 'register' && (
        <div>
          <div className="loyalty-new">
            <strong>{t('No member with that number')}</strong>
            <div className="muted" style={{ marginTop: 4 }}>{t('Register them now, or go back and charge without loyalty.')}</div>
          </div>
          <div className="form-grid">
            <div className="field"><label>{t('Name')}</label>
              <input value={reg.name} onChange={(e) => setReg({ ...reg, name: e.target.value })} placeholder={t('Name')} autoFocus />
            </div>
            <div className="field"><label>{t('Phone')}</label>
              <NumpadDisplay value={reg.phone} placeholder="08x-xxx-xxxx" />
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <Numpad value={reg.phone} onChange={(v) => setReg({ ...reg, phone: v })} allowDecimal={false} clearKey maxLength={15} />
            </div>
            <div className="field"><label>{t('Email')} ({t('optional')})</label>
              <input value={reg.email} onChange={(e) => setReg({ ...reg, email: e.target.value })} placeholder="name@example.com" />
            </div>
          </div>
          {err && <div className="error-text mt">{err}</div>}
          <div className="row mt" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => { setErr(''); setStep('phone'); }}>{t('Back')}</button>
            <button className="btn primary" onClick={register} disabled={busy}>
              <UserPlus size={17} /> {t('Register member')}
            </button>
          </div>
        </div>
      )}

      {step === 'redeem' && (
        <div>
          <div className="loyalty-hit">
            <div className="who">
              <strong>{member?.name}</strong>
              <div className="muted">{member?.phone}{member?.tier && member.tier !== 'standard' ? ` · ${String(member.tier).toUpperCase()}` : ''}</div>
            </div>
            <div className="loyalty-badge">
              <b>{Number(member?.points) || 0}</b>
              <span>{t('points')}</span>
            </div>
          </div>

          {rules?.pointValue > 0 && (
            <div style={{ marginBottom: 12 }}>
              <label className="field-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>{t('Use points')}</label>
              <div className="points-input">
                <button className="btn" onClick={() => changePoints(points - 10)} disabled={busy || points <= 0}>−</button>
                <NumpadDisplay value={points || ''} />
                <button className="btn" onClick={() => changePoints(points + 10)} disabled={busy || points >= maxPoints}>+</button>
                <button className="btn" onClick={() => changePoints(maxPoints)} disabled={busy || !maxPoints || points === maxPoints}>
                  {t('all')}
                </button>
              </div>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>
                {t('Worth')} {fmt((Number(points) || 0) * (rules.pointValue || 0))} · {t('up to')} {maxPoints} {t('points')}
              </div>
              <Numpad value={points || ''} onChange={(v) => changePoints(v)} allowDecimal={false} compact />
            </div>
          )}

          <label className="field-label" style={{ display: 'block', marginBottom: 6, fontWeight: 700 }}>{t('Coupons')}</label>
          {coupons.map((c) => (
            <div key={c} className="loyalty-applied">
              <span><Ticket size={15} /> <strong>{c}</strong></span>
              <button className="btn sm ghost" onClick={() => removeCode(c)} disabled={busy} aria-label={t('Remove')}><Trash2 size={15} /></button>
            </div>
          ))}
          <div className="loyalty-coupon-row">
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === 'Enter' && addCode()}
              placeholder={t('Enter coupon code')}
            />
            <button className="btn" onClick={addCode} disabled={busy || !code.trim()}>{t('Add')}</button>
          </div>
          {rules && !rules.allowStacking && coupons.length > 0 && (
            <div className="muted" style={{ fontSize: 12.5 }}>{t('Only one coupon can be used at a time.')}</div>
          )}
          {rules && rules.maxCoupons > 0 && (
            <div className="muted" style={{ fontSize: 12.5 }}>{t('Maximum')} {rules.maxCoupons} {t('coupons per order')}</div>
          )}

          {err && <div className="error-text mt">{err}</div>}

          {quote && (
            <div className="loyalty-total-row">
              <span>
                {quote.discount > 0 ? <><Sparkles size={15} /> {t('Discount')}</> : t('No discount yet')}
              </span>
              <b>−{fmt(quote.discount)}</b>
            </div>
          )}
          {quote && quote.totalPoints > 0 && (
            <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
              {t('Points used')}: {quote.totalPoints}{quote.couponPointCost > 0 ? ` (${t('including')} ${quote.couponPointCost} ${t('for coupons')})` : ''}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
