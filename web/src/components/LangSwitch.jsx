import React from 'react';
import { useI18n } from '../i18n';

export default function LangSwitch({ className = '' }) {
  const { lang, setLang, t } = useI18n();
  return (
    <div className={`lang-switch ${className}`.trim()} role="group" aria-label={t('Language')}>
      <button className={lang === 'th' ? 'on' : ''} onClick={() => setLang('th')}>ไทย</button>
      <button className={lang === 'en' ? 'on' : ''} onClick={() => setLang('en')}>EN</button>
    </div>
  );
}