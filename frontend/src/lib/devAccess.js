/**
 * TEMPORARY DEV-MODE OVERRIDES
 * ---------------------------------------------------------------------------
 * Mirrors functions/src/auth.js#ROLE_CHECKS_DISABLED — keep both in sync.
 *
 * ROLE_CHECKS_DISABLED: while true, every role-gated page/action in the
 * frontend treats any authenticated agency member as having full access
 * (Owner/Admin-equivalent), for this MVP phase. Nothing about the role
 * model changed — `role` still comes from the same auth claim, every
 * existing `role === "..."` check is still here, just OR'd with this flag
 * instead of deleted. Flip to `false` (and the backend flag alongside it)
 * to restore normal role-based authorization — no other file needs to
 * change.
 *
 * TEAM_UI_HIDDEN: the Team/Members/invite/role-management UI is hidden
 * from navigation and rendered as a placeholder for this phase (separate
 * from ROLE_CHECKS_DISABLED — this isn't about who's allowed, the feature
 * itself just isn't ready to expose yet). The underlying page, Cloud
 * Functions (inviteMember/acceptInvite), and data are untouched. Flip to
 * `false` to bring it back.
 */
export const ROLE_CHECKS_DISABLED = true;
export const TEAM_UI_HIDDEN = true;
