import React, { useCallback, useEffect, useState } from 'react';
import { get, post, del } from '../lib/api';
import { useToast } from '../components/Toast';
import { Confirm, Empty } from '../components/ui';
import { KeyRound } from 'lucide-react';
import { useI18n } from '../i18n';

// Store API keys, for integrations that are not a person at a till.
//
// The key is shown once, at creation, and only its hash is kept, so there is
// nothing to reveal later. Revoking takes effect on the integration's very next
// call rather than waiting for a session to expire.
export default function Integrations() {
  const { t } = useI18n();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState({ 'catalog:read': true, 'orders:read': true, 'orders:write': false });
  const [issued, setIssued] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await get('/api-keys'));
    } catch (e) {
      setData({ scopes: [], keys: [] });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function create() {
    const chosen = Object.keys(scopes).filter((k) => scopes[k]);
    if (!chosen.length) { toast.error(t('Pick at least one permission')); return; }
    setBusy(true);
    try {
      const res = await post('/api-keys', { label, scopes: chosen });
      setIssued(res.key);
      setLabel('');
      await load();
    } catch (e) {
      toast.error(e.message || t('Could not create the key'));
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    const target = revoking;
    setRevoking(null);
    try {
      await del(`/api-keys/${target.id}`);
      toast.success(t('Key revoked'));
      await load();
    } catch (e) {
      toast.error(e.message || t('Could not revoke the key'));
    }
  }

  if (!data) return <div className="loading">{t('Loading')}…</div>;
  const keys = data.keys || [];

  return (
    <>
      <div className="card mt">
        <h3>{t('Integrations and API keys')}</h3>
        <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 12 }}>
          {t('A key lets another system read this shop menu and push orders in, without anyone signing in. A key only ever reaches this one shop, and it is refused everywhere else including this website.')}
        </div>

        {issued ? (
          <div className="warn-strip" style={{ display: 'block' }}>
            <strong>{t('Copy this key now. It is not shown again.')}</strong>
            <div className="mono" style={{ marginTop: 8, wordBreak: 'break-all', userSelect: 'all' }}>{issued}</div>
            <button className="btn" style={{ marginTop: 10 }} onClick={() => setIssued(null)}>{t('I have copied it')}</button>
          </div>
        ) : null}

        <div className="form-grid mt">
          <div className="field">
            <label>{t('Name this integration')}</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('e.g. Delivery platform, Kiosk, Accounting')}
              maxLength={60}
            />
          </div>
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label>{t('What it may do')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
            {(data.scopes || []).map((s) => (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={Boolean(scopes[s.id])}
                  onChange={(e) => setScopes({ ...scopes, [s.id]: e.target.checked })}
                />
                {t(s.label)}
              </label>
            ))}
          </div>
        </div>

        <button className="btn primary" style={{ marginTop: 14 }} disabled={busy} onClick={create}>
          {t('Create API key')}
        </button>
      </div>

      <div className="card mt">
        <h3>{t('Existing keys')}</h3>
        {keys.length === 0 ? (
          <div style={{ marginTop: 12 }}>
            <Empty icon={KeyRound} title={t('No integration keys yet')}>{t('Create one above and an outside system can read this shop menu.')}</Empty>
          </div>
        ) : (
          <div className="table-wrap mt">
            <table className="data">
              <thead>
                <tr>
                  <th>{t('Name')}</th>
                  <th>{t('Permissions')}</th>
                  <th>{t('Created')}</th>
                  <th className="num">{t('Used')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id} style={k.revokedAt ? { opacity: 0.5 } : undefined}>
                    <td>
                      <div>{k.label}</div>
                      <div className="mono muted" style={{ fontSize: 12 }}>{k.prefix}…</div>
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {(k.scopes || []).map((s) => t(data.scopes.find((x) => x.id === s)?.label || s)).join(', ')}
                    </td>
                    <td className="muted" style={{ fontSize: 12.5 }}>
                      {k.revokedAt
                        ? t('Revoked')
                        : new Date(k.createdAt).toLocaleDateString()}
                    </td>
                    <td className="num">{k.useCount || 0}</td>
                    <td style={{ textAlign: 'right' }}>
                      {k.revokedAt ? null : (
                        <button className="btn" onClick={() => setRevoking(k)}>{t('Revoke')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>
          {t('Send the key as an Authorization header: Bearer evk_… The base address is https://pos.example.com/api/v1.')}
        </div>
      </div>

      {revoking ? (
        <Confirm
          title={t('Revoke this key?')}
          message={t('Any integration using it stops working on its next request. This cannot be undone.')}
          onYes={revoke}
          onCancel={() => setRevoking(null)}
        />
      ) : null}
    </>
  );
}
