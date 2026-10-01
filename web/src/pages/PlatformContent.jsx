import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { get, put, patch, post } from '../lib/api';
import { Globe, RotateCcw, Save, Languages, AlertTriangle } from 'lucide-react';

// The platform's own pages.
//
// Two scopes and only two: the home page at `/`, and the PDPA privacy notice.
// Both are the platform's wording, because both are read by people who are not
// in any shop yet: a visitor before they know we exist, and a customer who is
// owed the notice whoever they gave data to.
//
// Not here: the app's buttons. Those belong to each shop, which is why they sit
// in the shop's own translations and not in a table one person could change for
// everybody.

const SCOPE_LABELS = {
  landing: { title: 'Home page', hint: 'The page at /, and the free trial wording. This is the first thing a visitor reads.' },
  privacy: { title: 'Privacy notice (PDPA)', hint: 'The legal notice every shop publishes. A customer is entitled to read this, so the Thai is a document in its own right rather than a translation of the English.' },
};

export default function PlatformContent() {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // The controller: who is legally responsible for the data, as distinct from
  // the wording about it. Kept separate from the copy because it is not copy, it
  // is a fact, and it is yours rather than any shop's.
  const [privacy, setPrivacy] = useState(null);
  // What the controller fields looked like when they were loaded.
  //
  // They are a separate editor from the copy, but they share one Save button.
  // Without this the button only watched the copy, so editing the controller's
  // name or address left it reading "Nothing changed" and disabled, and the save
  // that would have written them could never be pressed.
  const [privacyBase, setPrivacyBase] = useState(null);

  const load = useCallback(() => {
    get('/platform/content', { platform: true }).then((d) => {
      // Merged rather than replaced. Reading d straight in meant a response
      // without counts took the whole console down, which is the second time a
      // field has been assumed present and quietly taken a page with it.
      setData({
        entries: [], scopes: [], counts: { total: 0, missingThai: 0, edited: 0 },
        ...(d || {}),
        counts: { total: 0, missingThai: 0, edited: 0, ...((d && d.counts) || {}) },
      });
      setDraft({});
    }).catch(() => {});
    get('/platform/privacy', { platform: true }).then((d) => {
      setPrivacy(d);
      setPrivacyBase(d);
    }).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Grouped so the editor reads as two documents rather than a flat list.
  const grouped = useMemo(() => {
    if (!data) return [];
    return (data.scopes || []).map((scope) => ({
      scope,
      ...(SCOPE_LABELS[scope] || { title: scope, hint: '' }),
      entries: (data.entries || []).filter((e) => e.scope === scope),
    }));
  }, [data]);

  function value(entry, lang) {
    const d = draft[`${entry.scope}:${entry.key}`];
    if (d && d[lang] !== undefined) return d[lang];
    return entry[lang] || '';
  }
  function setValue(entry, lang, v) {
    const id = `${entry.scope}:${entry.key}`;
    const current = draft[id] || { en: entry.en, th: entry.th };
    setDraft({ ...draft, [id]: { ...current, [lang]: v } });
  }

  // Counted, not just flagged: a field the reader typed in and then put back
  // the way they found it is not a change, and offering to save it is noise.
  const copyChanged = Object.entries(draft).filter(([id, v]) => {
    const hit = (data && data.entries || []).find((e) => `${e.scope}:${e.key}` === id);
    return hit && (v.en !== hit.en || v.th !== hit.th);
  }).map(([id]) => id);

  const PRIVACY_FIELDS = ['controllerLegalName', 'controllerAddress', 'contactEmail'];
  const privacyChanged = privacy && privacyBase
    ? PRIVACY_FIELDS.filter((f) => (privacy[f] || '') !== (privacyBase[f] || ''))
    : [];

  const dirty = copyChanged.length + privacyChanged.length;

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const byScope = {};
      for (const [id, value] of Object.entries(draft)) {
        const [scope, ...rest] = id.split(':');
        const key = rest.join(':');
        (byScope[scope] = byScope[scope] || {})[key] = value;
      }
      for (const [scope, entries] of Object.entries(byScope)) {
        await put('/platform/content', { scope, entries }, { platform: true });
      }
      // The controller has to go in the same save. It is what the button counts
      // as a change, so leaving it out means the button can be pressed because
      // of it and then silently not write it, and the reload below puts the old
      // value straight back: the edit appears to jump to the default.
      //
      // PATCH, not PUT: /platform/config answers PATCH only, and a PUT fails
      // with a 404 that would be caught here and shown as a message nobody reads
      // before the reload undoes the edit anyway.
      if (privacyChanged.length && privacy) {
        await patch('/platform/config', { privacy }, { platform: true });
        setPrivacyBase({ ...privacy });
      }
      setMsg({ ok: true, text: 'Saved. These pages will show it to everyone straight away.' });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  async function reset(scope) {
    if (!window.confirm(`Put the ${SCOPE_LABELS[scope] ? SCOPE_LABELS[scope].title : scope} back to the wording that ships with the software? Anything you changed there will be lost.`)) return;
    setBusy(true);
    try {
      await post('/platform/content/reset', { scope }, { platform: true });
      setMsg({ ok: true, text: 'Reset to the built-in wording.' });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e.message || 'Could not reset' });
    } finally {
      setBusy(false);
    }
  }

  if (!data) return null;

  return (
    <section className="console-section">
      <h2>
        <Globe size={17} /> Platform pages <span className="count">{data.counts.total}</span>
      </h2>
      <p className="muted" style={{ marginTop: -4, marginBottom: 14 }}>
        The wording on the platform&apos;s own pages: the home page, and the PDPA
        privacy notice every shop publishes. Every shop&apos;s buttons, menu and staff
        names are the shop&apos;s own and are not here, so nothing you change on this
        page can alter what another shop&apos;s till says.
      </p>

      {(data.counts.missingThai || 0) > 0 ? (
        <div className="warn-strip" style={{ marginBottom: 14 }}>
          <AlertTriangle size={15} />
          <span>
            {data.counts.missingThai} of these strings have no Thai. The privacy
            notice is read in Thai by default, so an empty Thai string falls back
            to English on a legal document.
          </span>
        </div>
      ) : null}

      {msg ? (
        <p className={msg.ok ? 'ok-note' : 'form-error'} style={{ margin: '0 0 12px' }}>{msg.text}</p>
      ) : null}

      {grouped.map((group) => (
        <div key={group.scope} style={{ marginBottom: 26 }}>
          <div className="console-section-head" style={{ marginBottom: 6 }}>
            <h3 style={{ fontSize: 15.5, margin: 0 }}>{group.title}</h3>
            <button className="btn sm" disabled={busy} onClick={() => reset(group.scope)}>
              <RotateCcw size={14} /> Reset to built-in
            </button>
          </div>
          <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>{group.hint}</p>

          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: '22%' }}>Key</th>
                  <th>English</th>
                  <th>ไทย</th>
                </tr>
              </thead>
              <tbody>
                {group.entries.map((entry) => {
                  const changed = draft[`${entry.scope}:${entry.key}`]
                    && (draft[`${entry.scope}:${entry.key}`].en !== entry.en
                      || draft[`${entry.scope}:${entry.key}`].th !== entry.th);
                  return (
                    <tr key={`${entry.scope}:${entry.key}`} style={changed ? { background: '#fffdf5' } : undefined}>
                      <td>
                        <code style={{ fontSize: 11.5, color: 'var(--muted)' }}>{entry.key}</code>
                        {entry.edited ? <div><span className="badge blue" style={{ fontSize: 10.5 }}>edited</span></div> : null}
                      </td>
                      <td>
                        <textarea
                          rows={Math.min(4, Math.max(1, Math.ceil((entry.en || '').length / 70)))}
                          value={value(entry, 'en')}
                          onChange={(e) => setValue(entry, 'en', e.target.value)}
                        />
                      </td>
                      <td>
                        <textarea
                          rows={Math.min(4, Math.max(1, Math.ceil((entry.th || '').length / 40)))}
                          value={value(entry, 'th')}
                          onChange={(e) => setValue(entry, 'th', e.target.value)}
                          dir="th"
                          style={!value(entry, 'th') ? { borderColor: 'var(--amber, #d9a441)' } : undefined}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}

        {privacy ? (
          <div style={{ marginBottom: 26 }}>
            <div className="console-section-head" style={{ marginBottom: 6 }}>
              <h3 style={{ fontSize: 15.5, margin: 0 }}>Who is responsible for your data</h3>
            </div>
            <p className="muted" style={{ fontSize: 12.5, margin: '0 0 10px' }}>
              This is you, not the shops. Every shop&apos;s privacy notice names whoever
              runs this software as the controller of the data it holds, because that
              is who operates the service. Leave the legal name blank and a notice falls
              back to the shop&apos;s own, which is right for a self-hosted install and
              wrong for a hosted one.
            </p>
            <div className="card">
              <div className="form-grid">
                <div className="field">
                  <label>Your legal name</label>
                  <input
                    value={privacy.controllerLegalName || ''}
                    onChange={(e) => setPrivacy({ ...privacy, controllerLegalName: e.target.value })}
                    placeholder="e.g. Siam Kitchen Co., Ltd."
                  />
                </div>
                <div className="field">
                  <label>Privacy contact email</label>
                  <input
                    type="email"
                    value={privacy.contactEmail || ''}
                    onChange={(e) => setPrivacy({ ...privacy, contactEmail: e.target.value })}
                    placeholder="privacy@example.com"
                  />
                </div>
                <div className="field" style={{ gridColumn: '1 / -1' }}>
                  <label>Postal address (optional)</label>
                  <input
                    value={privacy.controllerAddress || ''}
                    onChange={(e) => setPrivacy({ ...privacy, controllerAddress: e.target.value })}
                    placeholder="Shown on every shop's privacy notice"
                  />
                </div>
              </div>
            </div>
          </div>
        ) : null}

      <div style={{ position: 'sticky', bottom: 0, padding: '10px 0', background: 'var(--bg, #fff)' }}>
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>
          <Save size={15} />
          {dirty === 0
            ? 'Nothing changed'
            : `Save ${dirty} change${dirty === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  );
}