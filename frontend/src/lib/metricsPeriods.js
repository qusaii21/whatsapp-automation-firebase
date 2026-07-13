// Mirrors functions/src/metrics.js's dayKey/monthKey exactly (same UTC-based
// math, same zero-padding) so the dashboard's Firestore doc IDs always line
// up with what the backend actually wrote. Kept as a pure, dependency-free
// module so there's exactly one place this logic could ever drift from the
// backend's — see that file's own PERIODIZED ROLLUPS comment for why the
// doc IDs are computed this way (UTC, not local time).

function pad2(n) {
  return String(n).padStart(2, "0");
}

export function dayKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

export function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

// Returns the last `n` day-keys, oldest first, ending at `from` (inclusive).
// Used to bound the "last 14 days" trend charts to a fixed, small doc set
// instead of ever scanning the metricsDaily collection.
export function lastNDayKeys(n = 14, from = new Date()) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - i));
    keys.push(dayKey(d));
  }
  return keys;
}

// Short "13 Jul" style label for a "YYYY-MM-DD" day-key, for chart x-axes.
export function dayKeyLabel(key) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}
