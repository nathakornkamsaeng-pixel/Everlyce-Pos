import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { get, fmtMoney } from '../lib/api';
import { useI18n } from '../i18n';
import { BrandLogo } from '../branding';
import { downloadReceiptImage, downloadReceiptPdf } from '../lib/receiptExport';
import { Download, ImageDown, Loader } from 'lucide-react';

export default function Receipt() {
  const { token } = useParams();
  const { t } = useI18n();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState('');

  useEffect(() => {
    get(`/public/receipt?token=${encodeURIComponent(token)}`)
      .then(setData)
      .catch((e) => setError(e.status === 410 ? t('This receipt link has expired') : t('Receipt not found')));
  }, [token, t]);

  async function save(format) {
    if (!data || downloading) return;
    setDownloading(format);
    try {
      if (format === 'pdf') await downloadReceiptPdf(data);
      else await downloadReceiptImage(data);
    } finally { setDownloading(''); }
  }

  if (error) {
    return (
      <div className="login-wrap">
        <div className="login-card receipt-card" style={{ textAlign: 'center' }}>
          <BrandLogo size={64} className="public-card-logo" />
          <h2>{t('Receipt unavailable')}</h2>
          <p className="muted">{error}</p>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="login-wrap"><div className="login-card receipt-card"><Loader size={24} /></div></div>;
  }

  const order = data.order;
  return (
    <div className="login-wrap">
      <div className="receipt-card">
        <div className="receipt-head">
          <BrandLogo size={64} />
          <div>
            <h2>{data.restaurantName}</h2>
            <div className="muted">{t('Receipt')} · {order.orderNumber}</div>
          </div>
        </div>

        <div className="spread receipt-meta">
          <span>{new Date(order.paidAt).toLocaleString()}</span>
          <span>{t('Link valid until')} {new Date(order.expiresAt).toLocaleDateString()}</span>
        </div>

        <div className="receipt-items">
          {order.items.map((item, index) => (
            <div className="receipt-item" key={`${item.name}-${index}`}>
              <div>
                <strong>{item.quantity}× {item.name}</strong>
                {item.modifiers?.length > 0 && <small>{item.modifiers.map((modifier) => modifier.option).join(' · ')}</small>}
              </div>
              <strong>{fmtMoney(item.lineTotal)}</strong>
            </div>
          ))}
        </div>

        <div className="receipt-totals">
          <div><span>{t('Subtotal')}</span><span>{fmtMoney(order.subtotal)}</span></div>
          {order.discount > 0 && <div><span>{t('Discount')}</span><span>-{fmtMoney(order.discount)}</span></div>}
          <div><span>{t('Tax')}</span><span>{fmtMoney(order.tax)}</span></div>
          <div><span>{t('Service charge')}</span><span>{fmtMoney(order.serviceCharge)}</span></div>
          {order.tip > 0 && <div><span>{t('Tip')}</span><span>{fmtMoney(order.tip)}</span></div>}
          <div className="receipt-total"><span>{t('Total')}</span><span>{fmtMoney(order.total)}</span></div>
        </div>

        <div className="muted receipt-payment">{t('Paid with')} {t(order.paymentMethod || 'paid')}</div>
        <div className="receipt-downloads">
          <button className="btn primary" onClick={() => save('pdf')} disabled={Boolean(downloading)}>
            <Download size={17} /> {downloading === 'pdf' ? t('Preparing…') : t('Download PDF')}
          </button>
          <button className="btn" onClick={() => save('image')} disabled={Boolean(downloading)}>
            <ImageDown size={17} /> {downloading === 'image' ? t('Preparing…') : t('Save as image')}
          </button>
        </div>
      </div>
    </div>
  );
}
