import React, { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { fmtDateTime } from '../lib/api';

// Live wall clock, so staff always see the real date and time.
export default function Clock({ className = '', seconds = false }) {
  const { lang } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), seconds ? 1000 : 15000);
    return () => clearInterval(tick);
  }, [seconds]);

  return <span className={`tk-clock ${className}`.trim()}>{fmtDateTime(now, lang)}</span>;
}
