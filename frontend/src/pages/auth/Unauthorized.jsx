import { Link } from "react-router-dom";
import { useAuth } from "../../contexts/AuthContext.jsx";
import AuthLayout from "./AuthLayout.jsx";

/**
 * Shown when ProtectedRoute finds a signed-in user with no `agencyId`
 * claim — i.e. someone who started signup but never finished it, or has an
 * invite waiting that they haven't accepted yet. Not a generic "access
 * denied" page: it gives the two concrete next steps that actually resolve
 * this state, plus a way out (sign out) if neither applies.
 */
export default function Unauthorized() {
  const { user, signOutUser } = useAuth();

  return (
    <AuthLayout
      title="No agency yet"
      subtitle={user ? `Signed in as ${user.email}.` : "You're not attached to an agency."}
    >
      <p className="auth-help-text">
        This account isn't linked to a WhatsApp CRM agency yet. If you started creating one, finish that below. If a
        teammate invited you, use the invite link they shared instead.
      </p>
      <div className="auth-form">
        <Link className="btn btn-primary auth-submit" to="/signup">
          Finish agency setup
        </Link>
        <button className="btn auth-submit" onClick={signOutUser}>
          Sign out
        </button>
      </div>
    </AuthLayout>
  );
}
