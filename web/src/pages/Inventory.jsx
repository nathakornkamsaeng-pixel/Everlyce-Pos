import React, { useEffect, useState } from 'react';
import { get, put } from '../lib/api';
import { fmtMoney } from '../lib/api';
import { useToast } from '../components/Toast';
import { useI18n } from '../i18n';

export default function Inventory() {
  const { t } = useI18n();
  const [products, setProducts] = useState([]);
  const [low, setLow] = useState([]);
  const toast = useToast();

  function load() {
    Promise.all([get('/products'), get('/inventory/low-stock')]).then(([p, l]) => { setProducts(p); setLow(l); }).catch(() => {});
  }
  useEffect(() => { load(); }, []);

  async function adjust(p, add) {
    try {
      await put('/inventory/stock', { productId: p.id, add });
      toast(t('Stock updated'), 'ok'); load();
    } catch (e) { toast(t(e.message), 'error'); }
  }

  const tracked = products.filter((p) => p.trackStock);

  return (
    <>
      <div className="topbar"><h1>{t('Inventory')}</h1></div>
      <div className="content">
        {low.length > 0 && (
          <div className="card mt" style={{ borderColor: 'var(--red)', background: '#fef2f2' }}>
            <strong>{t('Low stock alert')}</strong>
            <div className="row mt" style={{ flexWrap: 'wrap' }}>
              {low.map((p) => <span key={p.id} className="badge red">{p.name}: {p.stockCount} left</span>)}
            </div>
          </div>
        )}
        <div className="card mt">
          <div className="section-title mb0">{t('Stock levels')}</div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{t('Product')}</th><th>{t('SKU')}</th><th className="num">{t('Stock')}</th><th className="num">{t('Low at')}</th><th className="num">{t('Cost')}</th><th style={{ textAlign: 'right' }}>{t('Adjust')}</th></tr></thead>
              <tbody>
                {tracked.length === 0 && <tr><td colSpan={6} className="muted">{t('No products track stock yet — enable “Track stock” in the Menu editor.')}</td></tr>}
                {tracked.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.name}</strong></td>
                    <td className="mono muted">{p.sku || '—'}</td>
                    <td className="num" style={{ color: p.stockCount <= p.lowStockThreshold ? 'var(--red)' : 'inherit', fontWeight: p.stockCount <= p.lowStockThreshold ? 700 : 400 }}>{p.stockCount}</td>
                    <td className="num">{p.lowStockThreshold}</td>
                    <td className="num">{fmtMoney(p.cost)}</td>
                    <td className="num">
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <button className="btn sm" onClick={() => adjust(p, -1)}>−1</button>
                        <button className="btn sm" onClick={() => adjust(p, 1)}>+1</button>
                        <button className="btn sm primary" onClick={() => adjust(p, 10)}>+10</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}