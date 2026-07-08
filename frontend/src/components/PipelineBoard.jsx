import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase.js";
import { LEAD_STAGES } from "../constants/propertyEnums.js";
import { deriveStage } from "../lib/pipeline.js";
import Avatar from "./Avatar.jsx";
import ScoreRing from "./ScoreRing.jsx";
import { scoreLead } from "../lib/leadScore.js";
import { formatINR } from "../lib/format.js";

export default function PipelineBoard({ leads, onSelectLead }) {
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverStage, setDragOverStage] = useState(null);

  const byStage = {};
  for (const stage of LEAD_STAGES) byStage[stage.key] = [];
  for (const lead of leads) {
    const stage = deriveStage(lead);
    (byStage[stage] || (byStage[stage] = [])).push(lead);
  }

  function handleDrop(stageKey) {
    setDragOverStage(null);
    if (!draggingId) return;
    updateDoc(doc(db, "leads", draggingId), { pipelineStage: stageKey }).catch((err) =>
      console.error("Failed to move lead", err)
    );
    setDraggingId(null);
  }

  return (
    <div className="pipeline-board">
      {LEAD_STAGES.map((stage) => (
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
            {(byStage[stage.key] || []).map((lead) => {
              const score = scoreLead(lead);
              return (
                <div
                  key={lead.id}
                  className={"kanban-card" + (draggingId === lead.id ? " dragging" : "")}
                  draggable
                  onDragStart={() => setDraggingId(lead.id)}
                  onDragEnd={() => setDraggingId(null)}
                  onClick={() => onSelectLead?.(lead.id)}
                >
                  <div className="kanban-card-top">
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <Avatar name={lead.name} phone={lead.phone} size={26} />
                      <span className="kanban-card-name">{lead.name || lead.phone}</span>
                    </div>
                    <ScoreRing score={score} size={24} strokeWidth={2.5} showValue={false} />
                  </div>
                  <div className="kanban-card-req">
                    {lead.extractedBedrooms != null ? `${lead.extractedBedrooms} BHK` : "BHK —"}
                    {lead.extractedBudget != null ? ` · ${formatINR(lead.extractedBudget)}` : ""}
                    {lead.preferredLocation ? ` · ${lead.preferredLocation}` : ""}
                  </div>
                </div>
              );
            })}
            {(byStage[stage.key] || []).length === 0 && <p className="empty-note" style={{ padding: "8px 2px" }}>No leads</p>}
          </div>
        </div>
      ))}
    </div>
  );
}
