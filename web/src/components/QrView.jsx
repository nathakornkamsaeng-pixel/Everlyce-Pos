import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from '../i18n';

export async function downloadQr(url, filename) {
  const data = await QRCode.toDataURL(url, { width: 512, margin: 1, color: { dark: '#16181d', light: '#ffffff' } });
  const a = document.createElement('a');
  a.href = data;
  a.download = `${filename}.png`;
  a.click();
}

export default function QrView({ url, size = 176 }) {
  const { t } = useI18n();
  const [img, setImg] = useState('');
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 300, margin: 1, color: { dark: '#16181d', light: '#ffffff' } })
      .then((d) => alive && setImg(d))
      .catch(() => alive && setImg(''));
    return () => { alive = false; };
  }, [url]);
  if (!img) return <div className="loading" style={{ width: size, height: size, padding: 0 }}><div className="spin" /></div>;
  return <img src={img} alt={t('QR code')} style={{ width: size, height: size, display: 'block' }} />;
}