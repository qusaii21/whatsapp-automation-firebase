import { useState } from "react";
import { Eye, EyeOff, Plug } from "lucide-react";

const EMPTY_FORM = { pageAccessToken: "", pageId: "" };

export default function FacebookConnectionForm({ mode = "connect", onSubmit, submitting, error }) {
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
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <h2 style={{ marginTop: 0, fontSize: 15 }}>
        {isReconnect ? "Reconnect Facebook Page" : "Connect Facebook Page"}
      </h2>
      <p className="connect-form-note">
        Get these from Meta Business Suite &gt; <strong>Page Settings &gt; Page Access Tokens</strong> (or a
        long-lived token from your connected Meta App). We verify them against Meta before saving anything.
      </p>

      {error && <div className="auth-error" style={{ marginBottom: 14 }}>{error}</div>}

      <form className="auth-form" onSubmit={handleSubmit} style={{ maxWidth: 480 }} noValidate>
        <div>
          <label className="field-label" htmlFor="fb-page-id">Page ID</label>
          <input
            id="fb-page-id"
            type="text"
            className="input"
            autoComplete="off"
            value={form.pageId}
            onChange={(e) => set("pageId", e.target.value)}
            required
          />
        </div>

        <div>
          <label className="field-label" htmlFor="fb-page-token">Page Access Token</label>
          <div style={{ position: "relative" }}>
            <input
              id="fb-page-token"
              type={showToken ? "text" : "password"}
              className="input"
              autoComplete="off"
              spellCheck={false}
              value={form.pageAccessToken}
              onChange={(e) => set("pageAccessToken", e.target.value)}
              style={{ paddingRight: 36 }}
              required
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide page access token" : "Show page access token"}
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

        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          <Plug size={14} />
          {submitting ? "Verifying with Meta…" : isReconnect ? "Reconnect" : "Connect"}
        </button>
      </form>

      <p style={{ marginTop: 16, color: "var(--ink-muted)", fontSize: 13 }}>
        Also make sure your Facebook Page is subscribed to <code>leadgen</code> webhook events on this
        project's <code>/leadsWebhook</code> endpoint in your Meta App's dashboard.
      </p>
    </div>
  );
}
