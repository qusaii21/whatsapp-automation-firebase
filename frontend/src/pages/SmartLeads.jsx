import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { useNavigate } from "react-router-dom";
import { Search, LayoutGrid, Kanban, PhoneCall, Home } from "lucide-react";
import { db } from "../firebase.js";
import Avatar from "../components/Avatar.jsx";
import ScoreRing from "../components/ScoreRing.jsx";
import PipelineBoard from "../components/PipelineBoard.jsx";
import { scoreLead, scoreTier, tierLabel } from "../lib/leadScore.js";
import { formatINR, formatRelativeTime } from "../lib/format.js";

function SmartLeadCard({ lead, onOpen }) {
  const score = scoreLead(lead);
  const tier = scoreTier(score);

  return (
    <div className="smart-lead-card">
      <div className="smart-lead-top">
        <Avatar name={lead.name} phone={lead.phone} size={40} />
        <div className="smart-lead-name-block">
          <div className="smart-lead-name">{lead.name || "Unnamed lead"}</div>
          <div className="smart-lead-phone">{lead.phone}</div>
        </div>
        <ScoreRing score={score} size={38} />
      </div>

      <div className="smart-lead-req">
        <span>
          Searching for: <strong>{lead.extractedBedrooms != null ? `${lead.extractedBedrooms} BHK` : "—"}</strong>
          {lead.propertyType ? ` ${lead.propertyType}` : ""}
        </span>
        <span>
          Budget: <strong>{lead.extractedBudget != null ? formatINR(lead.extractedBudget) : "Not captured"}</strong>
        </span>
        <span>
          Location: <strong>{lead.preferredLocation || "Not captured"}</strong>
        </span>
      </div>

      {lead.conversationSummary && <p className="smart-lead-summary">{lead.conversationSummary}</p>}

      {lead.nextSuggestedAction && (
        <div className="smart-lead-next">
          <PhoneCall size={12} style={{ verticalAlign: -1, marginRight: 5 }} />
          {lead.nextSuggestedAction}
        </div>
      )}

      <div className="smart-lead-footer">
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <span className={`badge badge-${tier}`}>{tierLabel(tier)}</span>
          {lead.interestLevel && <span className="badge badge-info">{lead.interestLevel} interest</span>}
          {lead.visitRequested && (
            <span className="badge badge-success">
              <Home size={11} /> Visit requested
            </span>
          )}
          {lead.financingRequired && <span className="badge badge-muted">Needs financing</span>}
        </div>
        <button className="btn btn-sm" onClick={() => onOpen(lead.id)}>
          Open chat
        </button>
      </div>

      <div className="empty-note">Updated {formatRelativeTime(lead.lastMessageAt)}</div>
    </div>
  );
}

export default function SmartLeads() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [view, setView] = useState("cards");

  useEffect(() => {
    const q = query(collection(db, "leads"), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setLeads(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads
      .filter((lead) => !term || (lead.name || "").toLowerCase().includes(term) || (lead.phone || "").includes(term))
      .filter((lead) => tierFilter === "all" || scoreTier(scoreLead(lead)) === tierFilter)
      .sort((a, b) => scoreLead(b) - scoreLead(a));
  }, [leads, search, tierFilter]);

  function openChat(id) {
    navigate(`/?lead=${id}`);
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Smart Leads</h1>
          <div className="page-subtitle">AI-extracted requirements, scored and ranked — not just raw Firestore rows.</div>
        </div>
      </div>

      <div className="leads-toolbar">
        <div className="conv-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search by name or phone..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {["all", "hot", "warm", "cold"].map((t) => (
            <button
              key={t}
              className={"chip" + (tierFilter === t ? " chip-active" : "")}
              onClick={() => setTierFilter(t)}
            >
              {t === "all" ? "All" : tierLabel(t)}
            </button>
          ))}
        </div>
        <div className="view-toggle" style={{ marginLeft: "auto" }}>
          <button className={view === "cards" ? "active" : ""} onClick={() => setView("cards")}>
            <LayoutGrid size={14} /> Cards
          </button>
          <button className={view === "pipeline" ? "active" : ""} onClick={() => setView("pipeline")}>
            <Kanban size={14} /> Pipeline
          </button>
        </div>
      </div>

      {loading && (
        <div className="leads-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="smart-lead-card">
              <div className="skeleton skeleton-line" style={{ width: "50%" }} />
              <div className="skeleton skeleton-line" style={{ width: "80%" }} />
              <div className="skeleton skeleton-line" style={{ width: "65%" }} />
            </div>
          ))}
        </div>
      )}

      {!loading && view === "cards" && filtered.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-title">No leads match this filter</div>
        </div>
      )}

      {!loading && view === "cards" && filtered.length > 0 && (
        <div className="leads-grid">
          {filtered.map((lead) => (
            <SmartLeadCard key={lead.id} lead={lead} onOpen={openChat} />
          ))}
        </div>
      )}

      {!loading && view === "pipeline" && (
        <div style={{ height: "calc(100vh - 220px)" }}>
          <PipelineBoard leads={filtered} onSelectLead={openChat} />
        </div>
      )}
    </div>
  );
}
