import { useEffect, useMemo, useState } from "react";
import { onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { useSearchParams } from "react-router-dom";
import { PanelRightOpen, PanelRightClose, ArrowLeft, Bot, UserRound } from "lucide-react";
import { leadsCollection, leadDoc, propertiesCollection, opportunitiesCollection } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import ConversationList, { needsReply } from "../components/ConversationList.jsx";
import ConversationThread from "../components/ConversationThread.jsx";
import CustomerPanel from "../components/CustomerPanel.jsx";
import MessageComposer from "../components/MessageComposer.jsx";
import Avatar from "../components/Avatar.jsx";
import ScoreRing from "../components/ScoreRing.jsx";
import { scoreLead, scoreTier } from "../lib/leadScore.js";
import { formatDateTime, sortByRecency } from "../lib/format.js";

// Human Agent Mode — leads created before this feature shipped (or never
// toggled) have no `mode` field at all. Treat that as "ai", the existing
// default behavior, so nothing regresses for conversations already in
// flight.
function isHumanMode(lead) {
  return lead?.mode === "human";
}

export default function ChatCRM() {
  const { agencyId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [properties, setProperties] = useState({});
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(searchParams.get("lead"));
  const [panelOpen, setPanelOpen] = useState(true);
  const [opportunities, setOpportunities] = useState([]);
  const [selectedOpportunityId, setSelectedOpportunityId] = useState(searchParams.get("opportunity"));

  function selectLead(id) {
    setSelectedId(id);
    setSelectedOpportunityId(null);
    setSearchParams(id ? { lead: id } : {});
  }

  useEffect(() => {
    if (!agencyId) {
      setLeads([]);
      setLoadingLeads(true);
      return undefined;
    }
    const q = query(leadsCollection(agencyId), orderBy("lastMessageAt", "desc"));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setLeads(rows);
        setLoadingLeads(false);
        setSelectedId((current) => current || rows[0]?.id || null);
      },
      () => setLoadingLeads(false)
    );
    return unsubscribe;
  }, [agencyId]);

  useEffect(() => {
    if (!agencyId) {
      setProperties({});
      return undefined;
    }
    const unsubscribe = onSnapshot(propertiesCollection(agencyId), (snapshot) => {
      const map = {};
      snapshot.docs.forEach((d) => (map[d.id] = { id: d.id, ...d.data() }));
      setProperties(map);
    });
    return unsubscribe;
  }, [agencyId]);

  // Opportunities belong to the customer (leads/{phone}/opportunities), not
  // to the conversation view — loading them here keeps the WhatsApp thread
  // above untouched while the CRM-only panel gets multi-opportunity data.
  useEffect(() => {
    if (!agencyId || !selectedId) {
      setOpportunities([]);
      return undefined;
    }
    const q = query(opportunitiesCollection(agencyId, selectedId));
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
        setOpportunities(sortByRecency(rows, "updatedAt"));
      },
      () => setOpportunities([])
    );
    return unsubscribe;
  }, [agencyId, selectedId]);

  const filteredLeads = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (term && !(lead.name || "").toLowerCase().includes(term) && !(lead.phone || "").includes(term)) {
        return false;
      }
      if (filter === "unread") return needsReply(lead);
      if (filter === "all") return true;
      return scoreTier(scoreLead(lead)) === filter;
    });
  }, [leads, search, filter]);

  const selectedLead = leads.find((l) => l.id === selectedId) || null;
  const matchedProperty = selectedLead?.lastMatchedPropertyId ? properties[selectedLead.lastMatchedPropertyId] : null;
  const humanMode = isHumanMode(selectedLead);

  const selectedOpportunity = useMemo(() => {
    if (!opportunities.length) return null;
    const explicit = selectedOpportunityId && opportunities.find((o) => o.id === selectedOpportunityId);
    if (explicit) return explicit;
    const active =
      selectedLead?.activeOpportunityId && opportunities.find((o) => o.id === selectedLead.activeOpportunityId);
    return active || opportunities[0];
  }, [opportunities, selectedOpportunityId, selectedLead]);

  function setMode(nextMode) {
    if (!selectedLead || !agencyId) return;
    updateDoc(leadDoc(agencyId, selectedLead.id), { mode: nextMode }).catch((err) =>
      console.error("Failed to update lead mode", err)
    );
  }

  return (
    <div className={"chat-page" + (selectedLead ? " conversation-open" : "")}>
      <ConversationList
        leads={filteredLeads}
        search={search}
        onSearch={setSearch}
        filter={filter}
        onFilter={setFilter}
        selectedId={selectedId}
        onSelect={selectLead}
        loading={loadingLeads}
      />

      <div className="chat-panel">
        {!selectedLead ? (
          <div className="empty-state" style={{ height: "100%", justifyContent: "center" }}>
            <div className="empty-state-title">Select a conversation</div>
            <div className="empty-note">Pick a lead on the left to see the full WhatsApp thread.</div>
          </div>
        ) : (
          <>
            <div className="chat-header">
              <button className="btn btn-icon btn-ghost" style={{ display: "none" }} onClick={() => selectLead(null)}>
                <ArrowLeft size={16} />
              </button>
              <Avatar name={selectedLead.name} phone={selectedLead.phone} size={38} />
              <div className="chat-header-info">
                <div className="chat-header-name">{selectedLead.name || "Unnamed lead"}</div>
                <div className="chat-header-meta">
                  {selectedLead.phone} · Last active {formatDateTime(selectedLead.lastMessageAt)}
                </div>
              </div>
              <div className="chat-header-actions">
                <div className="mode-toggle" role="group" aria-label="AI or human reply mode">
                  <button
                    className={"mode-toggle-btn" + (!humanMode ? " active-ai" : "")}
                    onClick={() => setMode("ai")}
                    title="AI replies automatically"
                  >
                    <Bot size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    AI
                  </button>
                  <button
                    className={"mode-toggle-btn" + (humanMode ? " active-human" : "")}
                    onClick={() => setMode("human")}
                    title="AI stops replying — you're in control"
                  >
                    <UserRound size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    Human
                  </button>
                </div>
                <ScoreRing score={scoreLead(selectedLead)} size={32} strokeWidth={3} showValue={false} />
                <button className="btn btn-icon btn-ghost" onClick={() => setPanelOpen((v) => !v)} title="Toggle details">
                  {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                </button>
              </div>
            </div>

            <div className="chat-scroll">
              <ConversationThread history={selectedLead.conversationHistory} propertiesById={properties} />
            </div>

            <MessageComposer phone={selectedLead.phone} />
          </>
        )}
      </div>

      {selectedLead && panelOpen && (
        <CustomerPanel
          lead={selectedLead}
          matchedProperty={matchedProperty}
          opportunities={opportunities}
          selectedOpportunity={selectedOpportunity}
          onSelectOpportunity={setSelectedOpportunityId}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
  );
}
