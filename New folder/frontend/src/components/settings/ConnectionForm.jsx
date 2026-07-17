import { useState } from "react";
import { Eye, EyeOff, Plug } from "lucide-react";

const EMPTY_FORM = { accessToken: "", phoneNumberId: "", businessAccountId: "" };

/**
 * The one form for both the initial Connect flow and Reconnect (same three
 * fields, same connectWhatsApp endpoint — see whatsappIntegration.js's own
 * comment on why Reconnect isn't a separate code path). `mode` only changes
 * copy and the submit button label.
 */
export default function ConnectionForm({ mode = "connect", onSubmit, submitting, error }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [showToken, setShowToken] = useState(false);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const ok = await onSubmit(form);
    if (ok) setForm(EMPTY_FORM);
  }

  const isReconnect = mode === "reconnect";

  return (
    <div className="card" style={{ padding: 20 }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>
        {isReconnect ? "Reconnect WhatsApp Business Account" : "Connect WhatsApp Business Account"}
      </h2>
      <p className="connect-form-note">
        Get these values from your own Meta App's <strong>WhatsApp &gt; API Setup</strong> page. We verify
        them against Meta before saving anything — nothing is stored until the connection succeeds.
      </p>

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      <form className="auth-form" onSubmit={handleSubmit} style={{ maxWidth: 480 }} noValidate>
        <div>
          <label className="field-label" htmlFor="wa-access-token">Access Token</label>
          <div style={{ position: "relative" }}>
            <input
              id="wa-access-token"
              type={showToken ? "text" : "password"}
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={form.accessToken}
              onChange={(e) => set("accessToken", e.target.value)}
              style={{ paddingRight: 36 }}
              required
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide access token" : "Show access token"}
              style={{
                position: "absolute",
                right: 8,
                top: "50%",
                transform: "translateY(-50%)",
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--ink-faint)",
                display: "flex",
              }}
            >
              {showToken ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>

        <div>
          <label className="field-label" htmlFor="wa-phone-number-id">Phone Number ID</label>
          <input
            id="wa-phone-number-id"
            type="text"
            className="input"
            autoComplete="off"
            value={form.phoneNumberId}
            onChange={(e) => set("phoneNumberId", e.target.value)}
            required
          />
        </div>

        <div>
          <label className="field-label" htmlFor="wa-business-account-id">Business Account ID (WABA ID)</label>
          <input
            id="wa-business-account-id"
            type="text"
            className="input"
            autoComplete="off"
            value={form.businessAccountId}
            onChange={(e) => set("businessAccountId", e.target.value)}
            required
          />
        </div>

        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          <Plug size={14} />
          {submitting ? "Verifying with Meta…" : isReconnect ? "Reconnect" : "Connect"}
        </button>
      </form>

      <p style={{ marginTop: 16, color: "var(--ink-muted)", fontSize: 13 }}>
        Also set your webhook URL to this project's <code>/whatsappWebhook</code> endpoint in your Meta
        App's <strong>WhatsApp &gt; Configuration</strong> page, using the verify token your platform admin
        gave you — this lets inbound messages reach your agency.
      </p>
    </div>
  );
}
