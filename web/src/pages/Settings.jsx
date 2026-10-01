import React, { useEffect, useState } from 'react';
import { get, put, post, del } from '../lib/api';
import { useToast } from '../components/Toast';
import { Confirm, Empty } from '../components/ui';
import { Table2, Plus, X, Pencil } from 'lucide-react';
import PaymentMethods from './PaymentMethods';
import { useI18n } from '../i18n';

export default function Settings() {
  const { t } = useI18n();
  const [s, setS] = useState(null);
  const [tables, setTables] = useState([]);
  const [locks, setLocks] = useState([]);
  const [editing, setEditing] = useState(null);
  const [delId, setDelId] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  function load() {
    get('/settings').then(setS).catch(() => {});
    get('/tables').then(setTables).catch(() => {});
    get('/auth/locks').then((d) => setLocks(d.locks || [])).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function save() {
    try { await put('/settings', s); toast(t('Settings saved'), 'ok'); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  async function unlock(id) {
    try { await del(`/auth/locks/${id}`); toast(t('Login lock removed'), 'ok'); load(); }
    catch (e) { toast(t(e.message), 'error'); }
  }

  async function saveTable() {
    if (!editing.name.trim()) return toast(t('Table name is required'), 'error');
    try {
      if (editing.id) await put(`/tables/${editing.id}`, { name: editing.name, seats: Number(editing.seats) || 1 });
      else await post('/tables', { name: editing.name, seats: Number(editing.seats) || 1 });
      toast(t('Saved'), 'ok');
      setEditing(null);
      get('/tables').then(setTables);
    } catch (e) { toast(t(e.message), 'error'); }
  }

  async function removeTable() {
    setBusy(true);
    try {
      await del(`/tables/${delId}`);
      setDelId(null);
      toast(t('Table removed'), 'ok');
      get('/tables').then(setTables);
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  async function quickAdd() {
    setBusy(true);
    try {
      const nums = tables.map((t) => parseInt(String(t.name).replace(/\D/g, ''), 10)).filter((n) => !isNaN(n));
      const next = nums.length ? Math.max(...nums) + 1 : 1;
      await post('/tables', { name: `T${next}`, seats: 2 });
      toast(`Table T${next} added`, 'ok');
      get('/tables').then(setTables);
    } catch (e) { toast(t(e.message), 'error'); }
    finally { setBusy(false); }
  }

  if (!s) return <div className="loading"><div className="spin" /></div>;

  const occupied = tables.filter((t) => t.status === 'occupied').length;
  const lockAttempts = Math.max(1, Number(s.loginLockAttempts) || 5);
  const lockWindow = Math.max(1, Number(s.loginLockWindowMinutes) || 15);
  const lockBase = Math.max(1, Number(s.loginLockBlockMinutes) || 30);
  const lockMax = Math.max(1, Number(s.loginLockMaxHours) || 24);
  const lockSchedule = Array.from({ length: 8 }, (_, index) => Math.min(lockBase * Math.pow(2, index), lockMax * 60)).filter((minutes, index, list) => index === 0 || minutes !== list[index - 1]);

  return (
    <>
      <div className="topbar"><h1>{t('Settings')}</h1></div>
      <div className="content">
        <div className="card" style={{ maxWidth: 560 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Language')}</div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Customer menu (default)')}</label>
              <select value={s.customerLanguage || 'th'} onChange={(e) => setS({ ...s, customerLanguage: e.target.value })}>
                <option value="th">ไทย (Thai)</option>
                <option value="en">English</option>
              </select>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('Customers can switch language on their own menu. Each staff user picks their own language from the top bar. The management screens follow the signed-in user’s language.')}</div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save language')}</button>
        </div>

        <div className="card mt" style={{ maxWidth: 720 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Login security')}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('Locks only the failed account and source IP. Other devices and accounts are not affected.')}
          </div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Failed attempts before lock')}</label>
              <input type="number" min="1" max="100" value={s.loginLockAttempts ?? 5} onChange={(e) => setS({ ...s, loginLockAttempts: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Count failures within (minutes)')}</label>
              <input type="number" min="1" max="1440" value={s.loginLockWindowMinutes ?? 15} onChange={(e) => setS({ ...s, loginLockWindowMinutes: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Initial lock time (minutes)')}</label>
              <input type="number" min="1" max="1440" value={s.loginLockBlockMinutes ?? 30} onChange={(e) => setS({ ...s, loginLockBlockMinutes: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Maximum lock time (hours)')}</label>
              <input type="number" min="1" max="24" value={s.loginLockMaxHours ?? 24} onChange={(e) => setS({ ...s, loginLockMaxHours: e.target.value })} />
            </div>
          </div>
          <div className="lock-schedule mt">
            <strong>{lockAttempts} {t('failures')} / {lockWindow} {t('min')}</strong>
            <span>→</span>
            {lockSchedule.map((minutes, index) => <span className="lock-step" key={`${minutes}-${index}`}>{minutes >= 60 ? `${Number((minutes / 60).toFixed(1))}h` : `${minutes}m`}</span>)}
            <span>→</span>
            <span className="lock-step max">{t('max')} {lockMax}h</span>
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save login security')}</button>

          <div className="section-title mt">Locked account + IP</div>
          {locks.length === 0 ? <div className="muted">{t('No active login locks.')}</div> : (
            <div className="table-wrap mt">
              <table className="data">
                <thead><tr><th>{t('Username')}</th><th>IP</th><th>{t('Failed attempts')}</th><th>{t('Locked until')}</th><th className="num"></th></tr></thead>
                <tbody>
                  {locks.map((lock) => (
                    <tr key={lock.id}>
                      <td><strong>{lock.username}</strong></td>
                      <td className="mono">{lock.ip}</td>
                      <td>{lock.failures}</td>
                      <td>{lock.retryAfterSeconds > 0 ? new Date(Date.now() + lock.retryAfterSeconds * 1000).toLocaleString() : t('Not locked')}</td>
                      <td className="num"><button className="btn sm" onClick={() => unlock(lock.id)}>{t('Unlock')}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card mt" style={{ maxWidth: 560 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Kitchen display')}</div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Flash a ticket after (minutes)')}</label>
              <input type="number" min="1" inputMode="numeric" value={s.kdsOverdueMinutes ?? 15} onChange={(e) => setS({ ...s, kdsOverdueMinutes: e.target.value })} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('A ticket turns red and flashes once it has been waiting longer than this. The timer starts when the order reaches the kitchen and stops when it is marked done — every duration is kept for reports.')}</div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Clear an empty register ticket after (minutes)')}</label>
              <input type="number" min="1" inputMode="numeric" value={s.draftEmptyMinutes ?? 5} onChange={(e) => setS({ ...s, draftEmptyMinutes: e.target.value })} />
            </div>
            <div className="field">
              <label>{t('Clear a register ticket with items after (minutes)')}</label>
              <input type="number" min="1" inputMode="numeric" value={s.draftStaleMinutes ?? 45} onChange={(e) => setS({ ...s, draftStaleMinutes: e.target.value })} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('Register tickets that nobody completes are removed automatically so they never pile up as ghost orders. This does not touch real customer orders.')}</div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save kitchen settings')}</button>
        </div>

        <div className="card mt" style={{ maxWidth: 680 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Loyalty')}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('How loyalty works at the register. The cashier is asked for a phone number when charging, and can offer points or coupons before taking payment.')}
          </div>

          <label className="switch-row">
            <input type="checkbox" checked={s.loyaltyEnabled !== false} onChange={(e) => setS({ ...s, loyaltyEnabled: e.target.checked })} />
            <span>{t('Enable loyalty')}</span>
          </label>

          <div className="form-grid mt">
            <div className="field">
              <label>{t('Ask for a phone number')}</label>
              <select value={s.loyaltyPrompt || 'always'} onChange={(e) => setS({ ...s, loyaltyPrompt: e.target.value })} disabled={s.loyaltyEnabled === false}>
                <option value="always">{t('Always at charge')}</option>
                <option value="optional">{t('Optional')}</option>
                <option value="never">{t('Never')}</option>
              </select>
            </div>
            <div className="field">
              <label>{t('Points earned per 1')} {s.currency || 'THB'}</label>
              <input type="number" step="0.01" min="0" inputMode="decimal" value={s.loyaltyPointsPerUnit ?? 1} onChange={(e) => setS({ ...s, loyaltyPointsPerUnit: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
            <div className="field">
              <label>{t('Value of 1 point')}</label>
              <input type="number" step="0.01" min="0" inputMode="decimal" value={s.loyaltyPointValue ?? 0} onChange={(e) => setS({ ...s, loyaltyPointValue: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
            <div className="field">
              <label>{t('Minimum points to redeem')}</label>
              <input type="number" min="0" inputMode="numeric" value={s.loyaltyMinRedeemPoints ?? 0} onChange={(e) => setS({ ...s, loyaltyMinRedeemPoints: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
            <div className="field">
              <label>{t('Gold tier at points')}</label>
              <input type="number" min="0" inputMode="numeric" value={s.loyaltyTierGold ?? 200} onChange={(e) => setS({ ...s, loyaltyTierGold: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
            <div className="field">
              <label>{t('VIP tier at points')}</label>
              <input type="number" min="0" inputMode="numeric" value={s.loyaltyTierVip ?? 500} onChange={(e) => setS({ ...s, loyaltyTierVip: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
            <div className="field">
              <label>{t('Maximum coupons per order')}</label>
              <input type="number" min="0" inputMode="numeric" value={s.loyaltyMaxCoupons ?? 0} onChange={(e) => setS({ ...s, loyaltyMaxCoupons: e.target.value })} disabled={s.loyaltyEnabled === false} />
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('Leave the maximum at 0 for no limit.')}</div>

          <label className="switch-row mt">
            <input type="checkbox" checked={s.loyaltyAllowStacking !== false} onChange={(e) => setS({ ...s, loyaltyAllowStacking: e.target.checked })} disabled={s.loyaltyEnabled === false} />
            <span>{t('Allow coupons to be combined')}</span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={s.loyaltyAllowSkip !== false} onChange={(e) => setS({ ...s, loyaltyAllowSkip: e.target.checked })} disabled={s.loyaltyEnabled === false} />
            <span>{t('Let the cashier skip without a member')}</span>
          </label>
          <label className="switch-row">
            <input type="checkbox" checked={!!s.loyaltyRequirePhone} onChange={(e) => setS({ ...s, loyaltyRequirePhone: e.target.checked })} disabled={s.loyaltyEnabled === false} />
            <span>{t('Require a member before payment')}</span>
          </label>
          <div className="muted" style={{ fontSize: 12.5, marginTop: -4 }}>{t('When on, the cashier cannot take payment until a member is identified. Each coupon also has its own “use with other coupons” switch on the Discounts page.')}</div>

          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save loyalty settings')}</button>
        </div>

        <PaymentMethods />

        <div className="card mt" style={{ maxWidth: 680 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Thai QR and PromptPay')}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('Every Thai banking app can read this. The cashier requests payment, the customer scans the QR with their own app, then the cashier confirms once the money arrives.')}
          </div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Account type')}</label>
              <select value={s.promptPayAccountType || 'phone'} onChange={(e) => setS({ ...s, promptPayAccountType: e.target.value })}>
                <option value="phone">{t('Phone / mobile number')}</option>
                <option value="taxid">{t('Tax ID')}</option>
                <option value="id">{t('PromptPay ID')}</option>
              </select>
            </div>
            <div className="field">
              <label>
                {s.promptPayAccountType === 'phone' ? t('Phone / mobile number')
                  : s.promptPayAccountType === 'taxid' ? t('Tax ID')
                  : t('PromptPay ID')}
              </label>
              <input
                value={s.promptPayAccount || ''}
                onChange={(e) => setS({ ...s, promptPayAccount: e.target.value })}
                placeholder={
                  s.promptPayAccountType === 'phone' ? '08x-xxx-xxxx'
                    : s.promptPayAccountType === 'taxid' ? '13 digits'
                    : '13 or 15 digits'
                }
                inputMode={s.promptPayAccountType === 'phone' ? 'tel' : 'numeric'}
              />
              {/* The account number is never sent back to the browser, so a saved
                  one shows as a state rather than as a value. Sending the empty
                  input back on an unrelated save would otherwise wipe it. */}
              {s.promptPayAccountConfigured && !s.promptPayAccount ? (
                <div className="hint" style={{ marginTop: 6 }}>
                  {t('A number is saved. Leave this blank to keep it.')}{' '}
                  <button type="button" className="linkish" onClick={() => setS({ ...s, promptPayAccount: '' })}>
                    {t('Clear it')}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="field">
              <label>{t('Name on the payment')}</label>
              <input
                value={s.merchantName || ''}
                onChange={(e) => setS({ ...s, merchantName: e.target.value })}
                placeholder={t('What the customer sees, e.g. Bangkok Coffee')}
                maxLength={25}
              />
            </div>
            <div className="field">
              <label>{t('City')}</label>
              <input
                value={s.merchantCity || ''}
                onChange={(e) => setS({ ...s, merchantCity: e.target.value })}
                placeholder="Bangkok"
                maxLength={15}
              />
            </div>
            <div className="field">
              <label>{t('Merchant category code')}</label>
              <input
                value={s.merchantMcc || ''}
                onChange={(e) => setS({ ...s, merchantMcc: e.target.value.replace(/[^0-9]/g, '').slice(0, 4) })}
                placeholder="5812"
                inputMode="numeric"
              />
              <div className="hint" style={{ marginTop: 4 }}>{t('Optional. Four digits, the category your bank reports.')}</div>
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            {t('The order number is attached to every payment as its reference, so money arriving can be matched to the order without guessing.')}
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save payment settings')}</button>
        </div>

        <div className="card mt" style={{ maxWidth: 680 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Card payments')}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('Card gateways are not switched on yet. Store a key here and the till will show the method as available once it has been verified against the provider.')}
          </div>
          <div className="form-grid mt">
            <div className="field">
              <label>Opn {t('secret key')}</label>
              <input
                type="password"
                autoComplete="off"
                value={s.opnSecretKey || ''}
                onChange={(e) => setS({ ...s, opnSecretKey: e.target.value })}
                placeholder={s.opnSecretKeyConfigured ? '••••••••' : 'sk_opn_...'}
              />
              {s.opnSecretKeyConfigured && !s.opnSecretKey ? (
                <div className="hint" style={{ marginTop: 6 }}>{t('A key is saved. Leave blank to keep it.')}</div>
              ) : null}
            </div>
            <div className="field">
              <label>Stripe {t('secret key')}</label>
              <input
                type="password"
                autoComplete="off"
                value={s.stripeSecretKey || ''}
                onChange={(e) => setS({ ...s, stripeSecretKey: e.target.value })}
                placeholder={s.stripeSecretKeyConfigured ? '••••••••' : 'sk_live_...'}
              />
              {s.stripeSecretKeyConfigured && !s.stripeSecretKey ? (
                <div className="hint" style={{ marginTop: 6 }}>{t('A key is saved. Leave blank to keep it.')}</div>
              ) : null}
            </div>
          </div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
            {t('Keys are never shown again once saved. They are held only so the provider can be connected later.')}
          </div>
          <button className="btn primary" style={{ marginTop: 12 }} onClick={save}>{t('Save card payment settings')}</button>
        </div>

        <div className="card mt" style={{ maxWidth: 560 }}>
          <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Restaurant')}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('The restaurant name is the brand for the whole site: the sign-in page, the register, the customer menu, the kitchen screen and the browser tab.')}
          </div>
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Restaurant name')}</label>
              <input value={s.restaurantName} onChange={(e) => setS({ ...s, restaurantName: e.target.value })} placeholder={t('e.g. My Restaurant')} />
            </div>
            <div className="field"><label>{t('Currency')}</label><input value={s.currency} onChange={(e) => setS({ ...s, currency: e.target.value })} placeholder="THB" /></div>
            <div className="field"><label>{t('Tax rate (%)')}</label><input type="number" step="0.1" inputMode="decimal" value={s.taxRate} onChange={(e) => setS({ ...s, taxRate: e.target.value })} /></div>
            <div className="field"><label>{t('Service charge (%)')}</label><input type="number" step="0.1" inputMode="decimal" value={s.serviceChargeRate} onChange={(e) => setS({ ...s, serviceChargeRate: e.target.value })} /></div>
          </div>
          <button className="btn primary" onClick={save}>{t('Save settings')}</button>
        </div>

        <div className="card mt">
          <h3>{t('Legal and customer data')}</h3>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
            {t('A Thai tax invoice must show the seller legal name and tax identification number. The privacy contact is where customers send Personal Data Protection Act requests.')}
          </div>
          {!s.taxInvoiceReady ? (
            <div className="warn-strip">
              {t('Receipts are not valid tax invoices until both the legal name and tax ID are filled in.')}
            </div>
          ) : null}
          <div className="form-grid mt">
            <div className="field">
              <label>{t('Legal name')}</label>
              <input value={s.legalName || ''} onChange={(e) => setS({ ...s, legalName: e.target.value })} placeholder={t('e.g. Siam Kitchen Co., Ltd.')} />
            </div>
            <div className="field">
              <label>{t('Tax ID')}</label>
              <input value={s.taxId || ''} onChange={(e) => setS({ ...s, taxId: e.target.value })} placeholder="0123456789012" inputMode="numeric" />
            </div>
            <div className="field">
              <label>{t('Privacy contact email')}</label>
              <input type="email" value={s.privacyContactEmail || ''} onChange={(e) => setS({ ...s, privacyContactEmail: e.target.value })} placeholder="privacy@shop.co.th" />
            </div>
            <div className="field">
              <label>{t('Keep customer data for (days)')}</label>
              <input
                type="number"
                min="0"
                max="3650"
                value={s.personalDataRetentionDays ?? 365}
                onChange={(e) => setS({ ...s, personalDataRetentionDays: e.target.value === '' ? 0 : Number(e.target.value) })}
              />
              <small className="hint">{t('0 means keep until the customer asks you to delete it. Records are swept automatically once this period passes.')}</small>
            </div>
          </div>
          <div className="settings-actions">
            <button className="btn primary" onClick={save}>{t('Save settings')}</button>
            <a className="btn" href="/privacy" target="_blank" rel="noreferrer">{t('Preview the privacy notice')}</a>
          </div>
        </div>

        <div className="card mt">
          <div className="spread">
            <div>
              <div className="section-title mb0">{t('Tables')}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>Staff pick a table from a dropdown — names are set here. {tables.length} total, {occupied} occupied.</div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={quickAdd} disabled={busy}><Plus size={14} /> {t('Next number')}</button>
              <button className="btn sm primary" onClick={() => setEditing({ name: '', seats: 2 })}><Plus size={14} /> {t('Add table')}</button>
            </div>
          </div>
          {tables.length === 0 ? (
            <div className="mt"><Empty icon={Table2} title={t('No tables configured')}>{t('Add your tables here, then staff can open them from the floor.')}</Empty></div>
          ) : (
            <div className="table-wrap mt">
              <table className="data">
                <thead><tr><th>{t('Table')}</th><th className="num">{t('Seats')}</th><th>{t('Status')}</th><th className="num"></th></tr></thead>
                <tbody>
                  {tables.map((tbl) => (
                    <tr key={tbl.id}>
                      <td><strong>{tbl.name}</strong></td>
                      <td className="num">{tbl.seats}</td>
                      <td>{tbl.status === 'occupied' ? <span className="badge amber">{t('occupied')}</span> : <span className="badge gray">{t('available')}</span>}</td>
                      <td className="num nowrap">
                        <button className="btn sm ghost" aria-label={`Edit ${tbl.name}`} onClick={() => setEditing({ id: tbl.id, name: tbl.name, seats: tbl.seats })}><Pencil size={14} /></button>
                        <button className="btn sm ghost" aria-label={`Remove ${tbl.name}`} disabled={tbl.status === 'occupied'} onClick={() => setDelId(tbl.id)}><X size={15} /></button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head"><h3>{editing.id ? `Edit ${editing.name}` : 'Add table'}</h3><button className="icon-btn" onClick={() => setEditing(null)}><X size={16} /></button></div>
            <div className="modal-body">
              <div className="field"><label>{t('Table name / number')}</label><input autoFocus value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="T1" /></div>
              <div className="field"><label>{t('Seats')}</label><input type="number" min={1} inputMode="numeric" value={editing.seats} onChange={(e) => setEditing({ ...editing, seats: e.target.value })} /></div>
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setEditing(null)}>{t('Cancel')}</button>
              <button className="btn primary" onClick={saveTable}>{t('Save')}</button>
            </div>
          </div>
        </div>
      )}
      {delId && <Confirm title={t('Remove table')} message="Closed tables only. This cannot be undone." onYes={removeTable} onCancel={() => setDelId(null)} />}
    </>
  );
}