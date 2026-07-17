import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext.jsx";

/**
 * Guards every CRM route:
 *   - not signed in                     -> /login
 *   - signed in but no agencyId claim   -> /unauthorized (mid-signup, or an
 *     unaccepted invite — see pages/auth/Unauthorized.jsx for the two
 *     concrete next steps offered there)
 * While Firebase Auth is resolving the initial session, renders nothing
 * rather than briefly redirecting to /login.
 */
export default function ProtectedRoute({ children }) {
  const { user, agencyId, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;

  if (!user) {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  if (!agencyId) {
    return <Navigate to="/unauthorized" replace />;
  }

  return children;
}
