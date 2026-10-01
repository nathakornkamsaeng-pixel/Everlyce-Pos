import React, { useEffect, useState } from 'react';
import { get, post, put } from '../lib/api';
import { useToast } from '../components/Toast';
import { Empty } from '../components/ui';
import { Search, Sparkles, Send, Languages, Check } from 'lucide-react';
import { useI18n } from '../i18n';

// This shop's own wording: its menu, its categories, its modifiers, its tables.
//
// Deliberately not the software's own words. Those are the same for every shop
// and are managed centrally, so they are not editable here: a shop fixing a typo
// in its own menu should not be able to change what every other shop's checkout
// button says, and should not have to ask anyone to do it either.

function EditRow({ entry, onSave, busy, t }) {
  const [th, setTh] = useState(entry.th || '');
  const [open, setOpen] = useState(false);
  useEffect(() => { setTh(entry.th || ''); }, [entry.th]);

  if (!open) {
    return (
      <tr>
        <td>{entry.source}</td>
        <td>{entry.th || <span className="muted">not translated yet</span>}</td>
        <td>
          <span className={`badge ${entry.status === 'published' ? 'ok' : entry.status === 'draft' ? 'warn' : 'gray'}`}>
            {entry.status === 'published' ? 'Live' : entry.status === 'draft' ? 'Draft' : 'Missing'}
          </span>
        </td>
        <td className="row-actions">
          <button className="btn sm" onClick={() => setOpen(true)}>{t('Translate')}</button>
        </td>
      </tr>
    );
  }
  return (
    <tr>
      <td>{entry.source}</td>
      <td>
        <input
          value={th}
          onChange={(e) => setTh(e.target.value)}
          placeholder="พิมพ์ภาษาไทย"
          autoFocus
          maxLength={500}
        />
      </td>
      <td><span className="muted">{t('Saves as a draft')}</span></td>
      <td className="row-actions">
        <button className="btn sm primary" disabled={busy || !th.trim()} onClick={() => onSave(entry.id, th)}>
          <Check size={14} /> {t('Save')}
        </button>
        <button className="btn sm" onClick={() => { setTh(entry.th || ''); setOpen(false); }}>{t('Cancel')}</button>
      </td>
    </tr>
  );
}

export default function StoreTranslations() {
  const { t } = useI18n();
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');

  const load = (params = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.status) query.set('status', params.status);
    get(`/i18n/mine/entries?${query.toString()}`).then((d) => {
      setEntries(d.entries || []);
      setCounts(d.counts || {});
    }).catch((e) => toast(e.message, 'error'));
  };

  useEffect(() => { load(); }, []);

  async function run(name, fn, message) {
    setBusy(name);
    try {
      await fn();
      if (message) toast(message, 'ok');
      load();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy('');
    }
  }

  const search = () => load({ q, status: filter });

  return (
    <>
      <div className="topbar">
        <h1>{t('Menu translations')}</h1>
        <div className="page-actions">
          <button
            className="btn"
            disabled={busy === 'collect'}
            onClick={() => run('collect', () => post('/i18n/mine/collect', {}), t('Your menu has been scanned'))}
          >
            <Search size={15} /> {t('Scan my menu')}
          </button>
          <button
            className="btn"
            disabled={busy === 'translate'}
            onClick={() => run('translate', () => post('/i18n/mine/translate', {}), t('Translations added'))}
          >
            <Sparkles size={15} /> {t('Translate missing')}
          </button>
          <button
            className="btn primary"
            disabled={busy === 'publish'}
            onClick={() => run('publish', () => post('/i18n/mine/publish', { all: true }), t('Published'))}
          >
            <Send size={15} /> {t('Publish all')}
          </button>
        </div>
      </div>

      <div className="content">
        <div className="note-strip" style={{ marginBottom: 14 }}>
          <Languages size={16} />
          <span>
            {t('These are your own words: your menu items, categories, modifiers and tables. They are what your customers see on the QR menu, and nothing here affects any other shop. The buttons and screens of Everlyce POS itself are translated centrally and apply to everyone.')}
          </span>
        </div>

        <div className="card" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="search" style={{ flex: 1, minWidth: 200 }}>
            <Search size={15} className="mag" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
              placeholder={t('Search English or Thai')}
            />
          </div>
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setTimeout(search, 0); }} style={{ minWidth: 160 }}>
            <option value="">{t('All')} ({entries.length})</option>
            <option value="published">{t('Live')} ({counts.published || 0})</option>
            <option value="draft">{t('Draft')} ({counts.draft || 0})</option>
            <option value="missing">{t('Missing')} ({counts.missing || 0})</option>
          </select>
          <button className="btn sm" onClick={search}>{t('Search')}</button>
        </div>

        {entries.length === 0 ? (
          <div className="card mt">
            <Empty title={t('Nothing to translate yet')}>
              {t('Scan your menu and every item, category and modifier will appear here to translate.')}
            </Empty>
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <button className="btn primary" disabled={busy === 'collect'} onClick={() => run('collect', () => post('/i18n/mine/collect', {}), t('Your menu has been scanned'))}>
                <Search size={15} /> {t('Scan my menu')}
              </button>
            </div>
          </div>
        ) : (
          <div className="card mt" style={{ padding: 0, overflow: 'hidden' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('English')}</th>
                  <th>{t('Thai')}</th>
                  <th>{t('Status')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <EditRow
                    key={entry.id}
                    entry={entry}
                    t={t}
                    busy={busy === `save${entry.id}`}
                    onSave={(id, th) => run(`save${id}`, () => put(`/i18n/mine/entries/${id}`, { th }), t('Saved as a draft. Publish when you are ready.'))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}