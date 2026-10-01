import React from 'react';
import { useI18n } from '../i18n';
import { X } from 'lucide-react';

export function Modal({ title, onClose, children, footer, wide }) {
  const { t } = useI18n();
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`}>
        {title && (
          <div className="modal-head">
            <h3 className="mb0">{title}</h3>
            {onClose && <button className="btn sm ghost" onClick={onClose} aria-label={t('Close')}><X /></button>}
          </div>
        )}
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Confirm({ title, message, onYes, onCancel }) {
  const { t } = useI18n();
  return (
    <Modal title={title} onClose={onCancel}>
      <p style={{ margin: '0 0 4px' }}>{message}</p>
      <div className="modal-foot">
        <button className="btn" onClick={onCancel}>{t('Cancel')}</button>
        <button className="btn danger" onClick={onYes}>{t('Delete')}</button>
      </div>
    </Modal>
  );
}

export function Empty({ icon: Icon, title, children }) {
  return (
    <div className="empty">
      <div className="empty-icon">{Icon && <Icon />}</div>
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function StatusBadge({ status }) {
  const { t } = useI18n();
  const map = {
    pending: ['gray', 'Pending'],
    preparing: ['amber', 'Preparing'],
    ready: ['green', 'Ready'],
    served: ['blue', 'Served'],
    cancelled: ['red', 'Cancelled'],
    paid: ['green', 'Paid'],
    voided: ['red', 'Voided'],
    open: ['green', 'Open'],
    closed: ['gray', 'Closed'],
    available: ['green', 'Available'],
    occupied: ['amber', 'Occupied'],
    active: ['green', 'Active'],
  };
  const [cls, label] = map[status] || ['gray', status || '—'];
  return <span className={`badge ${cls}`}>{t(label)}</span>;
}
