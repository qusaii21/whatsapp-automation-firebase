import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase.js";
import { useAuth } from "../contexts/AuthContext.jsx";

/**
 * MINIMAL LOGIN PAGE
 * ---------------------------------------------------------------------------
 * This CRM had no authentication UI at all before this migration — every
 * Firestore call site read from global collections with no concept of "who
 * is signed in." Making the frontend tenant-aware means every page now
 * needs a real signed-in user to get an `agencyId` from (see AuthContext.jsx
 * and lib/agencyPath.js), so this is the minimum viable way to produce one.
 * It deliberately does NOT redesign anything or add Signup/ForgotPassword/
 * Logout — those remain a separate scope; this only unblocks the Firestore
 * migration itself.
 */
export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, agencyId, loading: authLoading } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  if (!authLoading && user && agencyId) {
    const redirectTo = location.state?.from || "/";
    navigate(redirectTo, { replace: true });
    return null;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
      // onIdTokenChanged in AuthContext picks up the new user; the redirect
      // above fires once `agencyId` shows up on their token's claims.
    } catch (err) {
      setError(err.message || "Failed to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="app-shell" style={{ alignItems: "center", justifyContent: "center", display: "flex" }}>
      <form
        onSubmit={handleSubmit}
        style={{ width: 360, maxWidth: "90vw", display: "flex", flexDirection: "column", gap: 12 }}
      >
        <h1 style={{ marginBottom: 8 }}>Sign in</h1>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
        {error && <div style={{ color: "var(--danger, #d33)", fontSize: 13 }}>{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
