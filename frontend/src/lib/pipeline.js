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
