// Derives a 0-100 lead score from the fields the agent already writes onto
// each lead doc (extractedBudget, extractedBedrooms, preferredLocation,
// timeline, purpose, propertyFound, visitRequested, conversationEnded).
//
// This is a transparent, deterministic heuristic — not a model call — so it
// updates instantly in the UI with zero extra cost or latency. If/when a
// dedicated AI scoring pass is added server-side (writing a `leadScore`
// field directly onto the lead doc), prefer that value and fall back to this
// heuristic only when it's absent, which is exactly what scoreLead() does.
export function scoreLead(lead) {
  if (typeof lead.leadScore === "number") {
    return clamp(lead.leadScore);
  }

  let score = 20; // baseline: exists as a lead at all

  if (lead.name) score += 5;
  if (lead.extractedBedrooms != null) score += 12;
  if (lead.extractedBudget != null) score += 12;
  if (lead.preferredLocation) score += 10;
  if (lead.timeline) score += 8;
  if (lead.purpose) score += 6;
  if (lead.propertyFound) score += 12;
  if (lead.visitRequested) score += 15;
  if (lead.status === "qualified") score += 10;

  const historyLen = Array.isArray(lead.conversationHistory) ? lead.conversationHistory.length : 0;
  score += Math.min(historyLen, 10); // up to +10 for engagement depth

  if (lead.conversationEnded && !lead.propertyFound && !lead.visitRequested) score -= 15;

  return clamp(score);
}

export function scoreTier(score) {
  if (score >= 75) return "hot";
  if (score >= 45) return "warm";
  return "cold";
}

export function tierLabel(tier) {
  return { hot: "Hot", warm: "Warm", cold: "Cold" }[tier] || "Cold";
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}
