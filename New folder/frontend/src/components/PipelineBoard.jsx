import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { OPPORTUNITY_STAGES } from "../constants/propertyEnums.js";
import { deriveOpportunityStage } from "../lib/pipeline.js";
import Avatar from "./Avatar.jsx";
import { formatINR, formatRelativeTime } from "../lib/format.js";

// Small emoji per property type, same convention already used on the Smart
// Leads opportunity cards, so a card is scannable at a glance.
function opportunityEmoji(propertyType) {
  const t = (propertyType || "").toLowerCase();
  if (t.includes("office") || t.includes("commercial") || t.includes("shop")) return "🏢";
  if (t.includes("villa") || t.includes("row house")) return "🏡";
  if (t.includes("plot")) return "📍";
  if (t.includes("studio")) return "🏙️";
  return "🏠";
}

function opportunityLocation(opportunity) {
  const locations = opportunity.preferredLocations;
  if (Array.isArray(locations) && locations.length) return locations.join(", ");
  if (typeof locations === "string" && locations) return locations;
  return null;
}

const STATUS_BADGE_CLASS = {
  qualified: "badge-info",
  visit_requested: "badge-success",
  active: "badge-warm",
};

/**
 * Kanban board over OPPORTUNITIES (one card per opportunity), not customers.
 * Expects `opportunities` to already be a flat array where each item is an
 * opportunity doc enriched with `customerId`, `customerName`, `customerPhone`
 * (done by the caller from data it already holds — see SmartLeads.jsx —
 * so this component adds no new Firestore listeners of its own).
 */
export default function PipelineBoard({ opportunities, onSelectOpportunity }) {
  const [draggingCard, setDraggingCard] = useState(null); // { customerId, opportunityId }
  const [dragOverStage, setDragOverStage] = useState(null);

  const byStage = {};
  for (const stage of OPPORTUNITY_STAGES) byStage[stage.key] = [];
  for (const opp of opportunities) {
    const stage = deriveOpportunityStage(opp);
    (byStage[stage] || (byStage[stage] = [])).push(opp);
  }

  function handleDrop(stageKey) {
    setDragOverStage(null);
    if (!draggingCard) return;
    // Only this one opportunity doc is touched — the customer (lead) doc,
    // its conversation, and every other opportunity are untouched.
    updateDoc(doc(db, "leads", draggingCard.customerId, "opportunities", draggingCard.opportunityId), {
      pipelineStage: stageKey,
    }).catch((err) => console.error("Failed to move opportunity", err));
    setDraggingCard(null);
  }

  return (
    <div className="pipeline-board">
      {OPPORTUNITY_STAGES.map((stage) => (
        <div
          key={stage.key}
          className={"pipeline-col" + (dragOverStage === stage.key ? " drag-over" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverStage(stage.key);
          }}
          onDragLeave={() => setDragOverStage((s) => (s === stage.key ? null : s))}
          onDrop={() => handleDrop(stage.key)}
        >
          <div className="pipeline-col-header">
            <span>{stage.label}</span>
            <span className="pipeline-col-count">{(byStage[stage.key] || []).length}</span>
          </div>
          <div className="pipeline-col-body">
            {(byStage[stage.key] || []).map((opp) => {
              const isDragging =
                draggingCard?.customerId === opp.customerId && draggingCard?.opportunityId === opp.id;
              const location = opportunityLocation(opp);
              return (
                <div
                  key={`${opp.customerId}:${opp.id}`}
                  className={"kanban-card" + (isDragging ? " dragging" : "")}
                  draggable
                  onDragStart={() => setDraggingCard({ customerId: opp.customerId, opportunityId: opp.id })}
                  onDragEnd={() => setDraggingCard(null)}
                  onClick={() => onSelectOpportunity?.(opp.customerId, opp.id)}
                >
                  <div className="kanban-card-top">
                    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <Avatar name={opp.customerName} phone={opp.customerPhone} size={26} />
                      <span className="kanban-card-name">{opp.customerName || "Unnamed lead"}</span>
                    </div>
                    <span className="kanban-card-emoji" title={opp.propertyType || "Opportunity"}>
                      {opportunityEmoji(opp.propertyType)}
                    </span>
                  </div>
                  <div className="kanban-card-phone">{opp.customerPhone}</div>
                  <div className="kanban-card-req">
                    {opp.propertyType || "Property type —"}
                    {opp.listingType ? ` · ${opp.listingType}` : ""}
                    {opp.budget != null ? ` · ${formatINR(opp.budget)}` : ""}
                    {location ? ` · ${location}` : ""}
                  </div>
                  <div className="kanban-card-footer">
                    <span className={`badge ${STATUS_BADGE_CLASS[opp.status] || "badge-muted"}`}>
                      {opp.status || "new"}
                    </span>
                    {opp.interestLevel && <span className="badge badge-info">{opp.interestLevel}</span>}
                  </div>
                  <div className="empty-note kanban-card-updated">Updated {formatRelativeTime(opp.updatedAt)}</div>
                </div>
              );
            })}
            {(byStage[stage.key] || []).length === 0 && (
              <p className="empty-note" style={{ padding: "8px 2px" }}>
                No opportunities
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
