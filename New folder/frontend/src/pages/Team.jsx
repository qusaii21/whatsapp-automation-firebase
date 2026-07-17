import { useEffect, useState } from "react";
import { onSnapshot } from "firebase/firestore";
import { useAuth } from "../contexts/AuthContext.jsx";
import { membersCollection } from "../lib/agencyPath.js";
import { authedFetch } from "../lib/functions.js";
import { authErrorMessage } from "../lib/authErrors.js";
import { formatDateTime } from "../lib/format.js";
import { ROLE_CHECKS_DISABLED, TEAM_UI_HIDDEN } from "../lib/devAccess.js";

const ROLE_LABELS = { owner: "Owner", admin: "Admin", agent: "Agent" };
const INVITABLE_ROLES = ["admin", "agent"];

/**
 * TEAM / INVITE MEMBER
 * ---------------------------------------------------------------------------
 * Owner/Admin-only page for the second half of onboarding (see
 * functions/src/inviteMember.js and pages/auth/AcceptInvite.jsx for the
 * flow's other half). Reuses the existing inviteMember Cloud Function —
 * no email is actually sent in this phase, so the result is a shareable
 * /accept-invite link the inviter copies and sends themselves.
 */
export default function Team() {
  const { agencyId, role } = useAuth();
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(true);

  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("agent");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [inviteLink, setInviteLink] = useState(null);
  const [copied, setCopied] = useState(false);

  const canInvite = ROLE_CHECKS_DISABLED || role === "owner" || role === "admin";

  // TEAM_UI_HIDDEN: invite/role-management UI isn't exposed for this phase —
  // see devAccess.js. Nothing below this is deleted, just not reached while
  // the flag is on; flip it back to bring the page back exactly as it was.
  if (TEAM_UI_HIDDEN) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Team</h1>
            <div className="page-subtitle">Team management isn't available yet in this version.</div>
          </div>
        </div>
      </div>
    );
  }

  useEffect(() => {
    if (!agencyId) {
      setMembers([]);
      setMembersLoading(false);
      return undefined;
    }
    setMembersLoading(true);
    const unsubscribe = onSnapshot(
      membersCollection(agencyId),
      (snapshot) => {
        setMembers(snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() })));
        setMembersLoading(false);
      },
      () => setMembersLoading(false)
    );
    return unsubscribe;
  }, [agencyId]);

  async function handleInvite(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInviteLink(null);
    setCopied(false);
    try {
      const res = await authedFetch("/inviteMember", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), role: inviteRole }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't send that invite (${res.status}).`);
      }
      const link = `${window.location.origin}/accept-invite?agencyId=${encodeURIComponent(
        body.agencyId
      )}&inviteId=${encodeURIComponent(body.inviteId)}`;
      setInviteLink(link);
      setEmail("");
    } catch (err) {
      setError(authErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
    } catch {
      // Clipboard access can be denied by the browser — the link is still
      // shown on screen and selectable, so this isn't fatal.
    }
  }

  if (!canInvite) {
    return (
      <div className="page">
        <div className="page-header">
          <div>
            <h1>Team</h1>
            <div className="page-subtitle">Only Owners and Admins can manage team members.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Team</h1>
          <div className="page-subtitle">Invite teammates and see who already has access.</div>
        </div>
      </div>

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <form className="auth-form" onSubmit={handleInvite} style={{ maxWidth: 420 }}>
          {error && <div className="auth-error">{error}</div>}
          {inviteLink && (
            <div className="auth-success">
              Invite created. Share this link with them:
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <input className="input" readOnly value={inviteLink} onFocus={(e) => e.target.select()} />
                <button type="button" className="btn btn-sm" onClick={copyLink}>
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          )}
          <div>
            <label className="field-label" htmlFor="inviteEmail">Email</label>
            <input
              id="inviteEmail"
              type="email"
              className="input"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="inviteRole">Role</label>
            <select
              id="inviteRole"
              className="select"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              {INVITABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
            {submitting ? "Sending invite…" : "Send invite"}
          </button>
        </form>
      </div>

      <div className="card" style={{ padding: 20 }}>
        <h2 style={{ marginTop: 0, fontSize: 15 }}>Members</h2>
        {membersLoading ? (
          <div className="empty-state">Loading members…</div>
        ) : members.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-title">No members yet</div>
          </div>
        ) : (
          <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Status</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>{m.displayName || "—"}</td>
                  <td>{m.email}</td>
                  <td>{ROLE_LABELS[m.role] || m.role}</td>
                  <td>{m.status}</td>
                  <td>{m.createdAt ? formatDateTime(m.createdAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  );
}
