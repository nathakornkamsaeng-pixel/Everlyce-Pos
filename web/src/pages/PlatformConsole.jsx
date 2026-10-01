import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePlatformConfig } from '../lib/config.jsx';
import PlatformContent from './PlatformContent';
import { BRAND_LOGO } from '../lib/brand-assets';
import { post, get, del, patch, api } from '../lib/api';
import {
  Store, KeyRound, Copy, Check, Ban, Play, Trash2, LogOut, XCircle, Plus,
  Loader2, CircleAlert, ShieldCheck, Users, Package, Receipt, Settings,
  MessageCircle, KeySquare, ExternalLink, Mail,
} from 'lucide-react';

const STATUS_LABEL = {
  pending: 'Awaiting key',
  awaiting_activation: 'Key issued',
  active: 'Active',
  suspended: 'Suspended',
};

const STATUS_CLASS = {
  pending: 'warn',
  awaiting_activation: 'info',
  active: 'ok',
  suspended: 'bad',
};

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function PlatformConsole() {
  const { refresh } = usePlatformConfig();
  const refreshConfig = refresh;
  const [state, setState] = useState({ ready: false, user: null, stores: [], plans: [] });
  const [error, setError] = useState('');
  const [issued, setIssued] = useState(null);
  const [creating, setCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    try {
      const me = await get('/platform/me', { platform: true });
      const d = await get('/platform/stores', { platform: true });
      setState({
        ready: true,
        user: me.user,
        stores: d.stores || [],
        plans: d.plans || [],
        contactEmail: d.contactEmail || '',
        lineOpenChatUrl: d.lineOpenChatUrl || '',
      });
      // The values live in this console's own state; the shared context is
      // refreshed by the provider, so nothing extra is needed here.
    } catch (e) {
      setState({ ready: true, user: null, stores: [], plans: [] });
    }
  }, []);

  useEffect(() => {
    api.setStore('');
    load();
  }, [load]);

  if (!state.ready) {
    return <div className="loading"><div className="spin" /></div>;
  }
  if (!state.user) {
    return <PlatformLogin onDone={load} />;
  }

  const pending = state.stores.filter((s) => s.status === 'pending' || s.status === 'awaiting_activation');
  const live = state.stores.filter((s) => s.status === 'active' || s.status === 'suspended');

  return (
    <div className="console">
      <header className="console-head">
        <div className="wrap console-head-inner">
          <div className="site-brand">
            <img src={BRAND_LOGO} width={30} height={30} alt="" />
            <span>Everlyce <b>POS</b> <em>Platform</em></span>
          </div>
          <div className="console-head-right">
            <span className="muted">Signed in as <b>{state.user.username}</b></span>
            <button className="btn sm" onClick={() => setShowSettings((v) => !v)} aria-expanded={showSettings}>
              <Settings size={15} /> Settings
            </button>
            <button
              className="btn sm"
              onClick={async () => { try { await post('/platform/logout', {}, { platform: true }); } catch (e) {} api.clearPlatform(); window.location.href = '/'; }}
            >
              <LogOut size={15} /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="wrap console-main">
        <div className="console-title">
          <div>
            <h1>Stores</h1>
            <p>Registered shops appear here. Issue an activation key to switch a store on, or create one yourself.</p>
          </div>
          <div className="row-actions">
            <button className="btn" onClick={load}><Store size={15} /> Refresh</button>
            <button className="btn primary" onClick={() => setCreating((v) => !v)}>
              {creating ? <XCircle size={15} /> : <Plus size={15} />} New store
            </button>
          </div>
        </div>

        {creating ? (
          <NewStore
            plans={state.plans}
            onCancel={() => setCreating(false)}
            onCreated={(store) => { setCreating(false); setIssued(null); load(); }}
          />
        ) : null}

        {showSettings ? (
          <PlatformSettings
            user={state.user}
            contactEmail={state.contactEmail}
            lineOpenChatUrl={state.lineOpenChatUrl}
            onSaved={(next) => { setState((s) => ({ ...s, ...next })); refreshConfig(); load(); }}
            onSignedOut={() => { api.clearPlatform(); window.location.href = '/platform'; }}
          />
        ) : null}

        {issued ? <IssuedKey issued={issued} onClose={() => setIssued(null)} /> : null}

        <PlanRequests reload={load} onIssued={setIssued} />

        {/* The platform's own pages: the home page and the privacy notice.
            A shop's own wording is in the shop, not here. */}
        <PlatformContent />


        <UnblockEmail />

        <section className="console-section">
          <h2>Needs a key <span className="count">{pending.length}</span></h2>
          {pending.length === 0 ? <p className="muted">No stores are waiting.</p> : (
            <div className="store-grid">
              {pending.map((store) => (
                <StoreCard key={store.id} store={store} plans={state.plans} onIssued={setIssued} reload={load} />
              ))}
            </div>
          )}
        </section>

        <section className="console-section">
          <h2>Live stores <span className="count">{live.length}</span></h2>
          {live.length === 0 ? <p className="muted">No active stores yet.</p> : (
            <div className="store-grid">
              {live.map((store) => (
                <StoreCard key={store.id} store={store} plans={state.plans} onIssued={setIssued} reload={load} />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// Releasing an email address that has already been used to register.
//
// An address may begin exactly one registration, ever, and the marker is spent the
// moment the code is sent rather than when it is used. That is deliberate -- a
// window that reset would not be a rule -- but it has two consequences an operator
// will otherwise meet as support tickets with no way to answer them:
//
//   someone mistypes their own address, and can never register with it again;
//   or somebody registers using a customer's address, to lock that customer out
//   permanently.
//
// So this is here rather than only in a data file. It is a single form taking an
// address, and releasing a marker is a deliberate act with no effect on any store
// that already exists.
function UnblockEmail() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setMsg('');
    setBusy(true);
    try {
      const d = await post('/platform/unblock-email', { email }, { platform: true });
      setMsg(d.message || 'Done.');
    } catch (ex) {
      setErr(ex.message || 'Could not release that address');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="console-section">
        <button className="btn sm" onClick={() => setOpen(true)}>
          <Mail size={15} /> Release a used email address
        </button>
      </section>
    );
  }

  return (
    <section className="console-section">
      <h2>Release a used email address</h2>
      <p className="muted">
        Each address can start one registration, and it stays used even if that registration
        was abandoned. Use this when someone mistyped it, or when a customer has been locked
        out by somebody registering with their address.
      </p>
      <form className="entry-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="unblock-email">Email address</label>
          <input
            id="unblock-email"
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="customer@shop.com"
            autoComplete="off"
          />
        </div>
        {msg ? <div className="form-ok">{msg}</div> : null}
        {err ? <p className="form-error"><CircleAlert size={14} /> {err}</p> : null}
        <div className="waiting-actions">
          <button className="btn primary" disabled={busy || !email.trim()} type="submit">
            {busy ? <Loader2 size={15} className="spin" /> : null} Release it
          </button>
          <button className="btn" type="button" onClick={() => { setOpen(false); setMsg(''); setErr(''); setEmail(''); }}>
            Close
          </button>
        </div>
      </form>
    </section>
  );
}

// Plan requests a shop has asked for. A shop can ask; only this screen can say
// yes. Fulfilment runs through the same key issuing as a manual activation, so a
// confirmed request cannot become a cheaper activation than asking directly
// would have got.
function PlanRequests({ reload, onIssued }) {
  const [data, setData] = useState({ pending: [], settled: [] });
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    get('/platform/plan-requests', { platform: true })
      .then((d) => setData({ pending: (d && d.pending) || [], settled: (d && d.settled) || [] }))
      .catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  async function fulfil(id) {
    setBusy(`f${id}`);
    try {
      const d = await post(`/platform/plan-requests/${id}/fulfil`, {}, { platform: true });
      // The key is shown once, exactly as a manual issuance shows it. Sending it
      // is how the shop gets what it asked for.
      onIssued({ key: d.key, store: { name: (data.pending.find((r) => r.id === id) || {}).storeName || 'this store' }, plan: d.request.fulfilledPlan, planMonths: d.request.fulfilledMonths, warning: d.warning });
      load();
      reload();
    } catch (e) {
      window.alert(e.message || 'Could not confirm that request');
    } finally {
      setBusy('');
    }
  }

  async function decline(id) {
    const reason = window.prompt('Why are you declining this? The shop will see this.') || '';
    if (!reason.trim()) return;
    setBusy(`d${id}`);
    try {
      await post(`/platform/plan-requests/${id}/decline`, { reason }, { platform: true });
      load();
    } catch (e) {
      window.alert(e.message || 'Could not decline that request');
    } finally {
      setBusy('');
    }
  }

  return (
    <section className="console-section">
      <h2>Plan requests <span className="count">{data.pending.length}</span></h2>
      {data.pending.length === 0 ? (
        <p className="muted">No shops are waiting on a plan.</p>
      ) : (
        <div className="store-grid">
          {data.pending.map((r) => (
            <article className="store-card" key={r.id}>
              <div className="store-card-head">
                <div>
                  <strong>/{r.storeSlug}</strong>
                  <div className="muted" style={{ fontSize: 12.5 }}>{r.storeName}</div>
                </div>
                <span className="badge warn">{r.change === 'activate' ? 'First plan' : r.change === 'upgrade' ? 'Upgrade' : 'Renewal'}</span>
              </div>
              <dl className="store-meta">
                <dt>Asking for</dt><dd>{r.plan} · {r.planMonths} month{r.planMonths === 1 ? '' : 's'} · ฿{Number(r.amountTHB || 0).toLocaleString('en-US')}</dd>
                <dt>From</dt><dd>{r.fromPlan}</dd>
                <dt>Asked by</dt><dd>{r.requestedBy}</dd>
                <dt>When</dt><dd>{new Date(r.createdAt).toLocaleString()}</dd>
                {r.note ? <><dt>Note</dt><dd>{r.note}</dd></> : null}
              </dl>
              <div className="store-actions">
                <button className="btn sm primary" disabled={busy === `f${r.id}`} onClick={() => fulfil(r.id)}>
                  {busy === `f${r.id}` ? 'Confirming' : 'Confirm and issue key'}
                </button>
                <button className="btn sm" disabled={busy === `d${r.id}`} onClick={() => decline(r.id)}>Decline</button>
              </div>
            </article>
          ))}
        </div>
      )}
      {data.settled.length ? (
        <details className="settled-requests">
          <summary>Recently decided ({data.settled.length})</summary>
          <ul>
            {data.settled.map((r) => (
              <li key={r.id}>
                /{r.storeSlug} · {r.plan} · {r.status}
                {r.declineReason ? <span className="muted"> — {r.declineReason}</span> : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

// Contact details and the platform account password. Both were previously
// fixed at build time, so changing either meant editing the data file by hand.
function PlatformSettings({ user, contactEmail, lineOpenChatUrl, onSaved, onSignedOut }) {
  const [form, setForm] = useState({ contactEmail: contactEmail || '', lineOpenChatUrl: lineOpenChatUrl || '' });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const setPw_ = (k) => (e) => setPw((p) => ({ ...p, [k]: e.target.value }));

  async function saveContact() {
    setMsg(null);
    setBusy('contact');
    try {
      const d = await patch('/platform/config', form, { platform: true });
      // onSaved updates this panel and the shared context, so the public
      // screens pick the new details up on their next render.
      onSaved(d);
      setMsg({ kind: 'ok', text: 'Contact details saved. They are already live on the site.' });
    } catch (e) {
      setMsg({ kind: 'bad', text: e.message || 'Could not save' });
    } finally {
      setBusy('');
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setMsg(null);
    if (pw.newPassword !== pw.confirm) {
      setMsg({ kind: 'bad', text: 'The two new passwords do not match' });
      return;
    }
    setBusy('password');
    try {
      await post('/platform/password', {
        currentPassword: pw.currentPassword,
        newPassword: pw.newPassword,
      }, { platform: true });
      // Changing it signs every session out, including this one.
      onSignedOut();
    } catch (err) {
      setMsg({ kind: 'bad', text: err.message || 'Could not change the password' });
      setBusy('');
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-head">
        <Settings size={17} />
        <strong>Settings</strong>
        {msg ? <span className={`settings-msg ${msg.kind}`}>{msg.text}</span> : null}
      </div>

      <div className="settings-body">
        <section className="settings-block">
          <h4>How customers reach you</h4>
          <p className="muted">
            Shown on the sign-up page and on the activation screen, wherever someone
            is told to ask for a key.
          </p>
          <div className="ns-grid">
            <label>
              Contact email
              <input
                type="email"
                value={form.contactEmail}
                onChange={set('contactEmail')}
                placeholder="you@example.com"
                spellCheck="false"
              />
            </label>
            <label>
              LINE OpenChat link
              <input
                value={form.lineOpenChatUrl}
                onChange={set('lineOpenChatUrl')}
                placeholder="https://line.me/R/ti/p/@yourcode"
                spellCheck="false"
              />
              <small>A LINE invite link. Leave empty to hide the button.</small>
            </label>
          </div>
          <div className="ns-actions">
            <button className="btn primary" disabled={busy === 'contact'} onClick={saveContact}>
              {busy === 'contact' ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Save contact details
            </button>
            {form.lineOpenChatUrl ? (
              <a className="btn" href={form.lineOpenChatUrl} target="_blank" rel="noreferrer noopener">
                <ExternalLink size={15} /> Preview link
              </a>
            ) : null}
          </div>
        </section>

        <section className="settings-block">
          <h4>Your password</h4>
          <p className="muted">
            Signed in as <b>{user.username}</b>. Changing this signs out every
            session, including this one, so you will sign in again afterwards.
          </p>
          <form className="pw-form" onSubmit={savePassword}>
            <label>
              Current password
              <input
                type="password"
                value={pw.currentPassword}
                onChange={setPw_('currentPassword')}
                autoComplete="current-password"
                required
              />
            </label>
            <label>
              New password
              <input
                type="password"
                value={pw.newPassword}
                onChange={setPw_('newPassword')}
                autoComplete="new-password"
                required
              />
              <small>At least 12 characters</small>
            </label>
            <label>
              Confirm new password
              <input
                type="password"
                value={pw.confirm}
                onChange={setPw_('confirm')}
                autoComplete="new-password"
                required
              />
            </label>
            <div className="ns-actions">
              <button className="btn primary" disabled={busy === 'password'} type="submit">
                {busy === 'password' ? <Loader2 size={15} className="spin" /> : <KeySquare size={15} />} Change password
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

// Creating a store by hand, for a chain or for a self-hosted install where
// nobody registers online. Optionally live from the start, no key needed.
function NewStore({ plans, onCreated, onCancel }) {
  const [form, setForm] = useState({
    name: '', slug: '', plan: 'enterprise', planMonths: 12,
    contactName: '', contactEmail: '', activate: true,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const suggestion = useMemo(
    () => String(form.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
    [form.name],
  );

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await post('/platform/stores', {
        ...form,
        planMonths: Number(form.planMonths) || 0,
        activate: form.activate === true || form.activate === 'true',
      }, { platform: true });
      onCreated(d.store);
    } catch (ex) {
      setErr(ex.message || 'Could not create the store');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="issued">
      <form className="newstore" onSubmit={submit}>
        <div className="ns-head">
          <strong><Store size={16} /> New store</strong>
          <button type="button" className="btn sm ghost" onClick={onCancel}>Cancel</button>
        </div>
        <div className="ns-grid">
          <label>
            Store name
            <input value={form.name} onChange={set('name')} placeholder="Downtown branch" autoFocus required />
          </label>
          <label>
            Store ID
            <input
              value={form.slug}
              onChange={set('slug')}
              placeholder={suggestion || 'downtown'}
              spellCheck="false"
            />
            <small>Address will be /{form.slug || suggestion || 'downtown'}</small>
          </label>
          <label>
            Plan
            <select value={form.plan} onChange={set('plan')}>
              {(plans || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label>
            Months
            <input type="number" min="0" max="60" value={form.planMonths} onChange={set('planMonths')} />
          </label>
          <label>
            Contact name
            <input value={form.contactName} onChange={set('contactName')} />
          </label>
          <label>
            Contact email
            <input type="email" value={form.contactEmail} onChange={set('contactEmail')} />
          </label>
        </div>
        <label className="ns-check">
          <input
            type="checkbox"
            checked={form.activate === true}
            onChange={(e) => setForm((f) => ({ ...f, activate: e.target.checked }))}
          />
          Make it live immediately, with no activation key
        </label>
        {err ? <p className="form-error"><CircleAlert size={14} /> {err}</p> : null}
        <div className="ns-actions">
          <button className="btn primary" disabled={busy} type="submit">
            {busy ? <Loader2 size={15} className="spin" /> : <Plus size={15} />} Create store
          </button>
        </div>
      </form>
    </div>
  );
}

// Deleting a store takes its orders with it and cannot be undone, so the
// confirm step is separate from the button and the admin types the store ID.
function DeleteStore({ store, onClose, onDone }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stats, setStats] = useState(store.stats || null);
  const matches = typed.trim() === store.slug;

  async function destroy() {
    if (!matches) return;
    setBusy(true);
    setErr('');
    try {
      await del(`/platform/stores/${store.id}?confirm=${encodeURIComponent(store.slug)}`, { platform: true });
      onClose();
      onDone();
    } catch (ex) {
      // The server answers with the exact counts the first time, so show them
      // and let the admin confirm again with the real store ID.
      if (ex.data && ex.data.code === 'confirmation_required') {
        setStats(ex.data.stats);
        setErr('Type the store ID to confirm.');
      } else {
        setErr(ex.message || 'Could not delete the store');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="confirm">
      <div className="confirm-head">
        <CircleAlert size={18} />
        <strong>Delete /{store.slug}?</strong>
        <button className="btn sm ghost" onClick={onClose}>Cancel</button>
      </div>
      <p className="confirm-warn">
        This is permanent. {stats ? `It removes ${stats.orders} order(s), ${stats.products} product(s), ${stats.tables} table(s), ${stats.branches} branch(es) and ${stats.users} account(s).` : ''}
      </p>
      <p className="confirm-help">Type <code>{store.slug}</code> to confirm.</p>
      <input
        className="confirm-input"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={store.slug}
        autoFocus
        spellCheck="false"
      />
      {err ? <p className="form-error"><CircleAlert size={14} /> {err}</p> : null}
      <button className="btn danger" disabled={!matches || busy} onClick={destroy}>
        {busy ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />} Delete permanently
      </button>
    </div>
  );
}

// Rejecting closes a shop and keeps every record. It is the action for a
// sign-up that should not go ahead, as opposed to Delete, which erases it, so
// the two must never share a button or a URL. The reason is optional but worth
// typing: a refusal with no reason is one nobody can act on a month later.
function RejectStore({ store, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function reject() {
    setBusy(true);
    setErr('');
    try {
      // action=suspend is the whole difference between refusing a shop and
      // destroying it. Without it this call falls through to the delete guard
      // and fails, which is how this button ended up doing nothing at all.
      const q = new URLSearchParams({ action: 'suspend' });
      if (reason.trim()) q.set('reason', reason.trim());
      await del(`/platform/stores/${store.id}?${q.toString()}`, { platform: true });
      onClose();
      onDone();
    } catch (ex) {
      setErr(ex.message || 'Could not reject the store');
    } finally {
      setBusy(false);
    }
  }

  const orders = (store.stats && store.stats.orders) || 0;
  return (
    <div className="confirm">
      <div className="confirm-head">
        <CircleAlert size={18} />
        <strong>Reject /{store.slug}?</strong>
        <button className="btn sm ghost" onClick={onClose}>Cancel</button>
      </div>
      <p className="confirm-warn">
        The shop is closed and refused at the door. Nothing is deleted
        {orders > 0 ? `, and its ${orders} order(s) are kept` : ''}, so you can still read them and resume it if you change your mind.
      </p>
      <p className="confirm-help">Reason (optional, recorded against the store).</p>
      <input
        className="confirm-input"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="duplicate of a real shop"
        maxLength={300}
        autoFocus
      />
      {err ? <p className="form-error"><CircleAlert size={14} /> {err}</p> : null}
      <button className="btn danger" disabled={busy} onClick={reject}>
        {busy ? <Loader2 size={15} className="spin" /> : <XCircle size={15} />} Reject sign-up
      </button>
    </div>
  );
}

function PlatformLogin({ onDone }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const d = await post('/platform/login', { username, password }, { platform: true });
      api.setPlatformSession(d.token, d.user);
      onDone();
    } catch (ex) {
      setErr(ex.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="logo-row">
          <img src={BRAND_LOGO} width={40} height={40} alt="" />
          <div>
            <h2>Platform administration</h2>
            <div className="sub">Manage stores and activation keys</div>
          </div>
        </div>
        <div className="field">
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </div>
        <div className="field">
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        {err && <div className="login-error"><CircleAlert size={16} /> <span>{err}</span></div>}
        <button className="btn primary login-submit" type="submit" disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : 'Sign in'}
        </button>
        <p className="fineprint center"><a href="/">Back to the site</a></p>
      </form>
    </div>
  );
}

function IssuedKey({ issued, onClose }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="issued">
      <div className="issued-head">
        <KeyRound size={18} />
        <div>
          <strong>Key for /{issued.store.slug}</strong>
          <span>{issued.planName}{issued.planMonths ? ` · ${issued.planMonths} months` : ''} · expires {fmtDate(issued.expiresAt)}</span>
        </div>
        <button className="btn sm" onClick={onClose}>Done</button>
      </div>
      <code className="issued-key">{issued.key}</code>
      <div className="issued-actions">
        <button
          className="btn sm"
          onClick={async () => {
            try { await navigator.clipboard.writeText(issued.key); } catch (e) {}
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy key'}
        </button>
        <span className="muted">{issued.warning}</span>
      </div>
    </div>
  );
}

function StoreCard({ store, plans, onIssued, reload }) {
  const [plan, setPlan] = useState(store.plan || 'starter');
  const [months, setMonths] = useState(store.planMonths || 12);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmReject, setConfirmReject] = useState(null);

  async function run(name, fn) {
    setErr('');
    setBusy(name);
    try {
      await fn();
      await reload();
    } catch (ex) {
      setErr(ex.message || 'That did not work');
    } finally {
      setBusy('');
    }
  }

  const canKey = store.status === 'pending' || store.status === 'awaiting_activation';

  return (
    <article className="store-card">
      <div className="store-card-head">
        <div>
          <h3>{store.restaurantName || store.name}</h3>
          <code className="slug">/{store.slug}</code>
        </div>
        <span className={`badge ${STATUS_CLASS[store.status] || ''}`}>{STATUS_LABEL[store.status] || store.status}</span>
      </div>

      <dl className="store-meta">
        <div><dt>Contact</dt><dd>{store.contactName || '—'}</dd></div>
        <div><dt>Email</dt><dd>{store.contactEmail ? <a href={`mailto:${store.contactEmail}`}>{store.contactEmail}</a> : '—'}</dd></div>
        <div><dt>Phone</dt><dd>{store.contactPhone || '—'}</dd></div>
        <div><dt>Registered</dt><dd>{fmtDate(store.createdAt)}</dd></div>
      </dl>

      {store.note ? <p className="store-note">{store.note}</p> : null}

      {store.stats ? (
        <div className="store-stats">
          <span><Users size={14} /> {store.stats.users} staff</span>
          <span><Package size={14} /> {store.stats.products} items</span>
          <span><Receipt size={14} /> {store.stats.orders} orders</span>
        </div>
      ) : null}

      {store.hasKey ? (
        <p className="store-key">
          <KeyRound size={14} /> Key ending <b>{store.keyHint}</b> issued {fmtDate(store.keyIssuedAt)}, expires {fmtDate(store.keyExpiresAt)}
        </p>
      ) : null}
      {store.keyUsedAt ? <p className="store-key"><ShieldCheck size={14} /> Activated {fmtDate(store.keyUsedAt)}</p> : null}

      {canKey ? (
        <div className="store-actions">
          <label className="mini">
            Plan
            <select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="mini">
            Months
            <input type="number" min="0" max="60" value={months} onChange={(e) => setMonths(e.target.value)} />
          </label>
          <button
            className="btn primary sm"
            disabled={busy === 'key'}
            onClick={() => run('key', async () => {
              const d = await post(`/platform/stores/${store.id}/key`, { plan, planMonths: months }, { platform: true });
              onIssued(d);
            })}
          >
            {busy === 'key' ? <Loader2 size={15} className="spin" /> : <KeyRound size={15} />}
            {store.hasKey ? 'Re-issue key' : 'Generate key'}
          </button>
          {store.hasKey ? (
            <button className="btn sm" disabled={busy === 'revoke'} onClick={() => run('revoke', () => post(`/platform/stores/${store.id}/revoke-key`, {}, { platform: true }))}>
              <Trash2 size={15} /> Revoke
            </button>
          ) : null}
          <button className="btn sm" onClick={() => setConfirmReject(store)}>
            <XCircle size={15} /> Reject
          </button>
        </div>
      ) : null}

      {store.status === 'active' ? (
        <div className="store-actions">
          <a className="btn sm" href={`/${store.slug}`} target="_blank" rel="noreferrer">Open store</a>
          <button className="btn sm danger" disabled={busy === 'suspend'} onClick={() => run('suspend', () => post(`/platform/stores/${store.id}/status`, { status: 'suspend' }, { platform: true }))}>
            <Ban size={15} /> Suspend
          </button>
          {/* A trial shop goes live as soon as it answers its emailed code, so a
              sign-up worth refusing can be trading. Without this it had no Reject
              button at all, only Suspend, which leaves no record of why. */}
          {!store.onTrial ? null : (
            <button className="btn sm" onClick={() => setConfirmReject(store)}>
              <XCircle size={15} /> Reject
            </button>
          )}
          <button className="btn sm danger" onClick={() => setConfirmDelete(store)}>
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : null}

      {store.status === 'suspended' ? (
        <div className="store-actions">
          <button className="btn sm" disabled={busy === 'resume'} onClick={() => run('resume', () => post(`/platform/stores/${store.id}/status`, { status: 'resume' }, { platform: true }))}>
            <Play size={15} /> Resume
          </button>
          <button className="btn sm danger" onClick={() => setConfirmDelete(store)}>
            <Trash2 size={15} /> Delete
          </button>
        </div>
      ) : null}

      {confirmDelete ? (
        <DeleteStore store={confirmDelete} onClose={() => setConfirmDelete(null)} onDone={reload} />
      ) : null}

      {confirmReject ? (
        <RejectStore store={confirmReject} onClose={() => setConfirmReject(null)} onDone={reload} />
      ) : null}

      {err ? <p className="form-error"><CircleAlert size={14} /> {err}</p> : null}
    </article>
  );
}
