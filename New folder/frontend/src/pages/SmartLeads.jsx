import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, getDocs } from "firebase/firestore"; // Added getDocs
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, LayoutGrid, Kanban, PhoneCall } from "lucide-react";
import { db } from "../firebase.js";
import Avatar from "../components/Avatar.jsx";
import ScoreRing from "../components/ScoreRing.jsx";
import PipelineBoard from "../components/PipelineBoard.jsx";
import { scoreLead, scoreTier, tierLabel } from "../lib/leadScore.js";
import { formatINR, formatRelativeTime, sortByRecency } from "../lib/format.js";

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
  return "Not captured";
}

function OpportunityCard({ lead, opportunity, onOpen }) {
  return (
    <div className="smart-lead-card opportunity-card" onClick={() => onOpen(lead.id, opportunity.id)}>
      <div className="smart-lead-top">
        <span className="opportunity-card-emoji">{opportunityEmoji(opportunity.propertyType)}</span>
        <div className="smart-lead-name-block">
          <div className="smart-lead-name">
            {opportunity.propertyType ? `${opportunity.propertyType} Search` : "Opportunity"}
          </div>
          <div className="smart-lead-phone">{opportunity.listingType || "Listing type not captured"}</div>
        </div>
      </div>

      <div className="smart-lead-req">
        <span>
          Status: <strong>{opportunity.status || "new"}</strong>
        </span>
        <span>
          Interest Level: <strong>{opportunity.interestLevel || "—"}</strong>
        </span>
        <span>
          Budget: <strong>{opportunity.budget != null ? formatINR(opportunity.budget) : "Not captured"}</strong>
        </span>
        <span>
          Location: <strong>{opportunityLocation(opportunity)}</strong>
        </span>
      </div>

      {opportunity.nextSuggestedAction && (
        <div className="smart-lead-next">
          <PhoneCall size={12} style={{ verticalAlign: -1, marginRight: 5 }} />
          {opportunity.nextSuggestedAction}
        </div>
      )}

      <div className="smart-lead-footer">
        <div className="empty-note">Updated {formatRelativeTime(opportunity.updatedAt)}</div>
        <button
          className="btn btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(lead.id, opportunity.id);
          }}
        >
          Open chat
        </button>
      </div>
    </div>
  );
}

function CustomerGroup({ lead, opportunities, onOpen }) {
  const score = scoreLead(lead);
  const tier = scoreTier(score);

  return (
    <section className="customer-group">
      <div className="customer-group-header">
        <Avatar name={lead.name} phone={lead.phone} size={40} />
        <div className="smart-lead-name-block">
          <div className="smart-lead-name">{lead.name || "Unnamed lead"}</div>
          <div className="smart-lead-phone">{lead.phone}</div>
        </div>
        <ScoreRing score={score} size={38} />
        <span className={`badge badge-${tier}`}>{tierLabel(tier)}</span>
      </div>

      {opportunities.length === 0 ? (
        <div className="customer-group-empty empty-note">No opportunities created yet.</div>
      ) : (
        <div className="opportunity-card-grid">
          {opportunities.map((opp) => (
            <OpportunityCard key={opp.id} lead={lead} opportunity={opp} onOpen={onOpen} />
          ))}
        </div>
      )}
    </section>
  );
}

export default function SmartLeads() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [view, setView] = useState(searchParams.get("view") === "pipeline" ? "pipeline" : "cards");
  const [opportunitiesByLead, setOpportunitiesByLead] = useState({});

  useEffect(() => {
    const q = query(collection(db, "leads"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rows = snapshot.docs.map((d)=>({id:d.id,...d.data()}));
        console.log("========== LEADS ==========",rows);
        rows.forEach(lead=>console.log({id:lead.id,phone:lead.phone,name:lead.name}));
        setLeads(rows);
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, []);

  const leadIdsKey = useMemo(() => leads.map((l) => l.id).join(","), [leads]);

  // Original Realtime Listener Commented Out for Debugging
  /*
  useEffect(() => {
    const ids = leadIdsKey ? leadIdsKey.split(",") : [];
    console.log("Creating opportunity listeners", ids);
    const unsubscribers = ids.map((id) => {
      console.log("Listening to", `leads/${id}/opportunities`);
      const q = query(collection(db, "leads", id, "opportunities"));
      return onSnapshot(
        q,
        (snapshot) => {
          console.log("Snapshot", id, snapshot.size);
          const rows = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
          console.log("Rows", rows);
          setOpportunitiesByLead((prev)=>{
            const next={...prev,[id]:sortByRecency(rows,"updatedAt")};
            console.log("Updated map",next);
            return next;
          });
        },
        () => setOpportunitiesByLead((prev) => ({ ...prev, [id]: [] }))
      );
    });
    return () => unsubscribers.forEach((unsub) => unsub());
  }, [leadIdsKey]);
  */

  // Debugging Hook: Manual Fetch Verification
  useEffect(() => {
    if (!leads.length) {
      setOpportunitiesByLead({});
      return;
    }

    async function loadOpportunities() {
      console.log("========== MANUAL FETCH ==========");
      const map = {};

      for (const lead of leads) {
        console.log(`Fetching opportunities for ${lead.id} (${lead.name})`);
        try {
          const snapshot = await getDocs(
            collection(db, "leads", lead.id, "opportunities")
          );
          console.log(`Found ${snapshot.size} opportunities for ${lead.id}`);
          const rows = snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
          console.table(rows);
          map[lead.id] = sortByRecency(rows, "updatedAt");
        } catch (err) {
          console.error(`Failed fetching opportunities for ${lead.id}`, err);
          map[lead.id] = [];
        }
      }

      console.log("========== FINAL MAP ==========");
      console.log(map);
      setOpportunitiesByLead(map);
    }

    loadOpportunities();
  }, [leads]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads
      .filter((lead) => !term || (lead.name || "").toLowerCase().includes(term) || (lead.phone || "").includes(term))
      .filter((lead) => tierFilter === "all" || scoreTier(scoreLead(lead)) === tierFilter)
      .sort((a, b) => scoreLead(b) - scoreLead(a));
  }, [leads, search, tierFilter]);

  const pipelineOpportunities = useMemo(() => {
    return filtered.flatMap((lead) =>
      (opportunitiesByLead[lead.id] || []).map((opp) => ({
        ...opp,
        customerId: lead.id,
        customerName: lead.name,
        customerPhone: lead.phone,
      }))
    );
  }, [filtered, opportunitiesByLead]);

  function openChat(leadId, opportunityId) {
    navigate(opportunityId ? `/chats?lead=${leadId}&opportunity=${opportunityId}` : `/chats?lead=${leadId}`);
  }

  // Debugging logs triggered right before rendering execution
  console.log("========== RENDER ==========");
  console.log(opportunitiesByLead);
  filtered.forEach((lead) => {
    console.log({
      leadId: lead.id,
      phone: lead.phone,
      opportunityCount: opportunitiesByLead[lead.id]?.length || 0,
      opportunities: opportunitiesByLead[lead.id],
    });
  });

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
        <div className="customer-groups">
          {filtered.map((lead) => (
            <CustomerGroup
              key={lead.id}
              lead={lead}
              opportunities={opportunitiesByLead[lead.id] || []}
              onOpen={openChat}
            />
          ))}
        </div>
      )}

      {!loading && view === "pipeline" && (
        <div style={{ height: "calc(100vh - 220px)" }}>
          <PipelineBoard opportunities={pipelineOpportunities} onSelectOpportunity={openChat} />
        </div>
      )}
    </div>
  );
}