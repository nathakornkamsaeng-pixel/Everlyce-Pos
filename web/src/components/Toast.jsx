import React, { createContext, useContext, useState, useCallback } from 'react';

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const notify = useCallback((msg, kind = 'info') => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2800);
  }, []);
  return (
    <ToastCtx.Provider value={notify}>
      {children}
      {toast && <div className={`toast ${toast.kind === 'error' ? 'error' : toast.kind === 'ok' ? 'ok' : ''}`}>{toast.msg}</div>}
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);