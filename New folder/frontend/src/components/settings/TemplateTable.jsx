import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { onSnapshot } from "firebase/firestore";
import { FileText, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { templatesCollection } from "../../lib/agencyPath.js";
import { authedFetch } from "../../lib/functions.js";
import { callFunction, friendlyWhatsAppError } from "../../lib/whatsappErrors.js";
import { formatDateTime, sortByRecency } from "../../lib/format.js";

const STATUS_BADGE_CLASS = {
  Approved: "badge-success",
  Pending: "badge-warm",
  Rejected: "badge-danger",
  Disabled: "badge-muted",
  Paused: "badge-warm",
  InAppeal: "badge-info",
};

const STATUS_FILTERS = ["All", "Approved", "Pending", "Rejected", "Disabled", "Paused", "InAppeal"];

/**
 * A lighter-weight template list scoped to Settings — search, status
 * filter, per-row Refresh, and a page-level Sync, all against the exact
 * same Cloud Functions and Firestore collection Templates.jsx uses (never a
 * duplicate implementation, see whatsappTemplates.js). Full creation and
 * the detailed per-template drawer stay on the dedicated Templates page,
 * linked from the toolbar, so this table doesn't reimplement that flow.
 *
 * `onSyncComplete(count, lastSyncedAt)` lets the parent page keep its
 * Health/Overview cards' template counters in sync without a second
 * Firestore read.
 */
export default function TemplateTable({ agencyId, connected, onSyncComplete, onToast }) {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [syncing, setSyncing] = useState(false);
  const [refreshingId, setRefreshingId] = useState(null);

  useEffect(() => {
    if (!agencyId) {
      setTemplates([]);
      setLoading(true);
      return undefined;
    }
    const unsub = onSnapshot(
      templatesCollection(agencyId),
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTemplates(docs);
        setLoading(false);
        const mostRecent = sortByRecency(docs, "lastSyncedAt")[0];
        onSyncComplete?.(docs.length, mostRecent?.lastSyncedAt || null);
      },
      () => setLoading(false)
    );
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agencyId]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortByRecency(
      templates.filter((t) => {
        if (term && !(t.name || "").toLowerCase().includes(term)) return false;
        if (statusFilter !== "All" && t.status !== statusFilter) return false;
        return true;
      }),
      "lastSyncedAt"
    ).slice(0, 25);
  }, [templates, search, statusFilter]);

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await callFunction(authedFetch, "/syncTemplates", { method: "POST" });
      onToast?.({
        type: "success",
        message: `Sync complete — ${result.added} added, ${result.updated} updated, ${result.disabled} disabled.`,
      });
    } catch (err) {
      onToast?.({ type: "error", message: friendlyWhatsAppError(err) });
    } finally {
      setSyncing(false);
    }
  }

  async function handleRefresh(templateId) {
    setRefreshingId(templateId);
    try {
      const result = await callFunction(authedFetch, "/refreshTemplate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      onToast?.({ type: "success", message: `Refreshed — status: ${result.status || "updated"}.` });
    } catch (err) {
      onToast?.({ type: "error", message: friendlyWhatsAppError(err) });
    } finally {
      setRefreshingId(null);
    }
  }

  return (
    <div className="card" style={{ padding: 20, marginBottom: 20 }}>
      <div className="settings-template-toolbar">
        <div>
          <h2 style={{ margin: 0, fontSize: 15 }}>Message Templates</h2>
          <div className="page-subtitle" style={{ marginTop: 2 }}>
            {templates.length} template{templates.length !== 1 ? "s" : ""} synced from Meta
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={handleSync} disabled={syncing || !connected}>
            <RefreshCw size={13} className={syncing ? "spin" : ""} />
            {syncing ? "Syncing…" : "Sync Templates"}
          </button>
          <Link className="btn btn-sm btn-primary" to="/templates">
            Manage Templates
          </Link>
        </div>
      </div>

      {!connected && (
        <div className="empty-note" style={{ marginBottom: 12 }}>
          Connect a WhatsApp Business Account above before syncing templates.
        </div>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <div className="conv-search" style={{ flex: 1, minWidth: 200, maxWidth: 320 }}>
          <Search size={14} />
          <input
            type="text"
            placeholder="Search by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              style={{ background: "none", border: "none", cursor: "pointer", padding: "0 6px", color: "var(--ink-faint)" }}
            >
              <X size={13} />
            </button>
          )}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={"chip" + (statusFilter === s ? " chip-active" : "")}
              onClick={() => setStatusFilter(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {Array.from({ length: 3 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((__, j) => (
                    <td key={j}><div className="skeleton skeleton-line" style={{ width: j === 0 ? "70%" : "50%" }} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state" style={{ padding: "36px 20px" }}>
          <FileText size={22} style={{ marginBottom: 6, color: "var(--ink-faint)" }} />
          <div className="empty-state-title">
            {templates.length === 0 ? "No templates yet" : "No templates match this filter"}
          </div>
          <div className="empty-note">
            {templates.length === 0
              ? 'Click "Sync Templates" to pull your catalog from WhatsApp.'
              : "Try a different search or status filter."}
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Language</th>
                <th>Status</th>
                <th>Last Synced</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td>{t.category}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.language}</td>
                  <td><span className={`badge ${STATUS_BADGE_CLASS[t.status] || "badge-muted"}`}>{t.status}</span></td>
                  <td style={{ color: "var(--ink-muted)", fontSize: 12 }}>{formatDateTime(t.lastSyncedAt)}</td>
                  <td>
                    <button
                      className="btn btn-sm btn-ghost"
                      title="Refresh from Meta"
                      disabled={refreshingId === t.id}
                      onClick={() => handleRefresh(t.id)}
                    >
                      <RotateCcw size={12} className={refreshingId === t.id ? "spin" : ""} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {templates.length > filtered.length && (
            <div className="empty-note" style={{ padding: "10px 4px" }}>
              Showing {filtered.length} of {templates.length} —{" "}
              <Link to="/templates" style={{ color: "var(--accent)" }}>view all on the Templates page</Link>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
