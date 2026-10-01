import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, get, api } from '../lib/api';
import { usePlatformConfig } from '../lib/config.jsx';
import { BRAND_LOGO } from '../lib/brand-assets';
import {
  Store, CheckCircle2, ArrowRight, ShieldCheck, Wifi, Smartphone,
  Printer, Languages, CircleAlert, Loader2, LogIn, Github, Terminal, Database,
  Lock, Server,
} from 'lucide-react';


const FEATURES = [
  { icon: Store, title: 'Your own web address', body: 'Your shop runs at its own link, with its own menu, staff and orders.' },
  { icon: Smartphone, title: 'Table-side QR ordering', body: 'Guests scan, order and pay from their phone. No app to install.' },
  { icon: Wifi, title: 'Works on any device', body: 'Phones, tablets and desktops. Nothing to install on the counter.' },
  { icon: Printer, title: 'Receipts & kitchen tickets', body: 'Printed receipts, kitchen display and language selection at the table.' },
  { icon: Languages, title: 'Thai and English', body: 'Guests and staff each choose their own language.' },
  { icon: ShieldCheck, title: 'Safe by default', body: 'Every account is locked after repeated failed sign-ins, and API keys are single use.' },
];

// What running it yourself actually means, stated plainly rather than left for
// the reader to infer. Each of these is a thing a shop owner asks about before
// they commit, and answering them on the front page is the difference between
// "self host this" being a real option and being a link they bounce off.
const OWNED = [
  {
    icon: Database,
    title: 'Your data, on your disk',
    body: 'Orders, customers and loyalty points are written to one file on the machine you chose. Back it up with whatever you already back up with.',
  },
  {
    icon: Lock,
    title: 'Nothing phones home',
    body: 'No account to create, no telemetry, no analytics and no third-party scripts. The only outbound request this software makes is the one your customers make.',
  },
  {
    icon: Server,
    title: 'Runs where you want',
    body: 'A small VPS, a box under the counter, or a cluster you already run. Node and about 65 MB of memory is the whole requirement.',
  },
  {
    icon: Terminal,
    title: 'No key, no licence server',
    body: 'There is nothing to activate and nothing to phone. Start the process and it is running, and it keeps running.',
  },
];

// Where the public source lives. One constant, because the previous build had
// this URL written out in four places and they had already drifted from the docs.
const GITHUB_URL = 'https://github.com/YOUR-GITHUB-ACCOUNT/pos';
const README_URL = `${GITHUB_URL}#readme`;

function slugify(value) {
  return String(value || '')
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export default function Landing() {
  // Which half of the entry panel to show. The server knows whether this install
  // has a shop yet, and it is the only thing that does: a browser cannot tell
  // "never set up" from "already running" by looking at the page.
  const { setupRequired } = usePlatformConfig();
  const needsSetup = setupRequired === true;
  const [tab, setTab] = useState(() => (needsSetup ? 'setup' : 'signin'));

  useEffect(() => {
    api.setStore('');
    document.title = 'Everlyce POS · Open source point of sale for restaurants and cafés';
  }, []);

  // The install might be set up in another tab while this page is open, so the
  // panel is moved off the setup tab when the server says it no longer applies.
  useEffect(() => {
    if (!needsSetup && tab === 'setup') setTab('signin');
  }, [needsSetup, tab]);

  return (
    <div className="site">
      <main>
        <Hero onStart={() => setTab('setup')} onSignIn={() => setTab('signin')} needsSetup={needsSetup} />
        <Features />
        <Owned />
        <Install />
        <Footer />
      </main>
      <EntryPanel tab={tab} setTab={setTab} needsSetup={needsSetup} />
    </div>
  );
}

// --------------------------------------------------------------------- hero

// The hero's job in this build is to say what is different about owning it, not
// to sell a subscription. The hosted version led with a free trial; there is no
// trial here, and pretending otherwise would be the first thing a shop owner
// notices is missing.
function Hero({ onStart, onSignIn, needsSetup }) {
  return (
    <section className="hero">
      <div className="wrap hero-grid">
        <div>
          <span className="eyebrow"><Server size={14} /> Open source, self hosted, yours</span>
          <h1>Your shop. Your server. Your data.</h1>
          <p className="lede">
            A complete point of sale that runs on a machine you control. No account,
            no subscription, no key to activate, and nothing phoning home. Your orders
            and your customers stay in a file on your disk.
          </p>
          <div className="hero-actions">
            <a className="btn primary lg" href="#getstarted" onClick={needsSetup ? onStart : onSignIn}>
              {needsSetup ? <>Set up this install <ArrowRight size={18} /></> : <>Sign in <ArrowRight size={18} /></>}
            </a>
            <a className="btn ghost lg" href="#install">
              <Terminal size={18} /> How to install it
            </a>
          </div>
          <ul className="hero-points">
            <li><CheckCircle2 size={16} /> No account and no sign-up</li>
            <li><CheckCircle2 size={16} /> No card, ever</li>
            <li><CheckCircle2 size={16} /> No telemetry or analytics</li>
            <li><CheckCircle2 size={16} /> AGPL-3.0, source included</li>
          </ul>
          <p className="hero-open">
            Read the source, fork it, or file an issue. It is on{' '}
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>.
          </p>
        </div>
        <div className="hero-card" aria-hidden="true">
          <div className="hero-card-top">
            <span className="dot" /><span className="dot" /><span className="dot" />
            <span className="url">your-server/your-shop</span>
          </div>
          <div className="hero-card-body">
            <div className="line w60" />
            <div className="line w40" />
            <div className="tile-row">
              <div className="tile"><span className="tile-num">128</span><span className="tile-lbl">Orders today</span></div>
              <div className="tile"><span className="tile-num">THB 24.5k</span><span className="tile-lbl">Sales</span></div>
            </div>
            <div className="line w80" />
            <div className="line w50" />
            <div className="pill-row">
              <span className="pill on">Dine in</span>
              <span className="pill">Takeaway</span>
              <span className="pill">QR order</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------- features

function Features() {
  return (
    <section className="section" id="features">
      <div className="wrap">
        <SectionHead eyebrow="Built for real shops" title="Everything a restaurant actually needs" />
        <div className="feature-grid">
          {FEATURES.map((f) => (
            <article className="feature" key={f.title}>
              <span className="feature-icon"><f.icon size={20} /></span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function SectionHead({ eyebrow, title, sub }) {
  return (
    <div className="section-head">
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <h2>{title}</h2>
      {sub ? <p className="sub">{sub}</p> : null}
    </div>
  );
}

// What owning it means. Four answers to the questions a shop owner asks before
// they will run anything at their own counter.
function Owned() {
  return (
    <section className="section alt" id="owned">
      <div className="wrap">
        <SectionHead
          eyebrow="What you get"
          title="What running it yourself actually means"
          sub="No surprise invoices, and nothing leaves your server unless you make it."
        />
        <div className="feature-grid">
          {OWNED.map((f) => (
            <article className="feature" key={f.title}>
              <span className="feature-icon"><f.icon size={20} /></span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

// Installing it. Short on purpose: the README carries the detail, and a page that
// tries to be the manual is a page that goes stale against a repository.
function Install() {
  const steps = [
    {
      n: '01',
      title: 'Clone and install',
      body: 'Node and npm, then npm install in the repository root. There is no database server to provision and nothing to sign up for.',
    },
    {
      n: '02',
      title: 'Configure one environment variable',
      body: 'Set POS_SELF_HOST=1 so the install runs as one shop with no online registration, and put it behind a reverse proxy with TLS.',
    },
    {
      n: '03',
      title: 'Start it and set up your shop',
      body: 'npm start, open the page, and name your shop. The first account you create is the owner, and it is the only credential there is to keep.',
    },
  ];
  return (
    <section className="section" id="install">
      <div className="wrap">
        <SectionHead
          eyebrow="Install"
          title="Running in three steps"
          sub="The README has the systemd unit, the nginx config and the backup notes."
        />
        <ol className="steps">
          {steps.map((s) => (
            <li className="step" key={s.n}>
              <span className="step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
        <p className="plan-note">
          <a href={README_URL} target="_blank" rel="noreferrer">
            Read the full setup instructions in the README <ArrowRight size={15} />
          </a>
        </p>
      </div>
    </section>
  );
}

function Footer() {
  // Read from the same platform copy the privacy page uses, so the two cannot
  // disagree about whether we set cookies.
  const [storageNote, setStorageNote] = useState('');
  useEffect(() => {
    let live = true;
    fetch('/api/platform-content/en')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!live || !d || !d['cookies.none']) return;
        const body = d['cookies.body'] || '';
        // The first sentence is the claim; the rest is the detail and belongs on
        // the notice itself rather than in a footer.
        const first = body.split(/(?<=\.)\s+/)[0] || body;
        setStorageNote(first);
      })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div className="site-brand">
          <img src={BRAND_LOGO} width={28} height={28} alt="" />
          <span>Everlyce <b>POS</b></span>
        </div>
        <p>Open source point of sale for restaurants and cafés. AGPL-3.0-or-later.</p>
        <div className="footer-actions">
          <a className="btn sm" href={README_URL} target="_blank" rel="noreferrer">
            <Terminal size={15} /> Install it
          </a>
          <a className="btn sm" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <Github size={15} /> Source code
          </a>
        </div>
        {/* The privacy notice is published by every shop and is a legal document
            the site owes anyone, so it is linked plainly rather than left to be
            guessed at. */}
        <p className="legal-links">
          <a href="/privacy">Privacy notice</a>
          <span aria-hidden="true">·</span>
          <a href="/privacy#storage">Cookies and browser storage</a>
        </p>
        <p className="legal-note">
          {storageNote}
        </p>
      </div>
    </footer>
  );
}

// ------------------------------------------------------------- entry panel

// The entry panel. Two tabs rather than three, because a self-hosted install has
// no key workflow at all: "activate with a key" existed for a hosted shop waiting
// on someone to issue one, and there is nobody to issue it.
//
// "Set up" only appears when the server says this install has no shop yet. On an
// install that is already running, offering it would be offering to overwrite a
// working shop, and the server would refuse it anyway.
function EntryPanel({ tab, setTab, needsSetup }) {
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    setNotice(null);
  }, [tab]);

  return (
    <section className="section" id="getstarted">
      <div className="wrap">
        <div className="entry">
          <div className="entry-side">
            <SectionHead
              eyebrow={needsSetup ? 'First run' : 'Get started'}
              title={notice ? notice.title : needsSetup ? 'Set up your shop' : 'Sign in to your shop'}
            />
            <p className="sub">
              {notice
                ? notice.body
                : needsSetup
                  ? 'Name your shop, pick its web address and choose the account you will sign in with. That is the whole setup: no key, no card, no email confirmation, and nothing to wait for.'
                  : 'Enter your shop ID and account details. Staff can sign in with a PIN at the counter instead.'}
            </p>
            {notice && (
              <div className="notice-box">
                <strong>{notice.title}</strong>
                <p>{notice.body}</p>
              </div>
            )}
            <ul className="entry-points">
              <li><CheckCircle2 size={16} /> Your shop ID is the first part of your address</li>
              <li><CheckCircle2 size={16} /> Your PIN works at the counter</li>
              <li><CheckCircle2 size={16} /> Staff accounts are per shop</li>
            </ul>
          </div>
          <div className="entry-card">
            <div className="tabs">
              {needsSetup ? (
                <>
                  <button className={tab === 'setup' ? 'on' : ''} onClick={() => setTab('setup')}>Set up this install</button>
                  <button className={tab === 'signin' ? 'on' : ''} onClick={() => setTab('signin')}>Sign in</button>
                </>
              ) : (
                <button className={tab === 'signin' ? 'on' : ''} onClick={() => setTab('signin')}>Sign in</button>
              )}
            </div>
            {tab === 'setup' ? <Setup setNotice={setNotice} /> : null}
            {tab === 'signin' ? <SignIn setNotice={setNotice} /> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

// The first-run form. Posts to /platform/setup, which is the whole point of this
// build: the shop is created and live in one request, with an owner to sign in
// as, and nothing is emailed because the operator is already sitting here.
function Setup({ setNotice }) {
  const [form, setForm] = useState({ storeName: '', storeId: '', contactName: '', username: 'owner', password: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [hint, setHint] = useState(() => slugify(form.storeId || form.storeName));
  const set = (k) => (e) => {
    const value = e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    // The address is derived until the field is touched by hand, which is the
    // behaviour the hosted registration form had and the reason nobody is ever
    // surprised by the URL they end up with.
    if (k === 'storeName' || k === 'storeId') {
      setHint(slugify(k === 'storeId' ? value : form.storeId || value));
    }
  };

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!form.storeName.trim()) return setErr('Please enter your shop name');
    if (form.password.length < 12) return setErr('Password must be at least 12 characters');
    setBusy(true);
    try {
      const d = await post('/platform/setup', form);
      setDone(d);
      api.rememberStore(d.store.slug);
    } catch (ex) {
      setErr(ex.message || 'Could not set up this install');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="entry-form">
        <FormOk>Your shop is running.</FormOk>
        <p className="sub">{done.message}</p>
        <a className="btn primary wide" href={done.signInPath}>Sign in and start taking orders</a>
        <p className="fineprint">
          Back up <code>$POS_DATA_DIR/data.json</code> regularly. It is your orders,
          your menu and your customers, and the only copy there is.
        </p>
      </div>
    );
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <Field label="Shop name" value={form.storeName} onChange={set('storeName')} placeholder="Bangkok Coffee" required />
      <Field
        label="Shop ID"
        value={form.storeId}
        onChange={set('storeId')}
        placeholder={slugify('Bangkok Coffee') || 'your-shop'}
        hint={hint ? `Your address will be /${hint}` : 'Letters, numbers and dashes'}
        spellCheck="false"
      />
      <Field label="Your name" value={form.contactName} onChange={set('contactName')} placeholder="Who is running the till?" />
      <div className="reg-divider"><span>Your sign-in</span></div>
      <Field label="Username" value={form.username} onChange={set('username')} autoComplete="username" required />
      <Field
        label="Password"
        type="password"
        value={form.password}
        onChange={set('password')}
        hint="At least 12 characters"
        autoComplete="new-password"
        required
      />
      <FormError>{err}</FormError>
      <button className="btn primary wide" disabled={busy} type="submit">
        {busy ? <Loader2 size={16} className="spin" /> : 'Set up my shop'}
      </button>
      <p className="fineprint">
        One shop per install, by design. There is no card, no key and no email to wait for.
      </p>
    </form>
  );
}

function Field({ label, hint, ...rest }) {
  return (
    <label className="fld">
      <span>{label}</span>
      <input {...rest} />
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function FormError({ children }) {
  if (!children) return null;
  return <div className="form-error"><CircleAlert size={15} /> <span>{children}</span></div>;
}

function FormOk({ children }) {
  if (!children) return null;
  return <div className="form-ok"><CheckCircle2 size={15} /> <span>{children}</span></div>;
}

function SignIn({ setNotice }) {
  const nav = useNavigate();
  const [storeId, setStoreId] = useState(() => api.lastStore());
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [mode, setMode] = useState('account');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const slug = useMemo(() => slugify(storeId), [storeId]);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!slug) return setErr('Enter your store ID');
    setBusy(true);
    try {
      const body = mode === 'account'
        ? { username, password, store: slug }
        : { username, pin, store: slug };
      const d = await post('/auth/login', body);
      const target = d.store?.slug || slug;
      api.setSession(d.token, d.user, target);
      api.rememberStore(target);
      // No redirect to an activation screen, unlike the hosted build. A
      // single-store install is always usable, so the server never sets
      // activationRequired, and the page it would point at is switched off under
      // POS_SELF_HOST anyway.
      const dest = d.user.role === 'kds' ? `/${target}/kds` : d.user.role === 'display' ? `/${target}/display` : `/${target}`;
      nav(dest, { replace: true });
    } catch (ex) {
      setErr(ex.message || 'Sign in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="entry-form" onSubmit={submit}>
      <Field
        label="Store ID"
        placeholder="your-shop"
        value={storeId}
        onChange={(e) => setStoreId(e.target.value)}
        hint="The first part of your store address, e.g. your-shop"
        autoComplete="off"
        spellCheck="false"
      />
      <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
      {mode === 'account' ? (
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      ) : (
        <Field label="Staff PIN" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} maxLength={6} required />
      )}
      <FormError>{err}</FormError>
      <button className="btn primary wide" disabled={busy || !slug} type="submit">
        {busy ? <Loader2 size={16} className="spin" /> : 'Sign in'}
      </button>
      <button type="button" className="linkish" onClick={() => setMode(mode === 'account' ? 'pin' : 'account')}>
        {mode === 'account' ? 'Use a staff PIN instead' : 'Use a password instead'}
      </button>
    </form>
  );
}
