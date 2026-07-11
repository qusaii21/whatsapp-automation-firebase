import { useEffect, useRef } from "react";
import { formatDayDivider, formatINR } from "../lib/format.js";

function bubbleRole(turn) {
  if (turn.role === "user") return "user";
  if (turn.role === "agent" || turn.sentBy === "human") return "agent";
  return "ai";
}

function PropertyCardBubble({ property }) {
  if (!property) return null;
  const image = Array.isArray(property.images) ? property.images[0] : property.imageUrl;
  return (
    <div className="property-card-bubble">
      {image && <img src={image} alt={property.projectName || "Property"} />}
      <div className="property-card-bubble-body">
        <div className="property-card-bubble-title">{property.projectName || "Property"}</div>
        <div className="property-card-bubble-meta">
          {property.bedrooms != null && property.bedrooms > 0 ? `${property.bedrooms} BHK · ` : ""}
          {formatINR(property.price)}
          {property.listingType === "Rent" ? "/mo" : ""} · {property.locality || property.city || ""}
        </div>
      </div>
    </div>
  );
}

export default function ConversationThread({ history, propertiesById = {} }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [history?.length]);

  if (!history || history.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No messages yet</div>
        <div className="empty-note">Once this lead messages on WhatsApp, the conversation shows up here.</div>
      </div>
    );
  }

  const sorted = [...history].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  let lastDay = null;

  return (
    <div className="conversation-thread">
      {sorted.map((turn, i) => {
        const day = formatDayDivider(turn.timestamp);
        const showDivider = day && day !== lastDay;
        lastDay = day;
        const role = bubbleRole(turn);
        const property = turn.matchedPropertyId ? propertiesById[turn.matchedPropertyId] : null;

        return (
          <div key={i}>
            {showDivider && (
              <div className="chat-day-divider">
                <span>{day}</span>
              </div>
            )}
            <div className={`bubble-row from-${role}`}>
              <div className={`bubble bubble-${role}`}>
                {role === "agent" && <div className="bubble-role">Human agent</div>}
                <div className="chat-bubble-text">{turn.text}</div>
                {turn.timestamp && (
                  <div className="bubble-meta">
                    {new Date(turn.timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                  </div>
                )}
              </div>
            </div>
            {property && (
              <div className={`bubble-row from-${role}`} style={{ marginTop: -4 }}>
                <PropertyCardBubble property={property} />
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
