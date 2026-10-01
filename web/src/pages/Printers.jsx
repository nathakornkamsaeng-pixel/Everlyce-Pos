import React, { useEffect, useState } from 'react';
import { get, post, put, del } from '../lib/api';
import { useToast } from '../components/Toast';
import { Empty, Confirm, Modal } from '../components/ui';
import { Printer, Plus, X, Pencil, Check, AlertTriangle, Star, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n';

// This shop's printers.
//
// Per shop, and that is the whole point: two shops on one install have different
// machines on different walls. Nothing here is shared with another shop.
//
// The models are a list to pick from rather than free text, because typing a
// model name and hoping gives a receipt width nobody checked. Every profile is
// marked unverified, and shown as such, because none has been measured against
// a physical unit: the paper width and columns are solid, the code page that
// means Thai is firmware dependent and is deliberately left unset.

const PROTOCOL_LABELS = {
  browser: 'Browser print dialog',
  'escpos-network': 'ESC/POS over the network',
  'raw-tcp': 'Raw TCP',
  'escpos-usb': 'USB (via a print agent)',
  cloud: 'Cloud printer',
};

const KIND_LABELS = {
  receipt: 'Receipt', kitchen: 'Kitchen', bar: 'Bar', label: 'Label', other: 'Other',
};

const BLANK = {
  name: '', kind: 'receipt', protocol: 'browser', address: '', vendor: '', model: '',
};

export default function Printers() {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState('');
  const [testResult, setTestResult] = useState(null);

  function load() {
    get('/shop-settings').then(setData).catch((e) => toast(e.message, 'error'));
  }
  useEffect(() => { load(); }, []);

  async function run(name, fn, message) {
    setBusy(name);
    try {
      const d = await fn();
      if (message) toast(message, 'ok');
      load();
      return d;
    } catch (e) {
      toast(e.message, 'error');
      return null;
    } finally {
      setBusy('');
    }
  }

  const save = (body, id) => run(id ? `save${id}` : 'add', () => (
    id ? put(`/shop-settings/${id}`, body) : post('/shop-settings', body)
  ), t('Saved'));

  const makeDefault = (id) => run(`def${id}`, () => post(`/shop-settings/${id}/default`, {}), t('Default printer set'));

  async function testPrint(id) {
    setBusy(`test${id}`);
    setTestResult(null);
    try {
      const d = await post(`/shop-settings/${id}/test`, {});
      setTestResult({ id, ...d });
      toast(t('Test print sent'), 'ok');
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  if (!data) return null;
  const printers = data.printers || [];

  return (
    <>
      <div className="topbar">
        <div className="page-heading">
          <h1>{t('Printers')}</h1>
          <p className="muted">{t('Your machines, your counters. Nothing here affects any other shop.')}</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" onClick={() => setEditing(BLANK)}>
            <Plus size={15} /> {t('Add a printer')}
          </button>
        </div>
      </div>

      <div className="content">
        {data.warnings.length ? (
          <div className="warn-strip" style={{ marginBottom: 14 }}>
            <AlertTriangle size={15} />
            <span>{data.warnings.join(' ')}</span>
          </div>
        ) : null}

        {printers.length === 0 ? (
          <div className="card">
            <Empty title={t('No printers set up yet')} icon={Printer}>
              {t('Add the printer at your counter. You can add more than one, and choose which is the default for receipts and which for the kitchen.')}
            </Empty>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button className="btn primary" onClick={() => setEditing(BLANK)}>
                <Plus size={15} /> {t('Add a printer')}
              </button>
            </div>
          </div>
        ) : (
          <div className="printer-grid">
            {printers.map((p) => (
              <article className={`card printer-card ${p.active ? '' : 'inactive'}`} key={p.id}>
                <div className="printer-head">
                  <div>
                    <strong>{p.name}</strong>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      {KIND_LABELS[p.kind] || p.kind} · {PROTOCOL_LABELS[p.protocol] || p.protocol}
                    </div>
                  </div>
                  {p.isDefaultReceipt || p.isDefaultKitchen ? (
                    <span className="badge ok"><Star size={12} /> {t('Default')}</span>
                  ) : null}
                </div>

                <dl className="printer-facts">
                  {p.vendor || p.model ? (
                    <><dt>{t('Model')}</dt><dd>{[p.vendor, p.model].filter(Boolean).join(' ')}</dd></>
                  ) : null}
                  <dt>{t('Paper')}</dt>
                  <dd>
                    {p.paperWidthMm}mm · {p.columns} {t('columns')}
                    {!p.verified ? (
                      <span className="badge amber" style={{ marginLeft: 6 }}>{t('not checked')}</span>
                    ) : null}
                  </dd>
                  {p.address ? <><dt>{t('Address')}</dt><dd><code>{p.address}</code></dd></> : null}
                </dl>

                <div className="printer-actions">
                  <button className="btn sm" onClick={() => testPrint(p.id)} disabled={busy === `test${p.id}`}>
                    <Printer size={14} /> {busy === `test${p.id}` ? t('Sending') : t('Test print')}
                  </button>
                  {!p.isDefaultReceipt && !p.isDefaultKitchen ? (
                    <button className="btn sm" onClick={() => makeDefault(p.id)} disabled={busy === `def${p.id}`}>
                      <Star size={14} /> {t('Make default')}
                    </button>
                  ) : null}
                  <button className="btn sm" onClick={() => setEditing(p)}><Pencil size={14} /> {t('Edit')}</button>
                  <button className="btn sm danger" onClick={() => setRemoving(p)}>
                    <Trash2 size={14} /> {t('Remove')}
                  </button>
                </div>

                {testResult && testResult.id === p.id ? (
                  <div className="printer-test">
                    <strong>{t('Test print ready')}</strong>
                    <p>
                      {testResult.bytes || testResult.payload
                        ? t('ESC/POS bytes generated for a browser print agent. Open the print dialog to send them.')
                        : t('Sent.')}
                    </p>
                    <small>
                      {t('Paper')} {testResult.paperWidthMm}mm · {testResult.columns} {t('columns')}
                      {testResult.note ? ` — ${testResult.note}` : ''}
                    </small>
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}

        {editing ? (
          <PrinterForm
            printer={editing}
            catalogue={data.catalogue || []}
            busy={busy}
            onClose={() => setEditing(null)}
            onSave={(body) => save(body, editing.id).then((r) => { if (r) setEditing(null); })}
          />
        ) : null}

        {removing ? (
          <Confirm
            title={t('Remove this printer?')}
            message={t('It is taken off the till. Orders will not stop, but anything that would have printed to it has nowhere to go. The records stay.')}
            onCancel={() => setRemoving(null)}
            onYes={() => run(`rm${removing.id}`, () => del(`/shop-settings/${removing.id}`), t('Printer removed')).then(() => setRemoving(null))}
          />
        ) : null}
      </div>
    </>
  );
}

function PrinterForm({ printer, catalogue, busy, onClose, onSave }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    name: printer.name || '',
    kind: printer.kind || 'receipt',
    protocol: printer.protocol || 'browser',
    address: printer.address || '',
    vendor: printer.vendor || '',
    model: printer.model || '',
  });
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const needsAddress = form.protocol === 'escpos-network' || form.protocol === 'raw-tcp';
  // Only offer models that fit the kind of paper, so a 58mm label printer is not
  // chosen for a receipt till by accident.
  const models = catalogue;
  const chosen = models.find((m) => m.vendor === form.vendor && m.model === form.model) || null;

  function submit() {
    if (!form.name.trim()) { setErr(t('Give the printer a name')); return; }
    if (needsAddress && !form.address.trim()) {
      setErr(t('A network printer needs an IP address and port'));
      return;
    }
    setErr('');
    onSave({
      ...form,
      paperWidthMm: chosen ? chosen.paper : (form.paperWidthMm || 80),
    });
  }

  return (
    <Modal title={printer.id ? t('Edit printer') : t('Add a printer')} onClose={onClose}>
      <>
        <div className="form-grid">
          <div className="field">
            <label>{t('Name you will recognise at the till')}</label>
            <input value={form.name} onChange={set('name')} placeholder={t('Front counter')} autoFocus />
          </div>
          <div className="field">
            <label>{t('What it prints')}</label>
            <select value={form.kind} onChange={set('kind')}>
              {Object.entries(KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('How it is connected')}</label>
            <select value={form.protocol} onChange={set('protocol')}>
              {Object.entries(PROTOCOL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>{t('Model')}</label>
            <select
              value={form.vendor && form.model ? `${form.vendor}|${form.model}` : ''}
              onChange={(e) => {
                const [vendor, model] = e.target.value.split('|');
                setForm({ ...form, vendor: vendor || '', model: model || '' });
              }}
            >
              <option value="">{t('Not on the list, I will type it')}</option>
              {models.map((m) => (
                <option key={`${m.vendor}|${m.model}`} value={`${m.vendor}|${m.model}`}>
                  {m.vendor} {m.model} — {m.paper}mm{t.note ? ` (${m.note})` : ''}
                </option>
              ))}
            </select>
          </div>
          {(!form.vendor || !form.model) ? (
            <>
              <div className="field">
                <label>{t('Brand')}</label>
                <input value={form.vendor} onChange={set('vendor')} placeholder="Epson" />
              </div>
              <div className="field">
                <label>{t('Model name')}</label>
                <input value={form.model} onChange={set('model')} placeholder="TM-T88VII" />
              </div>
            </>
          ) : null}
          {needsAddress ? (
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <label>{t('IP address and port')}</label>
              <input value={form.address} onChange={set('address')} placeholder="192.168.1.80:9100" inputMode="numeric" />
              <div className="hint">{t('The port is almost always 9100 for a receipt printer on the network.')}</div>
            </div>
          ) : null}
        </div>

        {chosen && chosen.verified === false ? (
          <p className="warn-strip" style={{ marginTop: 12 }}>
            <AlertTriangle size={14} />
            <span>
              {t('Nobody has checked this profile against a real unit. Paper width and columns should be right for this model, but confirm them against the printer itself the first time you use it.')}
            </span>
          </p>
        ) : null}
        {err ? <p className="form-error" style={{ marginTop: 10 }}>{err}</p> : null}

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn primary" onClick={submit} disabled={busy === 'add' || String(busy).startsWith('save')}>
            <Check size={15} /> {busy ? t('Saving') : t('Save printer')}
          </button>
        </div>
      </>
    </Modal>
  );
}