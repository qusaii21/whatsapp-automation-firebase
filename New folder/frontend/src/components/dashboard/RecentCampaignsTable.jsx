import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";

const STATUS_BADGE_CLASS = {
  draft: "badge-muted",
  queued: "badge-info",
  sending: "badge-warm",
  paused: "badge-warm",
  completed: "badge-success",
  failed: "badge-hot",
  cancelled: "badge-muted",
};

const STATUS_LABEL = {
  draft: "Draft",
  queued: "Queued",
  sending: "Sending",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Mirrors campaigns.js's own "resolved" definition (completeCampaignIfFinished):
// a recipient counts as resolved once it's been sent OR permanently failed —
// delivered/read status can still update later without changing this %.
function completionPct(c) {
  const total = c.totalRecipients || 0;
  if (total === 0) return 0;
  const resolved = (c.sentCount || 0) + (c.failedCount || 0);
  return Math.round((resolved / total) * 100);
}

export default function RecentCampaignsTable({ campaigns, loading }) {
  if (loading) {
    return (
      <div className="campaigns-table-skeleton">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="skeleton skeleton-line" style={{ height: 34, marginBottom: 8 }} />
        ))}
      </div>
    );
  }

  if (campaigns.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No campaigns yet</div>
        <div className="empty-note">Launch your first WhatsApp campaign to see it here.</div>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Campaign</th>
            <th>Status</th>
            <th>Recipients</th>
            <th>Sent</th>
            <th>Delivered</th>
            <th>Read</th>
            <th>Failed</th>
            <th>Completion</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id}>
              <td className="campaigns-table-name">{c.name}</td>
              <td>
                <span className={`badge ${STATUS_BADGE_CLASS[c.status] || "badge-muted"}`}>
                  {STATUS_LABEL[c.status] || c.status}
                </span>
              </td>
              <td className="mono-cell">{c.totalRecipients ?? 0}</td>
              <td className="mono-cell">{c.sentCount ?? 0}</td>
              <td className="mono-cell">{c.deliveredCount ?? 0}</td>
              <td className="mono-cell">{c.readCount ?? 0}</td>
              <td className={`mono-cell ${c.failedCount ? "campaign-card-stat-danger" : ""}`}>{c.failedCount ?? 0}</td>
              <td className="mono-cell">{completionPct(c)}%</td>
              <td>
                <Link to={`/campaigns?id=${c.id}`} className="btn btn-ghost btn-sm" title="Open campaign">
                  Open <ArrowUpRight size={13} />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
