// The backend (agent.js / processPhoneQueue.js) only ever writes `status`
// (pending/replied/followed_up/qualified) and `visitRequested`/
// `conversationEnded` — it has no concept of the richer Kanban stages this
// CRM view wants (Property Shared, Negotiation, Closed Won/Lost). Rather
// than teach the backend about CRM-only stages, this derives a sensible
// default stage from what the backend already tracks, and lets a human
// override it by dragging a card — which is persisted on a new CRM-owned
// `pipelineStage` field that the backend never touches or overwrites.
export function deriveStage(lead) {
  if (lead.pipelineStage) return lead.pipelineStage;
  if (lead.status === "closed_won") return "closed_won";
  if (lead.status === "closed_lost") return "closed_lost";
  if (lead.visitRequested) return "visit_scheduled";
  if (lead.propertyFound) return "property_shared";
  if (lead.status === "qualified") return "qualified";
  if (lead.status === "replied" || lead.status === "followed_up") return "contacted";
  return "new";
}

// Same idea as deriveStage above, but for a single OPPORTUNITY doc
// (leads/{phone}/opportunities/{id}) rather than the customer-level lead
// doc. The backend (processPhoneQueue.js) only ever writes
// opportunity.status as "new" / "active" / "visit_requested" / "qualified" —
// it has no concept of Negotiation/Won/Lost. Those, and any manual
// correction of the backend's default, are captured by a human dragging a
// card, persisted on a CRM-owned `pipelineStage` field the backend never
// reads or overwrites (mirrors the lead.pipelineStage pattern above).
export function deriveOpportunityStage(opportunity) {
  if (opportunity.pipelineStage) return opportunity.pipelineStage;
  if (opportunity.status === "qualified") return "qualified";
  if (opportunity.status === "visit_requested") return "visit_scheduled";
  return "new";
}
