import { Loader2 } from "lucide-react";

/**
 * Absolutely-positioned overlay meant to sit inside a `.loading-overlay-anchor`
 * (any `position: relative` container, typically a `.card`). Renders nothing
 * when `active` is false so call sites can leave it mounted unconditionally.
 */
export default function LoadingOverlay({ active, label = "Working…" }) {
  if (!active) return null;
  return (
    <div className="loading-overlay" role="status" aria-live="polite">
      <Loader2 size={20} className="spin" />
      <span>{label}</span>
    </div>
  );
}
