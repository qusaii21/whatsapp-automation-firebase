import { UserPlus, FileText, Rocket, CheckCircle2, PauseCircle, PlayCircle, XCircle } from "lucide-react";
import { formatRelativeTime } from "../../lib/format.js";

const TYPE_META = {
  lead_created: { icon: UserPlus, label: "Lead created", tone: "cold" },
  template_created: { icon: FileText, label: "Template created", tone: "info" },
  campaign_started: { icon: Rocket, label: "Campaign started", tone: "warm" },
  campaign_completed: { icon: CheckCircle2, label: "Campaign completed", tone: "success" },
  campaign_paused: { icon: PauseCircle, label: "Campaign paused", tone: "muted" },
  campaign_resumed: { icon: PlayCircle, label: "Campaign resumed", tone: "info" },
  campaign_cancelled: { icon: XCircle, label: "Campaign cancelled", tone: "muted" },
};

export default function ActivityTimeline({ items, loading }) {
  if (loading) {
    return (
      <div>
        {[...Array(4)].map((_, i) => (
          <div key={i} className="skeleton skeleton-line" style={{ height: 14, marginBottom: 14 }} />
        ))}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No recent activity</div>
        <div className="empty-note">New leads, templates, and campaign events will show up here.</div>
      </div>
    );
  }

  return (
    <div className="activity-timeline">
      {items.map((item) => {
        const meta = TYPE_META[item.type] || { icon: FileText, label: item.type, tone: "muted" };
        const Icon = meta.icon;
        return (
          <div key={item.id} className="activity-timeline-row">
            <span className={`activity-timeline-icon activity-timeline-icon-${meta.tone}`}>
              <Icon size={14} />
            </span>
            <div className="activity-timeline-body">
              <div className="activity-timeline-title">{item.title}</div>
              <div className="activity-timeline-time">{formatRelativeTime(item.at)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
