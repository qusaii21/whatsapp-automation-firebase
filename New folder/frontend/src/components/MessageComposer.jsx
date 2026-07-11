import { useState } from "react";
import { Send } from "lucide-react";

/**
 * HUMAN AGENT MODE — manual message composer.
 *
 * A WhatsApp-like text input + send button, shown at the bottom of the chat
 * thread for every lead. Sending calls the `sendManualMessage` Cloud
 * Function (the only function in this project meant to be hit directly from
 * the browser — see functions/src/sendManualMessage.js for why), which sends
 * the text through the WhatsApp Cloud API and appends it to the lead's
 * conversationHistory. Firestore's own onSnapshot listener in ChatCRM.jsx
 * then reflects the sent message in the thread — this component doesn't
 * optimistically render it itself, so there's exactly one source of truth
 * for what actually got delivered.
 */
function functionsBaseUrl() {
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
  return `https://us-central1-${projectId}.cloudfunctions.net`;
}

export default function MessageComposer({ phone }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || sending || !phone) return;

    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${functionsBaseUrl()}/sendManualMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Send failed (${res.status})`);
      }
      setText("");
    } catch (err) {
      console.error("MessageComposer: send failed", err);
      setError("Couldn't send that message. Try again.");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="chat-composer">
      {error && <div className="chat-composer-error">{error}</div>}
      <textarea
        className="chat-composer-input"
        placeholder="Type a message…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={handleKeyDown}
        rows={1}
      />
      <button
        className="btn btn-primary btn-icon"
        onClick={handleSend}
        disabled={sending || !text.trim()}
        title="Send"
      >
        <Send size={16} />
      </button>
    </div>
  );
}
