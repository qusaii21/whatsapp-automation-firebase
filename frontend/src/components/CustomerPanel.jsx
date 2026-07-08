import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { X, Phone, ExternalLink } from "lucide-react";
import { db } from "../firebase.js";
import Avatar from "./Avatar.jsx";
import ScoreRing from "./ScoreRing.jsx";
import { scoreLead, scoreTier, tierLabel } from "../lib/leadScore.js";
import { formatDateTime, formatINR } from "../lib/format.js";
import { PROPERTY_TYPES } from "../constants/propertyEnums.js";

const STATUS_OPTIONS = ["pending", "replied", "followed_up", "visit_requested", "qualified"];
const PURPOSE_OPTIONS = ["Own use", "Investment", "Rental income"];

function EditableField({ label, value, onSave, type = "text", options = null, placeholder = "—" }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  function commit() {
    setEditing(false);
    const next = type === "number" ? (draft === "" ? null : Number(draft)) : draft || null;
    if (next !== (value ?? null)) onSave(next);
  }

  return (
    <div className="panel-field">
      <div className="panel-field-label">{label}</div>
      {editing ? (
        options ? (
          <select
            className="select"
            autoFocus
            value={draft ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          >
            <option value="">{placeholder}</option>
            {options.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="input"
            autoFocus
            type={type}
            value={draft ?? ""}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && commit()}
          />
        )
      ) : (
        <div className="panel-field-value" onClick={() => setEditing(true)}>
          {value === null || value === undefined || value === "" ? (
            <span className="empty-note">{placeholder}</span>
          ) : (
            String(value)
          )}
        </div>
      )}
    </div>
  );
}

function ToggleField({ label, checked, onChange }) {
  return (
    <div className="panel-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  );
}

export default function CustomerPanel({ lead, matchedProperty, onClose }) {
  if (!lead) return null;

  const score = scoreLead(lead);
  const tier = scoreTier(score);

  function save(field, value) {
    updateDoc(doc(db, "leads", lead.id), { [field]: value }).catch((err) =>
      console.error("Failed to update lead field", field, err)
    );
  }

  return (
    <aside className="customer-panel">
      <div className="customer-panel-header" style={{ position: "relative" }}>
        <button className="btn btn-icon btn-ghost" style={{ position: "absolute", top: 8, right: 8 }} onClick={onClose}>
          <X size={16} />
        </button>
        <Avatar name={lead.name} phone={lead.phone} size={64} />
        <div className="customer-panel-name">{lead.name || "Unnamed lead"}</div>
        <div className="customer-panel-phone">
          <Phone size={11} style={{ verticalAlign: -1, marginRight: 3 }} />
          {lead.phone}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 10, alignItems: "center" }}>
          <ScoreRing score={score} size={44} />
          <span className={`badge badge-${tier}`}>{tierLabel(tier)} lead</span>
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Lead details</div>
        <div className="panel-two-col">
          <EditableField label="Source" value={lead.source ?? "WhatsApp"} onSave={(v) => save("source", v)} />
          <EditableField
            label="Status"
            value={lead.status}
            options={STATUS_OPTIONS}
            onSave={(v) => save("status", v)}
          />
          <EditableField label="Assigned agent" value={lead.assignedAgent} onSave={(v) => save("assignedAgent", v)} />
          <EditableField
            label="Follow-up date"
            type="date"
            value={lead.followUpDate}
            onSave={(v) => save("followUpDate", v)}
          />
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Requirement</div>
        <div className="panel-two-col">
          <EditableField
            label="Budget"
            type="number"
            value={lead.extractedBudget}
            onSave={(v) => save("extractedBudget", v)}
            placeholder="Not captured yet"
          />
          <EditableField
            label="Bedrooms"
            type="number"
            value={lead.extractedBedrooms}
            onSave={(v) => save("extractedBedrooms", v)}
            placeholder="Not captured yet"
          />
          <EditableField
            label="Property type"
            value={lead.propertyType}
            options={PROPERTY_TYPES}
            onSave={(v) => save("propertyType", v)}
          />
          <EditableField label="Bathrooms" type="number" value={lead.bathrooms} onSave={(v) => save("bathrooms", v)} />
          <EditableField
            label="Preferred location"
            value={lead.preferredLocation}
            onSave={(v) => save("preferredLocation", v)}
          />
          <EditableField
            label="Purpose"
            value={lead.purpose}
            options={PURPOSE_OPTIONS}
            onSave={(v) => save("purpose", v)}
          />
          <EditableField label="Timeline" value={lead.timeline} onSave={(v) => save("timeline", v)} />
          <EditableField label="Parking needed" value={lead.parkingNeeded} onSave={(v) => save("parkingNeeded", v)} />
        </div>
      </div>

      <div className="panel-section">
        <div className="panel-section-title">Visit</div>
        <ToggleField
          label="Visit scheduled"
          checked={lead.visitRequested}
          onChange={(v) => save("visitRequested", v)}
        />
        <EditableField label="Visit date" type="date" value={lead.visitDate} onSave={(v) => save("visitDate", v)} />
      </div>

      <div className="panel-section">
        <div className="panel-section-title">AI context</div>
        <ToggleField
          label="AI replies automatically"
          checked={lead.mode !== "human"}
          onChange={(checked) => save("mode", checked ? "ai" : "human")}
        />
        <div className="panel-field">
          <div className="panel-field-label">Current intent</div>
          <div className="panel-field-value" style={{ cursor: "default" }}>
            {lead.lastIntent || <span className="empty-note">—</span>}
          </div>
        </div>
        <div className="panel-field">
          <div className="panel-field-label">Last property shown</div>
          <div className="panel-field-value" style={{ cursor: "default" }}>
            {matchedProperty ? (
              <>
                {matchedProperty.projectName} — {formatINR(matchedProperty.price)}
                {matchedProperty.locality ? `, ${matchedProperty.locality}` : ""}
              </>
            ) : (
              <span className="empty-note">None yet</span>
            )}
          </div>
        </div>
        <div className="panel-field">
          <div className="panel-field-label">Last activity</div>
          <div className="panel-field-value" style={{ cursor: "default" }}>
            {formatDateTime(lead.lastMessageAt)}
          </div>
        </div>
      </div>

      <div className="panel-section" style={{ border: "none" }}>
        <div className="panel-section-title">Notes</div>
        <textarea
          className="textarea"
          rows={4}
          defaultValue={lead.notes || ""}
          placeholder="Internal notes about this lead..."
          onBlur={(e) => save("notes", e.target.value || null)}
        />
      </div>
    </aside>
  );
}
