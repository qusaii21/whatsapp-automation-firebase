export default function ConversationThread({ history }) {
  if (!history || history.length === 0) {
    return <p className="empty-note">No messages yet.</p>;
  }

  const sorted = [...history].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

  return (
    <div className="conversation-thread">
      {sorted.map((turn, i) => (
        <div
          key={i}
          className={"chat-bubble " + (turn.role === "user" ? "chat-bubble-user" : "chat-bubble-assistant")}
        >
          <div className="chat-bubble-role">{turn.role === "user" ? "Lead" : "Agent"}</div>
          <div className="chat-bubble-text">{turn.text}</div>
          {turn.timestamp && (
            <div className="chat-bubble-time">
              {new Date(turn.timestamp).toLocaleString()}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
