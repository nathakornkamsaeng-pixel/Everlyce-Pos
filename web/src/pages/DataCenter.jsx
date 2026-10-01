import React, { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../lib/api';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';
import { Trash2, AlertTriangle, ShieldCheck, BarChart3, Database, ScrollText, RefreshCw, KeyRound } from 'lucide-react';

function ms(v) {
  if (!v && v !== 0) return '—';
  const m = Math.round(v / 60000);
  if (m < 1) return '<1 min';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function DataCenter() {
  const [tab, setTab] = useState('stats');
  const [targets, setTargets] = useState([]);
  const [picked, setPicked] = useState([]);
  const [stats, setStats] = useState(null);
  const [log, setLog] = useState({ lines: [], size: 0, max: 0 });
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [pwVisible, setPwVisible] = useState(false);
  const toast = useToast();
  const { t } = useI18n();

  const loadStats = useCallback(() => {
    get('/kds/stats').then(setStats).catch(() => {});
  }, []);
  const loadLog = useCallback(() => {
    get('/admin/data/log?lines=400').then(setLog).catch(() => {});
  }, []);

  useEffect(() => {
    get('/admin/data/targets').then((d) => setTargets(d.targets || d || [])).catch(() => {});
    loadStats();
    loadLog();
  }, [loadStats, loadLog]);

  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  // The admin must prove who they are before anything is destroyed.
  async function reauth() {
    if (!password) { setAuthError(t('Enter your password to continue')); return false; }
    setBusy(true);
    setAuthError('');
    try {
      await post('/auth/reauth', { password });
      setAuthenticated(true);
      return true;
    } catch (e) {
      setAuthError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!picked.length) return;
    if (!authenticated && !(await reauth())) return;
    setBusy(true);
    try {
      const r = await post('/admin/data/clear', { targets: picked });
      const n = Object.values(r.removed || {}).reduce((s, x) => s + x, 0);
      toast(`${t('Cleared')} ${n} ${t('record(s)')}`);
      setPicked([]);
      setConfirming(false);
      setAuthenticated(false);
      setPassword('');
      setPwVisible(false);
      loadStats();
      loadLog();
    } catch (e) {
      toast(t(e.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function clearLog() {
    setBusy(true);
    try {
      await del('/admin/data/log');
      toast(t('Log cleared'));
      loadLog();
    } catch (e) {
      toast(t(e.message), 'error');
    } finally {
      setBusy(false);
    }
  }

  const pct = log.max ? Math.min(100, (log.size / log.max) * 100) : 0;

  return (
    <>
      <div className="topbar">
        <h1>{t('Data')}</h1>
        <div className="tabs-inline">
          <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}><BarChart3 size={15} /> {t('Statistics')}</button>
          <button className={tab === 'clear' ? 'on danger' : ''} onClick={() => setTab('clear')}><Trash2 size={15} /> {t('Clear data')}</button>
          <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}><ScrollText size={15} /> {t('Log')}</button>
        </div>
      </div>
      <div className="content">

        {tab === 'stats' && (
          <div className="card" style={{ maxWidth: 760 }}>
            <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Kitchen performance')}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
              {t('Timed from the moment an order reaches the kitchen to the moment it is marked done.')}
            </div>
            {!stats || !stats.completed ? (
              <div className="muted">{t('No completed orders yet.')}</div>
            ) : (
              <>
                <div className="kpi-row">
                  <div className="kpi"><b>{stats.completed}</b><span>{t('Completed')}</span></div>
                  <div className="kpi"><b>{ms(stats.averageMs)}</b><span>{t('Average')}</span></div>
                  <div className="kpi"><b>{ms(stats.todayAverageMs)}</b><span>{t('Today')}</span></div>
                  <div className="kpi"><b>{ms(stats.slowestMs)}</b><span>{t('Slowest')}</span></div>
                </div>
                {stats.byDay.length > 1 && (
                  <div className="mt">
                    <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('Daily average')}</div>
                    {stats.byDay.map((d) => (
                      <div key={d.day} className="bar-row">
                        <span className="bar-label">{d.day.slice(5)}</span>
                        <span className="bar-track"><span className="bar-fill" style={{ width: `${Math.min(100, (d.avgMs / (stats.slowestMs || 1)) * 100)}%` }} /></span>
                        <span className="bar-val">{ms(d.avgMs)} · {d.count}</span>
                      </div>
                    ))}
                  </div>
                )}
                {stats.topItems.length > 0 && (
                  <div className="mt">
                    <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>{t('Busiest items')}</div>
                    {stats.topItems.map((i) => (
                      <div key={i.name} className="bar-row">
                        <span className="bar-label" style={{ flex: 1 }}>{t(i.name)}</span>
                        <span className="bar-val">{i.count}× · {ms(i.avgMs)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === 'clear' && (
          <div className="card danger-card" style={{ maxWidth: 760 }}>
            <div className="section-title mb0" style={{ marginTop: 0, color: 'var(--danger)' }}>{t('Clear data')}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
              {t('Tick what you want to remove. Nothing is deleted until you confirm and sign in again.')}
            </div>
            {targets.map((x) => (
              <label key={x.id} className={`clear-row${picked.includes(x.id) ? ' on' : ''}`}>
                <input type="checkbox" checked={picked.includes(x.id)} onChange={() => toggle(x.id)} />
                <span>
                  <strong>{t(x.label)}</strong>
                  <span className="muted" style={{ display: 'block', fontSize: 12.5 }}>{t(x.hint)}</span>
                </span>
              </label>
            ))}

            {picked.length > 0 && !confirming && (
              <button className="btn danger mt" onClick={() => { setConfirming(true); setPwVisible(true); setAuthenticated(false); setAuthError(''); setPassword(''); }}>
                <Trash2 size={15} /> {t('Continue')} ({picked.length})
              </button>
            )}

            {confirming && (
              <div className="confirm-box">
                <div className="confirm-msg">
                  <AlertTriangle size={17} />
                  <span>{t('You are about to permanently delete')} <b>{picked.length}</b> {t('selected item(s). This cannot be undone.')}</span>
                </div>

                {!authenticated && (
                  <div className="reauth">
                    <label><KeyRound size={15} /> {t('Re-enter your admin password to confirm')}</label>
                    <div className="reauth-row">
                      <input
                        type={pwVisible ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setAuthError(''); }}
                        onKeyDown={(e) => e.key === 'Enter' && reauth()}
                        placeholder={t('Admin password')}
                        autoFocus
                      />
                      <button className="btn" onClick={() => setPwVisible((v) => !v)}>{pwVisible ? t('Hide') : t('Show')}</button>
                      <button className="btn" onClick={reauth} disabled={busy || !password}>
                        <ShieldCheck size={15} /> {t('Verify')}
                      </button>
                    </div>
                    {authError && <div className="error-text">{t(authError)}</div>}
                  </div>
                )}

                {authenticated && <div className="reauth-ok"><ShieldCheck size={15} /> {t('Verified. You can delete now.')}</div>}

                <div className="row" style={{ gap: 8, marginTop: 12 }}>
                  <button className="btn danger" onClick={run} disabled={busy || !authenticated}>
                    {busy ? '…' : `${t('Delete permanently')} (${picked.length})`}
                  </button>
                  <button className="btn" onClick={() => { setConfirming(false); setPicked([]); setPassword(''); setAuthenticated(false); }} disabled={busy}>
                    {t('Cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'log' && (
          <div className="card" style={{ maxWidth: 900 }}>
            <div className="spread" style={{ alignItems: 'center', marginBottom: 4 }}>
              <div className="section-title mb0" style={{ marginTop: 0 }}>{t('Activity log')}</div>
              <div className="row" style={{ gap: 8 }}>
                <button className="btn sm" onClick={loadLog}><RefreshCw size={14} /> {t('Refresh')}</button>
                <button className="btn sm danger" onClick={clearLog} disabled={busy}><Trash2 size={14} /> {t('Clear log')}</button>
              </div>
            </div>
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
              {t('One line per event. The log stops at 0.5 GB and rolls over to a previous file.')}
            </div>
            <div className="log-meter">
              <span className="log-meter-fill" style={{ width: `${Math.max(1, pct)}%` }} />
              <span className="log-meter-text">{bytes(log.size)} / {bytes(log.max)}</span>
            </div>
            <pre className="log-view">{log.lines.length ? log.lines.join('\n') : t('Nothing logged yet.')}</pre>
          </div>
        )}
      </div>
    </>
  );
}
