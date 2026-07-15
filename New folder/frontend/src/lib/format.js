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

// Sorts newest-first by a timestamp field, WITHOUT relying on a Firestore
// `orderBy` clause. Firestore's orderBy silently drops any document that is
// missing the ordered field entirely — fine for well-formed data, but it
// means a doc created before a field existed, or added by hand while
// testing, would just vanish from query results with no error. Sorting
// client-side after an unordered fetch means every document is always
// shown; ones missing the field just sort to the bottom instead of
// disappearing.
export function sortByRecency(items, field = "updatedAt") {
  return [...items].sort((a, b) => {
    const aTime = toDate(a?.[field])?.getTime() ?? 0;
    const bTime = toDate(b?.[field])?.getTime() ?? 0;
    return bTime - aTime;
  });
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

// Estimated USD costs (AI/WhatsApp spend) are small, fractional numbers
// (fractions of a cent per message) that still need to read as real money,
// not round to $0. Below $1 shows 4 decimal places so early-stage usage
// isn't invisible; $1+ shows the usual 2.
export function formatUSD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  const n = Number(amount);
  const decimals = Math.abs(n) < 1 ? 4 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

// Whole-number formatting for counters (messages, tokens, credits) — always
// comma-grouped, no decimals, "—" for missing data so a genuinely-untracked
// number never renders as a misleading 0.
export function formatCount(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return "—";
  return Math.round(Number(amount)).toLocaleString("en-US");
}
