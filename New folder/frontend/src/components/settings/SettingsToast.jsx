/**
 * Same visual pattern as Templates.jsx's inline Toast (reuses the
 * `.recipients-toast*` classes already in index.css — the naming there is
 * historical, the styles are generic) so success/error toasts look
 * identical across the CRM.
 */
export default function SettingsToast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className={`recipients-toast recipients-toast-${toast.type}`} role="status">
      <span>{toast.message}</span>
      <button type="button" className="recipients-toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
