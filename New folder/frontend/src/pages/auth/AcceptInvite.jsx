import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { authErrorMessage } from "../../lib/authErrors.js";
import AuthLayout from "./AuthLayout.jsx";
import LoadingScreen from "../../components/LoadingScreen.jsx";

/**
 * ACCEPT INVITE
 * ---------------------------------------------------------------------------
 * Entry point for the invitation flow's second half (Owner/Admin ->
 * inviteMember already ran — see functions/src/invites.js). An Owner/Admin
 * shares a link shaped like `/accept-invite?agencyId=...&inviteId=...`
 * (no email-sending integration in this phase — see invites.js's header) —
 * this page reads those two params and gets the signed-in user attached to
 * that agency.
 *
 * Three states:
 *   1. Not signed in — invitee needs an account. Offers inline log-in OR
 *      create-account, then immediately calls acceptInvite. (Deliberately
 *      does NOT show the invite's target email — the invites collection is
 *      unreadable by an unauthenticated client, by design; see
 *      firestore.rules. acceptInvite itself validates the email match
 *      server-side and returns a clear error if it doesn't.)
 *   2. Signed in, no agency yet — one click to join.
 *   3. Signed in, already belongs to an agency — this phase is one agency
 *      per account, so this is a dead end explained plainly (no silent
 *      failure).
 */
export default function AcceptInvite() {
  const { user, claims, loading, signIn, signUp, acceptInvite } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const agencyId = searchParams.get("agencyId") || "";
  const inviteId = searchParams.get("inviteId") || "";

  const [mode, setMode] = useState("login"); // "login" | "create"
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (loading) return <LoadingScreen />;

  if (!agencyId || !inviteId) {
    return (
      <AuthLayout title="Invite link incomplete" subtitle="This link is missing information and can't be used.">
        <p className="auth-error">Ask your agency owner for a fresh invite link.</p>
      </AuthLayout>
    );
  }

  if (user && claims && claims.agencyId) {
    return (
      <AuthLayout title="Already on a team" subtitle="This account already belongs to an agency.">
        <p className="auth-error">
          Each account can only belong to one agency in this version. Sign out and use a different account to accept
          this invite.
        </p>
      </AuthLayout>
    );
  }

  async function finishAccept() {
    setSubmitting(true);
    setError(null);
    try {
      await acceptInvite(agencyId, inviteId);
      navigate("/", { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleCredentialSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "login") {
        await signIn(email.trim(), password);
      } else {
        await signUp(email.trim(), password, displayName.trim());
      }
      await finishAccept();
    } catch (err) {
      setError(authErrorMessage(err));
      setSubmitting(false);
    }
  }

  if (user && (!claims || !claims.agencyId)) {
    return (
      <AuthLayout title="Join your team" subtitle={`Signed in as ${user.email}.`}>
        {error && <div className="auth-error">{error}</div>}
        <button className="btn btn-primary auth-submit" onClick={finishAccept} disabled={submitting}>
          {submitting ? "Joining…" : "Accept invite"}
        </button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      title="Join your team"
      subtitle="Log in or create an account to accept this invite."
      footer={
        <button type="button" className="auth-link-button" onClick={() => setMode(mode === "login" ? "create" : "login")}>
          {mode === "login" ? "New here? Create an account" : "Already have an account? Log in"}
        </button>
      }
    >
      <form className="auth-form" onSubmit={handleCredentialSubmit}>
        {error && <div className="auth-error">{error}</div>}
        {mode === "create" && (
          <div>
            <label className="field-label" htmlFor="displayName">Your name</label>
            <input
              id="displayName"
              type="text"
              className="input"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              required
            />
          </div>
        )}
        <div>
          <label className="field-label" htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            className="input"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="field-label" htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            className="input"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "create" ? 6 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          {submitting ? "Please wait…" : mode === "login" ? "Log in & accept" : "Create account & accept"}
        </button>
      </form>
    </AuthLayout>
  );
}
