import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import {
  onIdTokenChanged,
  getIdTokenResult,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updateProfile,
} from "firebase/auth";
import { auth } from "../firebase.js";
import { authedFetch } from "../lib/functions.js";

/**
 * AUTH CONTEXT
 * ---------------------------------------------------------------------------
 * The ONE place in the frontend that knows who is signed in and which
 * agency they belong to. Every page/component/context/hook that needs
 * `agencyId` reads it from here via `useAuth()` — nothing constructs or
 * hardcodes an agencyId anywhere else (see lib/agencyPath.js, which every
 * Firestore call site now goes through, and which takes agencyId as an
 * argument rather than looking it up itself).
 *
 * agencyId/role/status are never stored in Firestore-fetched state and
 * never trusted from anything client-supplied — they come straight off the
 * signed-in user's Firebase ID token CUSTOM CLAIMS (set server-side by the
 * createAgency / acceptInvite Cloud Functions), the same source of truth
 * Firestore Rules and every Cloud Function already use. See
 * functions/src/auth.js's header for why claims (not a Firestore lookup)
 * are the trust boundary here.
 *
 * `onIdTokenChanged` (not `onAuthStateChanged`) is used deliberately: it
 * fires on sign-in/sign-out exactly like `onAuthStateChanged`, but ALSO
 * fires whenever the ID token is refreshed — which is what makes a
 * newly-created agency's claims (or a freshly-accepted invite's claims)
 * show up here right after this context's own `refreshClaims()` forces
 * that refresh, without requiring a full re-login.
 *
 * Exposes both flat fields (`agencyId`, `role`, `status` — used by
 * ProtectedRoute / lib/agencyPath.js call sites) and a `claims` object
 * (`{ agencyId, role, status }` — used by the pages/auth/* onboarding
 * screens, which check things like `claims.agencyId` while deciding
 * whether someone is mid-signup). Same underlying state, two shapes,
 * kept in sync in one place so nothing drifts.
 */
const AuthContext = createContext({
  user: null,
  agencyId: null,
  role: null,
  status: null,
  claims: { agencyId: null, role: null, status: null },
  loading: true,
  signUp: async () => {},
  completeSignup: async () => {},
  signIn: async () => {},
  signOutUser: async () => {},
  acceptInvite: async () => {},
  resetPassword: async () => {},
  refreshClaims: async () => {},
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [claims, setClaims] = useState({ agencyId: null, role: null, status: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onIdTokenChanged(auth, async (nextUser) => {
      setUser(nextUser);
      if (!nextUser) {
        setClaims({ agencyId: null, role: null, status: null });
        setLoading(false);
        return;
      }
      try {
        const tokenResult = await getIdTokenResult(nextUser);
        setClaims({
          agencyId: tokenResult.claims.agencyId || null,
          role: tokenResult.claims.role || null,
          status: tokenResult.claims.status || null,
        });
      } catch {
        setClaims({ agencyId: null, role: null, status: null });
      } finally {
        setLoading(false);
      }
    });
    return unsubscribe;
  }, []);

  // Called right after createAgency/acceptInvite succeed — custom claims
  // only land on a token at its next refresh, so those two flows force one
  // immediately rather than waiting for the ~hourly automatic refresh.
  const refreshClaims = useCallback(async () => {
    if (!auth.currentUser) return;
    await auth.currentUser.getIdToken(true);
  }, []);

  // Step 1 of signup: create the Firebase Auth user directly (client SDK,
  // no server round trip needed for this part — see functions/src/createAgency.js's
  // header). Sets displayName on the Auth profile too, so it's available
  // even before an agency (and its member doc) exist.
  const signUp = useCallback(async (email, password, displayName) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    if (displayName) {
      await updateProfile(cred.user, { displayName });
    }
    return cred.user;
  }, []);

  // Step 2 of signup: turn the just-created (or already-signed-in,
  // not-yet-onboarded) Auth user into the Owner of a brand-new agency via
  // the existing createAgency Cloud Function, then force a token refresh so
  // the new agencyId/role claims are immediately visible everywhere
  // (Firestore Rules, ProtectedRoute, every other Cloud Function) without
  // requiring a logout/login.
  const completeSignup = useCallback(
    async (agencyName, displayName) => {
      const res = await authedFetch("/createAgency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyName, displayName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't create your agency (${res.status}).`);
      }
      await refreshClaims();
      return body;
    },
    [refreshClaims]
  );

  const signIn = useCallback(async (email, password) => {
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const signOutUser = useCallback(async () => {
    await signOut(auth);
  }, []);

  const resetPassword = useCallback(async (email) => {
    await sendPasswordResetEmail(auth, email);
  }, []);

  // Second half of the invite flow — the invitee is already signed in (via
  // signIn/signUp above) by the time this is called. Reuses the existing
  // acceptInvite Cloud Function, then force-refreshes claims exactly like
  // completeSignup does.
  const acceptInvite = useCallback(
    async (agencyId, inviteId) => {
      const res = await authedFetch("/acceptInvite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agencyId, inviteId, displayName: auth.currentUser?.displayName || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't accept that invite (${res.status}).`);
      }
      await refreshClaims();
      return body;
    },
    [refreshClaims]
  );

  const value = useMemo(
    () => ({
      user,
      agencyId: claims.agencyId,
      role: claims.role,
      status: claims.status,
      claims,
      loading,
      signUp,
      completeSignup,
      signIn,
      signOutUser,
      acceptInvite,
      resetPassword,
      refreshClaims,
    }),
    [user, claims, loading, signUp, completeSignup, signIn, signOutUser, acceptInvite, resetPassword, refreshClaims]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
