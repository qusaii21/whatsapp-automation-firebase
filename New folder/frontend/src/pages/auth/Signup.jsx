import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";
import { authErrorMessage } from "../../lib/authErrors.js";
import AuthLayout from "./AuthLayout.jsx";

/**
 * Signup is two Firebase calls under the hood (see AuthContext: signUp then
 * completeSignup), but presented as one form. If a person's browser closes
 * or a network call fails between those two steps, they come back already
 * signed in (Firebase Auth persisted that) but with no agencyId claim yet —
 * this page detects that (`user && !claims`) and quietly skips straight to
 * step 2 (just the agency name) instead of erroring or trying to create a
 * second Firebase Auth account for the same email.
 */
export default function Signup() {
  const { user, claims, loading, signUp, completeSignup } = useAuth();
  const navigate = useNavigate();

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agencyName, setAgencyName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!loading && user && claims && claims.agencyId) {
    return <Navigate to="/" replace />;
  }

  const resumingSetup = !loading && !!user && (!claims || !claims.agencyId);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!resumingSetup) {
        await signUp(email.trim(), password, displayName.trim());
      }
      await completeSignup(agencyName.trim(), displayName.trim());
      navigate("/", { replace: true });
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title={resumingSetup ? "Finish setting up your agency" : "Create your agency"}
      subtitle={
        resumingSetup
          ? "You're signed in — just name your agency to finish."
          : "Set up a new WhatsApp CRM workspace. You'll be the Owner."
      }
      footer={
        !resumingSetup && (
          <span>
            Already have an agency? <Link to="/login">Log in</Link>
          </span>
        )
      }
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error && <div className="auth-error">{error}</div>}

        {!resumingSetup && (
          <>
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
                autoComplete="new-password"
                minLength={6}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </>
        )}

        <div>
          <label className="field-label" htmlFor="agencyName">Agency name</label>
          <input
            id="agencyName"
            type="text"
            className="input"
            placeholder="e.g. Skyline Realty"
            value={agencyName}
            onChange={(e) => setAgencyName(e.target.value)}
            required
          />
        </div>

        <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
          {submitting ? "Creating…" : resumingSetup ? "Finish setup" : "Create agency"}
        </button>
      </form>
    </AuthLayout>
  );
}
