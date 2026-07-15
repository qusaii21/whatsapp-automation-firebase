// Keep in sync with functions/src/config.js's LLM_PRICING_USD_PER_TOKEN keys.
// Display-only — no pricing math happens here.
const KNOWN_MODELS = ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];

const KEY_TO_MODEL = Object.fromEntries(KNOWN_MODELS.map((m) => [m.replace(/\./g, "_"), m]));

// `llm.byModel` field names have "." replaced with "_" (Firestore field
// names can't contain "."; see metrics.js's recordLlmUsage). Reverses that
// for any known model; falls back to a best-effort underscore->dot swap for
// an unrecognized model string rather than showing a raw Firestore-safe key.
export function displayModelName(safeModelKey) {
  if (!safeModelKey) return "—";
  return KEY_TO_MODEL[safeModelKey] || safeModelKey.replace(/_/g, ".");
}

// Given the `llm.byModel` map ({ [safeModelKey]: { input, output, total } }),
// returns the model with the highest total token count, or null if empty.
export function mostUsedModel(byModel) {
  if (!byModel || typeof byModel !== "object") return null;
  const entries = Object.entries(byModel);
  if (entries.length === 0) return null;
  const [key] = entries.reduce((best, entry) => (entry[1]?.total > best[1]?.total ? entry : best));
  return displayModelName(key);
}
