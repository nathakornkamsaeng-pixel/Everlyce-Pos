import React, { useEffect, useRef, useState } from 'react';
import { Delete } from 'lucide-react';
import { useI18n } from '../i18n';

// Large keys for entering amounts, phone numbers and quantities quickly.
const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'];

export function NumpadDisplay({ value, placeholder = '0', className = '' }) {
  const empty = value === null || value === undefined || value === '';
  const display = empty ? placeholder : String(value);
  const classes = ['numpad-value', empty ? 'empty' : '', className].filter(Boolean).join(' ');
  return <output className={classes} aria-live="off">{display}</output>;
}

export default function Numpad({
  value,
  onChange,
  allowDecimal = true,
  compact = false,
  clearKey = false,
  maxLength = 0,
}) {
  const { t } = useI18n();
  const [held, setHeld] = useState(null);
  const pressTimer = useRef(null);
  const holdRef = useRef(null);

  function press(key) {
    const v = String(value ?? '');

    if (key === '⌫') {
      onChange(v.slice(0, -1));
      return;
    }
    // a phone/ID field wants a wipe key where an amount pad has the decimal
    if (key === 'C') {
      onChange('');
      return;
    }
    if (key === '.') {
      if (!allowDecimal || v.includes('.')) return;
      onChange(v ? `${v}.` : '0.');
      return;
    }
    if (maxLength && v.length >= maxLength) return;
    if (allowDecimal && v.includes('.')) {
      const [, dec] = v.split('.');
      if (dec.length >= 2) return;
    }
    // For amounts, typing over a leading "0" is what you want. For a phone
    // number it would swallow the zero that Thai numbers start with.
    if (allowDecimal && v === '0') onChange(key);
    else onChange(v + key);
  }

  function startHold(key) {
    if (key === '⌫') {
      setHeld(key);
      pressTimer.current = setTimeout(() => {
        holdRef.current = setInterval(() => {
          const current = String(value ?? '');
          if (!current) return;
          onChange(current.slice(0, -1));
        }, 90);
      }, 450);
    }
  }

  function endHold() {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null; }
    if (holdRef.current) { clearInterval(holdRef.current); holdRef.current = null; }
    setHeld(null);
  }

  useEffect(() => () => endHold(), []);

  const keys = KEYS.map((k) => (k === '.' && clearKey ? 'C' : k));

  return (
    <div className={`numpad${compact ? ' compact' : ''}`}>
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          className={`numpad-key${held === k ? ' held' : ''}${k === 'C' ? ' wide' : ''}`}
          onClick={() => press(k)}
          onPointerDown={() => startHold(k)}
          onPointerUp={endHold}
          onPointerLeave={endHold}
          onPointerCancel={endHold}
          aria-label={k === '⌫' ? t('Delete') : k === 'C' ? t('Clear') : k}
        >
          {k === '⌫' ? <Delete size={compact ? 20 : 24} /> : k}
        </button>
      ))}
    </div>
  );
}
