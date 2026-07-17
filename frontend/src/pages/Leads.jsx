import { useEffect, useMemo, useState } from "react";
import { onSnapshot, orderBy, query } from "firebase/firestore";
import { leadsCollection } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import ConversationThread from "../components/ConversationThread.jsx";

const STATUS_COLUMNS = [
  { key: "pending", label: "Pending" },
  { key: "replied", label: "Replied" },
  { key: "followed_up", label: "Followed Up" },
  { key: "qualified", label: "Qualified" },
];

export default function Leads() {
  const { agencyId } = useAuth();
  const [leads, setLeads] = useState([]);
  const [search, setSearch] = useState("");
  const [expandedPhone, setExpandedPhone] = useState(null);

  useEffect(() => {
    if (!agencyId) {
      setLeads([]);
      return undefined;
    }
    const q = query(leadsCollection(agencyId), orderBy("createdAt", "desc"));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setLeads(rows);
    });
    return unsubscribe;
  }, [agencyId]);

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return leads;
    return leads.filter(
      (lead) =>
        (lead.name || "").toLowerCase().includes(term) ||
        (lead.phone || "").toLowerCase().includes(term)
    );
  }, [leads, search]);

  const leadsByStatus = useMemo(() => {
    const grouped = { pending: [], replied: [], followed_up: [], qualified: [] };
    for (const lead of filteredLeads) {
      const bucket = grouped[lead.status] ? lead.status : "pending";
      grouped[bucket].push(lead);
    }
    return grouped;
  }, [filteredLeads]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Leads</h1>
        <input
          className="search-input"
          type="text"
          placeholder="Search by name or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="pipeline">
        {STATUS_COLUMNS.map((col) => (
          <div key={col.key} className="pipeline-column">
            <h2 className="pipeline-column-title">
              {col.label} ({leadsByStatus[col.key].length})
            </h2>

            {leadsByStatus[col.key].length === 0 && (
              <p className="empty-note">No leads here.</p>
            )}

            {leadsByStatus[col.key].map((lead) => {
              const isExpanded = expandedPhone === lead.id;
              return (
                <div key={lead.id} className="lead-card">
                  <button
                    className="lead-card-header"
                    onClick={() => setExpandedPhone(isExpanded ? null : lead.id)}
                  >
                    <div className="lead-name">{lead.name || "Unnamed lead"}</div>
                    <div className="lead-phone">{lead.phone}</div>
                    <div className="lead-badges">
                      {lead.extractedBedrooms != null && (
                        <span className="badge">{lead.extractedBedrooms} BHK</span>
                      )}
                      {lead.extractedBudget != null && (
                        <span className="badge">Budget {lead.extractedBudget}</span>
                      )}
                      {lead.propertyFound && (
                        <span className="badge badge-success">Property shown</span>
                      )}
                      {lead.conversationEnded && (
                        <span className="badge badge-muted">Conversation ended</span>
                      )}
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="lead-card-body">
                      <ConversationThread history={lead.conversationHistory} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
