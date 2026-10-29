import { useEffect } from 'react';
import { useGame } from '../../game/store';

export function ToastHost() {
  const toast = useGame((s) => s.toast);
  const clearToast = useGame((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => clearToast(), 4200);
    return () => clearTimeout(timer);
  }, [toast, clearToast]);

  if (!toast) return null;

  return (
    <div className="toast-host">
      <div className="toast" data-tone={toast.tone} key={toast.id}>
        {toast.message}
      </div>
    </div>
  );
}
