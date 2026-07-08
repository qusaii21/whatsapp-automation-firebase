import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { useSearchParams } from "react-router-dom";
import { PanelRightOpen, PanelRightClose, ArrowLeft } from "lucide-react";
import { db } from "../firebase.js";
import ConversationList, { needsReply } from "../components/ConversationList.jsx";
import ConversationThread from "../components/ConversationThread.jsx";
import CustomerPanel from "../components/CustomerPanel.jsx";
import Avatar from "../components/Avatar.jsx";
import ScoreRing from "../components/ScoreRing.jsx";
import { scoreLead, scoreTier } from "../lib/leadScore.js";
import { formatDateTime } from "../lib/format.js";

export default function ChatCRM() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [leads, setLeads] = useState([]);
  const [properties, setProperties] = useState({});
  const [loadingLeads, setLoadingLeads] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selectedId, setSelectedId] = useState(searchParams.get("lead"));
  const [panelOpen, setPanelOpen] = useState(true);

  function selectLead(id) {
    setSelectedId(id);
    setSearchParams(id ? { lead: id } : {});
  }

  useEffect(() => {
    const q = query(collection(db, "leads"), orderBy("lastMessageAt", "desc"));
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
  }, []);

  useEffect(() => {
    const unsubscribe = onSnapshot(collection(db, "properties"), (snapshot) => {
      const map = {};
      snapshot.docs.forEach((d) => (map[d.id] = { id: d.id, ...d.data() }));
      setProperties(map);
    });
    return unsubscribe;
  }, []);

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
                <ScoreRing score={scoreLead(selectedLead)} size={32} strokeWidth={3} showValue={false} />
                <button className="btn btn-icon btn-ghost" onClick={() => setPanelOpen((v) => !v)} title="Toggle details">
                  {panelOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
                </button>
              </div>
            </div>

            <div className="chat-scroll">
              <ConversationThread history={selectedLead.conversationHistory} propertiesById={properties} />
            </div>
          </>
        )}
      </div>

      {selectedLead && panelOpen && (
        <CustomerPanel lead={selectedLead} matchedProperty={matchedProperty} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}
