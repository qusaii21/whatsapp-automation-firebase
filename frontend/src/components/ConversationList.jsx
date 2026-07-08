import { Search } from "lucide-react";
import Avatar from "./Avatar.jsx";
import ScoreRing from "./ScoreRing.jsx";
import { scoreLead, scoreTier } from "../lib/leadScore.js";
import { formatRelativeTime, formatINR } from "../lib/format.js";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "hot", label: "Hot" },
  { key: "warm", label: "Warm" },
  { key: "cold", label: "Cold" },
  { key: "unread", label: "Needs reply" },
];

function lastMessagePreview(lead) {
  const history = lead.conversationHistory || [];
  const last = history[history.length - 1];
  if (!last) return "No messages yet";
  const prefix = last.role === "user" ? "" : "You: ";
  return prefix + last.text;
}

function needsReply(lead) {
  const history = lead.conversationHistory || [];
  const last = history[history.length - 1];
  return last?.role === "user";
}

export default function ConversationList({ leads, search, onSearch, filter, onFilter, selectedId, onSelect, loading }) {
  return (
    <div className="conv-list">
      <div className="conv-list-header">
        <h1 className="conv-list-title">Chats</h1>
        <div className="conv-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search name or phone..."
            value={search}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
        <div className="conv-filter-chips">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={"chip" + (filter === f.key ? " chip-active" : "")}
              onClick={() => onFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="conv-list-scroll">
        {loading &&
          Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ display: "flex", gap: 11, padding: "11px 16px" }}>
              <div className="skeleton skeleton-circle" style={{ width: 40, height: 40 }} />
              <div style={{ flex: 1 }}>
                <div className="skeleton skeleton-line" style={{ width: "60%" }} />
                <div className="skeleton skeleton-line" style={{ width: "85%" }} />
              </div>
            </div>
          ))}

        {!loading && leads.length === 0 && (
          <div className="empty-state">
            <div className="empty-state-title">No conversations</div>
            <div className="empty-note">Leads will show up here as soon as they message in on WhatsApp.</div>
          </div>
        )}

        {!loading &&
          leads.map((lead) => {
            const score = scoreLead(lead);
            const tier = scoreTier(score);
            return (
              <button
                key={lead.id}
                className={"conv-item" + (selectedId === lead.id ? " active" : "")}
                onClick={() => onSelect(lead.id)}
              >
                <Avatar name={lead.name} phone={lead.phone} size={42} />
                <div className="conv-item-body">
                  <div className="conv-item-top">
                    <span className="conv-item-name">{lead.name || lead.phone}</span>
                    <span className="conv-item-time">{formatRelativeTime(lead.lastMessageAt)}</span>
                  </div>
                  <div className="conv-item-preview">{lastMessagePreview(lead)}</div>
                  <div className="conv-item-tags">
                    {lead.extractedBedrooms != null && <span className="badge badge-muted">{lead.extractedBedrooms} BHK</span>}
                    {lead.extractedBudget != null && <span className="badge badge-muted">{formatINR(lead.extractedBudget)}</span>}
                    {lead.preferredLocation && <span className="badge badge-muted">{lead.preferredLocation}</span>}
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                  <ScoreRing score={score} size={30} strokeWidth={3} showValue={false} />
                  {needsReply(lead) && <span className="conv-item-unread">•</span>}
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
}

export { needsReply, lastMessagePreview };
