const AVATAR_PALETTE = ["#0f6e5c", "#3b7bf6", "#d78c12", "#a855f7", "#e5484d", "#0891b2", "#65a30d", "#c2410c"];

export function initials(name, phone) {
  const source = (name || "").trim();
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return (phone || "?").replace(/\D/g, "").slice(-2) || "?";
}

export function avatarColor(seed) {
  const s = String(seed || "");
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i);
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts instanceof Date) return ts;
  if (typeof ts === "number") return new Date(ts);
  return new Date(ts);
}

export function formatRelativeTime(ts) {
  const date = toDate(ts);
  if (!date || Number.isNaN(date.getTime())) return "";
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d`;
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function formatDateTime(ts) {
  const date = toDate(ts);
  if (!date || Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatDayDivider(ts) {
  const date = toDate(ts);
  if (!date) return "";
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isToday) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

// Indian numbering (Lakh/Crore) currency formatting — matches how prices are
// actually discussed in this market ("80L", "1.2Cr").
export function formatINR(amount, { compact = true } = {}) {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  const n = Number(amount);
  if (!compact) return `₹${n.toLocaleString("en-IN")}`;
  if (n >= 1_00_00_000) return `₹${trim(n / 1_00_00_000)} Cr`;
  if (n >= 1_00_000) return `₹${trim(n / 1_00_000)} L`;
  if (n >= 1_000) return `₹${trim(n / 1_000)}K`;
  return `₹${n.toLocaleString("en-IN")}`;
}

function trim(n) {
  return Number(n.toFixed(2)).toString();
}
