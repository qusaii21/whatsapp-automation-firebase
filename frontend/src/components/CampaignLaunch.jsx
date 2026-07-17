import { useEffect, useState } from "react";
import { query, where, limit, onSnapshot } from "firebase/firestore";
import { Rocket, History, ShieldAlert, CircleCheck, CirclePlus, Send, CheckCheck, Ban, XCircle } from "lucide-react";
import { templatesCollection } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { authedFetch } from "../lib/functions.js";
import { formatDateTime } from "../lib/format.js";

/**
 * CAMPAIGN LAUNCH
 * ---------------------------------------------------------------------------
 * Thin client for the `launchCampaign` Cloud Function — same division of
 * responsibility as CampaignRecipients.jsx for addCampaignRecipients: all
 * real validation (recipient count, template approval) happens server-side
 * in launchCampaign.js, this component only mirrors those same checks
 * client-side to disable the button pre-emptively with a helpful reason,
 * and displays whatever the server actually decided (including the full
 * error list on a rejected launch — see requirements: "Return detailed
 * validation errors").
 *
 * Also renders the campaign timeline (`campaign.timeline`, written by
 * campaigns.js's buildTimelineEvent) and the launch bookkeeping fields
 * (queuedAt/queuedBy/lastValidatedAt/validationSummary) once a launch has
 * succeeded. No sending, no Cloud Tasks — draft -> queued is as far as this
 * goes, matching launchCampaign.js's own scope.
 */

const TEMPLATE_STATUS_BADGE_CLASS = {
  Approved: "badge-success",
  Pending: "badge-warm",
  Rejected: "badge-hot",
  Disabled: "badge-muted",
  Paused: "badge-muted",
  InAppeal: "badge-warm",
};

const TIMELINE_EVENT_META = {
  created: { label: "Created", icon: CirclePlus, tone: "muted" },
  recipients_added: { label: "Recipients Added", icon: CircleCheck, tone: "info" },
  queued: { label: "Queued", icon: Rocket, tone: "info" },
  sending: { label: "Sending", icon: Send, tone: "warm" },
  completed: { label: "Completed", icon: CheckCheck, tone: "success" },
  failed: { label: "Failed", icon: XCircle, tone: "danger" },
  cancelled: { label: "Cancelled", icon: Ban, tone: "muted" },
};

function timelineEventDescription(event) {
  const meta = event.meta || {};
  switch (event.type) {
    case "recipients_added":
      return `${meta.added ?? 0} recipient${meta.added === 1 ? "" : "s"} added`;
    case "queued":
      return meta.queuedBy ? `Launched by ${meta.queuedBy}` : "Launched";
    default:
      return null;
  }
}

function Timeline({ timeline }) {
  const events = Array.isArray(timeline) ? [...timeline].sort((a, b) => (a.at || 0) - (b.at || 0)) : [];

  if (events.length === 0) {
    return <div className="empty-note">No timeline events yet.</div>;
  }

  return (
    <div className="campaign-timeline">
      {events.map((event, i) => {
        const meta = TIMELINE_EVENT_META[event.type] || { label: event.type, icon: History, tone: "muted" };
        const Icon = meta.icon;
        const description = timelineEventDescription(event);
        return (
          <div className="campaign-timeline-row" key={`${event.type}-${event.at}-${i}`}>
            <div className={`campaign-timeline-dot campaign-timeline-dot-${meta.tone}`}>
              <Icon size={12} />
            </div>
            <div className="campaign-timeline-content">
              <div className="campaign-timeline-label">{meta.label}</div>
              {description && <div className="empty-note">{description}</div>}
            </div>
            <div className="campaign-timeline-time empty-note">{formatDateTime(event.at)}</div>
          </div>
        );
      })}
    </div>
  );
}

export default function CampaignLaunch({ campaignId, campaign }) {
  const { agencyId } = useAuth();
  const [template, setTemplate] = useState(null);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [launchErrors, setLaunchErrors] = useState(null);

  // Mirrors launchCampaign.js's own lookup (assertTemplateApprovedForCampaign
  // queries whatsappTemplates by name+language) so the button's disabled
  // reasons can reflect the same template the server will check.
  useEffect(() => {
    setTemplateLoaded(false);
    if (!agencyId || !campaign?.templateName || !campaign?.templateLanguage) {
      setTemplate(null);
      setTemplateLoaded(true);
      return undefined;
    }
    const q = query(
      templatesCollection(agencyId),
      where("name", "==", campaign.templateName),
      where("language", "==", campaign.templateLanguage),
      limit(1)
    );
    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        setTemplate(snapshot.empty ? null : { id: snapshot.docs[0].id, ...snapshot.docs[0].data() });
        setTemplateLoaded(true);
      },
      () => setTemplateLoaded(true)
    );
    return unsubscribe;
  }, [agencyId, campaign?.templateName, campaign?.templateLanguage]);

  if (!campaign) return null;

  const reasons = [];
  if (campaign.status !== "draft") {
    reasons.push(`Campaign is ${campaign.status}, not Draft — it can't be launched again.`);
  }
  if (!campaign.totalRecipients || campaign.totalRecipients < 1) {
    reasons.push("Add at least one recipient before launching.");
  }
  if (templateLoaded) {
    if (!template) {
      reasons.push(`Template '${campaign.templateName}' (${campaign.templateLanguage}) no longer exists.`);
    } else if (template.status === "Disabled" || template.status === "Paused") {
      reasons.push(`Template is ${template.status.toLowerCase()} and can't be used.`);
    } else if (template.status !== "Approved") {
      reasons.push(`Template is not approved yet (status: ${template.status}).`);
    }
  }

  const canLaunch = campaign.status === "draft" && templateLoaded && reasons.length === 0;
  const showLaunchAction = campaign.status === "draft";

  async function handleLaunch() {
    setLaunching(true);
    setLaunchErrors(null);
    try {
      const res = await authedFetch("/launchCampaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, launchedBy: "web" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLaunchErrors(Array.isArray(body.errors) && body.errors.length > 0 ? body.errors : [body.error || `Couldn't launch campaign (${res.status})`]);
        return;
      }
      setLaunchErrors(null);
    } catch (err) {
      console.error("CampaignLaunch: launch failed", err);
      setLaunchErrors([err.message || "Couldn't launch that campaign. Try again."]);
    } finally {
      setLaunching(false);
    }
  }

  return (
    <div className="form-section" style={{ marginTop: 24 }}>
      <div className="form-section-title">Launch</div>

      {showLaunchAction && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canLaunch || launching}
              onClick={handleLaunch}
            >
              <Rocket size={14} /> {launching ? "Launching..." : "Launch Campaign"}
            </button>
            {template && (
              <span
                className={`badge ${TEMPLATE_STATUS_BADGE_CLASS[template.status] || "badge-muted"}`}
                title="Template status"
              >
                Template: {template.status}
              </span>
            )}
          </div>

          {reasons.length > 0 && (
            <ul className="campaign-launch-reasons">
              {reasons.map((reason, i) => (
                <li key={i}>
                  <ShieldAlert size={12} /> {reason}
                </li>
              ))}
            </ul>
          )}

          {launchErrors && (
            <div className="campaign-launch-errors">
              <div className="campaign-launch-errors-title">Launch validation failed</div>
              <ul>
                {launchErrors.map((err, i) => (
                  <li key={i}>{err}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {(campaign.queuedAt || campaign.validationSummary) && (
        <div className="panel-two-col" style={{ marginTop: 16 }}>
          {campaign.queuedAt && (
            <div className="panel-field">
              <div className="panel-field-label">Queued at</div>
              <div className="panel-field-value">{formatDateTime(campaign.queuedAt)}</div>
            </div>
          )}
          {campaign.queuedBy && (
            <div className="panel-field">
              <div className="panel-field-label">Queued by</div>
              <div className="panel-field-value">{campaign.queuedBy}</div>
            </div>
          )}
          {campaign.lastValidatedAt && (
            <div className="panel-field">
              <div className="panel-field-label">Last validated</div>
              <div className="panel-field-value">{formatDateTime(campaign.lastValidatedAt)}</div>
            </div>
          )}
          {campaign.validationSummary?.totalRecipients != null && (
            <div className="panel-field">
              <div className="panel-field-label">Recipients at launch</div>
              <div className="panel-field-value">{campaign.validationSummary.totalRecipients}</div>
            </div>
          )}
          {campaign.validationSummary?.templateStatus && (
            <div className="panel-field form-full-width">
              <div className="panel-field-label">Template status at launch</div>
              <div className="panel-field-value">
                {campaign.validationSummary.templateName} ({campaign.validationSummary.templateLanguage}) —{" "}
                {campaign.validationSummary.templateStatus}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="form-section-title" style={{ marginTop: 20 }}>
        Timeline
      </div>
      <Timeline timeline={campaign.timeline} />
    </div>
  );
}
