import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getDocs, limit, onSnapshot, orderBy, query } from "firebase/firestore";
import {
  Users,
  GitBranch,
  Rocket,
  Bot,
  MessageCircle,
  Send,
  FileText,
  Zap,
  Wallet,
  Coins,
  Gauge,
  Cpu,
  DollarSign,
  Sparkles,
} from "lucide-react";
import { campaignsCollection, leadsCollection, templatesCollection } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { useDashboardMetrics } from "../lib/useDashboardMetrics.js";
import { dayKeyLabel } from "../lib/metricsPeriods.js";
import { formatUSD, formatCount, toDate } from "../lib/format.js";
import { mostUsedModel } from "../lib/llmModels.js";
import KpiCard from "../components/dashboard/KpiCard.jsx";
import SectionCard from "../components/dashboard/SectionCard.jsx";
import TrendBarChart from "../components/dashboard/TrendBarChart.jsx";
import DonutChart from "../components/dashboard/DonutChart.jsx";
import RecentCampaignsTable from "../components/dashboard/RecentCampaignsTable.jsx";
import ActivityTimeline from "../components/dashboard/ActivityTimeline.jsx";
import DashboardWarnings from "../components/dashboard/DashboardWarnings.jsx";
import QuickActions from "../components/dashboard/QuickActions.jsx";

const CAMPAIGN_STATUS_ORDER = ["draft", "queued", "sending", "paused", "completed", "failed", "cancelled"];
const CAMPAIGN_STATUS_LABEL = {
  draft: "Draft",
  queued: "Queued",
  sending: "Sending",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};
const CAMPAIGN_STATUS_COLOR = {
  draft: "var(--ink-faint)",
  queued: "var(--cold)",
  sending: "var(--accent)",
  paused: "var(--warm)",
  completed: "var(--success)",
  failed: "var(--hot)",
  cancelled: "var(--border-strong)",
};

const TEMPLATE_STATUS_ORDER = ["Approved", "Pending", "Rejected", "Disabled", "Paused", "InAppeal"];
const TEMPLATE_STATUS_COLOR = {
  Approved: "var(--success)",
  Pending: "var(--warm)",
  Rejected: "var(--hot)",
  Disabled: "var(--ink-faint)",
  Paused: "var(--warm)",
  InAppeal: "var(--cold)",
};

// Campaign timeline event types (see functions/src/campaigns.js's
// CAMPAIGN_TIMELINE_EVENT_TYPES) that map onto the activity feed's vocabulary.
// "created" / "recipients_added" are deliberately left out — noisy at
// campaign-authoring time and not part of the requested activity types.
const CAMPAIGN_TIMELINE_TO_ACTIVITY = {
  queued: "campaign_started",
  completed: "campaign_completed",
  paused: "campaign_paused",
  resumed: "campaign_resumed",
  cancelled: "campaign_cancelled",
};

export default function Dashboard() {
  const { agencyId } = useAuth();
  const { allTime, allTimeLoading, today, todayLoading, month, series } = useDashboardMetrics(agencyId);

  const [recentCampaigns, setRecentCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);

  const [recentLeads, setRecentLeads] = useState([]);
  const [recentTemplates, setRecentTemplates] = useState([]);
  const [activitySourcesLoading, setActivitySourcesLoading] = useState(true);

  // Recent campaigns — live (status/counters change in real time as sends
  // go out), bounded to 5, same collection + fields the Campaigns page
  // already reads. Also feeds the activity timeline and the warnings below,
  // so this is the only campaign query the whole page needs.
  useEffect(() => {
    if (!agencyId) {
      setRecentCampaigns([]);
      setCampaignsLoading(true);
      return undefined;
    }
    const q = query(campaignsCollection(agencyId), orderBy("createdAt", "desc"), limit(5));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRecentCampaigns(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setCampaignsLoading(false);
      },
      () => setCampaignsLoading(false)
    );
    return unsub;
  }, [agencyId]);

  // Recent leads + templates — one-time reads (not live listeners) since
  // they only feed the supplementary activity feed, not a KPI that needs to
  // update mid-session. Bounded to 5 each.
  useEffect(() => {
    if (!agencyId) {
      setRecentLeads([]);
      setRecentTemplates([]);
      setActivitySourcesLoading(true);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const [leadsSnap, templatesSnap] = await Promise.all([
          getDocs(query(leadsCollection(agencyId), orderBy("createdAt", "desc"), limit(5))),
          getDocs(query(templatesCollection(agencyId), orderBy("createdAt", "desc"), limit(5))),
        ]);
        if (cancelled) return;
        setRecentLeads(leadsSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setRecentTemplates(templatesSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
      } finally {
        if (!cancelled) setActivitySourcesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agencyId]);

  // ── KPI derivations ──────────────────────────────────────────────────
  const runningCampaigns = (allTime.campaigns?.byStatus?.queued || 0) + (allTime.campaigns?.byStatus?.sending || 0);

  // ── Chart data ────────────────────────────────────────────────────────
  const leadsSeriesData = useMemo(
    () => series.map((d) => ({ label: dayKeyLabel(d.key), values: [d.leads?.total || 0] })),
    [series]
  );
  const aiHumanSeriesData = useMemo(
    () =>
      series.map((d) => ({
        label: dayKeyLabel(d.key),
        values: [d.messages?.ai?.total || 0, d.messages?.human?.total || 0],
      })),
    [series]
  );
  const deliverySeriesData = useMemo(
    () =>
      series.map((d) => ({
        label: dayKeyLabel(d.key),
        values: [d.messages?.whatsapp?.delivered || 0, d.messages?.whatsapp?.read || 0, d.messages?.whatsapp?.failed || 0],
      })),
    [series]
  );

  const campaignStatusData = useMemo(
    () =>
      CAMPAIGN_STATUS_ORDER.map((s) => ({
        label: CAMPAIGN_STATUS_LABEL[s],
        value: allTime.campaigns?.byStatus?.[s] || 0,
        color: CAMPAIGN_STATUS_COLOR[s],
      })),
    [allTime]
  );
  const templateStatusData = useMemo(
    () =>
      TEMPLATE_STATUS_ORDER.map((s) => ({
        label: s,
        value: allTime.templates?.byStatus?.[s] || 0,
        color: TEMPLATE_STATUS_COLOR[s],
      })),
    [allTime]
  );

  // ── Activity feed — merges campaign lifecycle events (already loaded
  // above, zero extra cost) with the two small recent-leads/templates reads.
  const activityItems = useMemo(() => {
    const items = [];
    for (const c of recentCampaigns) {
      for (const evt of c.timeline || []) {
        const type = CAMPAIGN_TIMELINE_TO_ACTIVITY[evt.type];
        if (!type) continue;
        items.push({ id: `${c.id}-${evt.type}-${evt.at}`, type, title: `"${c.name}" ${type === "campaign_started" ? "started" : type.replace("campaign_", "")}`, at: evt.at });
      }
    }
    for (const lead of recentLeads) {
      items.push({ id: `lead-${lead.id}`, type: "lead_created", title: `New lead: ${lead.name || lead.phone || lead.id}`, at: lead.createdAt });
    }
    for (const tpl of recentTemplates) {
      items.push({ id: `tpl-${tpl.id}`, type: "template_created", title: `Template created: ${tpl.name || tpl.id}`, at: tpl.createdAt });
    }
    return items
      .filter((i) => i.at)
      .sort((a, b) => (toDate(b.at)?.getTime() || 0) - (toDate(a.at)?.getTime() || 0))
      .slice(0, 8);
  }, [recentCampaigns, recentLeads, recentTemplates]);

  // ── Warnings — only computed from data already loaded above; renders
  // nothing if the array comes back empty (DashboardWarnings handles that).
  const warnings = useMemo(() => {
    const list = [];
    const pendingTemplates = allTime.templates?.byStatus?.Pending || 0;
    if (pendingTemplates > 0) {
      list.push({
        id: "tpl-pending",
        tone: "warning",
        message: `${pendingTemplates} template${pendingTemplates === 1 ? "" : "s"} pending approval`,
        to: "/templates",
      });
    }
    const failedCampaigns = allTime.campaigns?.byStatus?.failed || 0;
    if (failedCampaigns > 0) {
      list.push({
        id: "camp-failed",
        tone: "danger",
        message: `${failedCampaigns} campaign${failedCampaigns === 1 ? "" : "s"} failed`,
        to: "/campaigns",
      });
    }
    const pausedCampaigns = allTime.campaigns?.byStatus?.paused || 0;
    if (pausedCampaigns > 0) {
      list.push({
        id: "camp-paused",
        tone: "paused",
        message: `${pausedCampaigns} campaign${pausedCampaigns === 1 ? "" : "s"} paused`,
        to: "/campaigns",
      });
    }
    return list;
  }, [allTime]);

  const monthlyCostUsd = (month.costs?.aiUsd || 0) + (month.costs?.whatsappUsd || 0);
  const modelLabel = mostUsedModel(allTime.llm?.byModel);

  return (
    <div className="page dashboard-page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <div className="page-subtitle">Live overview of leads, campaigns, AI usage, and cost across the CRM.</div>
        </div>
      </div>

      <DashboardWarnings warnings={warnings} />

      {/* KPI row */}
      <div className="kpi-grid">
        <KpiCard icon={Users} label="Total Leads" value={formatCount(allTime.leads?.total)} loading={allTimeLoading} />
        <KpiCard
          icon={GitBranch}
          label="Active Opportunities"
          value={formatCount(allTime.opportunities?.total)}
          sub="All opportunities tracked"
          loading={allTimeLoading}
        />
        <KpiCard icon={Rocket} label="Running Campaigns" value={formatCount(runningCampaigns)} loading={allTimeLoading} />
        <KpiCard icon={Bot} label="AI Messages Today" value={formatCount(today.messages?.ai?.total)} loading={todayLoading} />
        <KpiCard icon={MessageCircle} label="Human Messages Today" value={formatCount(today.messages?.human?.total)} loading={todayLoading} />
        <KpiCard icon={Send} label="WhatsApp Messages Today" value={formatCount(today.messages?.whatsapp?.sent)} loading={todayLoading} />
        <KpiCard icon={FileText} label="Templates" value={formatCount(allTime.templates?.total)} loading={allTimeLoading} />
        <KpiCard icon={Zap} label="Credits Used Today" value={formatCount(today.credits?.used)} loading={todayLoading} />
      </div>

      {/* Usage / cost */}
      <SectionCard title="Usage" subtitle="Estimated spend from Groq (AI) and Meta (WhatsApp) usage.">
        <div className="campaign-stat-grid">
          <div className="campaign-stat-tile">
            <span className="campaign-stat-tile-icon"><DollarSign size={16} /></span>
            <div>
              <div className="campaign-stat-value">{formatUSD(allTime.costs?.aiUsd)}</div>
              <div className="campaign-stat-label">Estimated AI Cost</div>
            </div>
          </div>
          <div className="campaign-stat-tile">
            <span className="campaign-stat-tile-icon"><Send size={16} /></span>
            <div>
              <div className="campaign-stat-value">{formatUSD(allTime.costs?.whatsappUsd)}</div>
              <div className="campaign-stat-label">Estimated WhatsApp Cost</div>
            </div>
          </div>
          <div className="campaign-stat-tile">
            <span className="campaign-stat-tile-icon"><Wallet size={16} /></span>
            <div>
              <div className="campaign-stat-value">{formatUSD(monthlyCostUsd)}</div>
              <div className="campaign-stat-label">Estimated Monthly Cost</div>
            </div>
          </div>
          <div className="campaign-stat-tile">
            <span className="campaign-stat-tile-icon"><Coins size={16} /></span>
            <div>
              <div className="campaign-stat-value">{formatCount(allTime.credits?.used)}</div>
              <div className="campaign-stat-label">Credits Used</div>
            </div>
          </div>
          <div className="campaign-stat-tile">
            <span className="campaign-stat-tile-icon"><Gauge size={16} /></span>
            <div>
              <div className="campaign-stat-value">—</div>
              <div className="campaign-stat-label">Credits Remaining</div>
            </div>
          </div>
        </div>
      </SectionCard>

      {/* Charts */}
      <div className="dashboard-charts-grid">
        <SectionCard title="Leads Over Time" subtitle="Last 14 days">
          <TrendBarChart
            data={leadsSeriesData}
            series={[{ key: "leads", label: "Leads", color: "var(--accent)" }]}
          />
        </SectionCard>
        <SectionCard title="AI vs Human Messages" subtitle="Last 14 days">
          <TrendBarChart
            data={aiHumanSeriesData}
            series={[
              { key: "ai", label: "AI", color: "var(--accent)" },
              { key: "human", label: "Human", color: "var(--cold)" },
            ]}
          />
        </SectionCard>
        <SectionCard title="Delivered vs Read vs Failed" subtitle="Last 14 days">
          <TrendBarChart
            data={deliverySeriesData}
            series={[
              { key: "delivered", label: "Delivered", color: "var(--cold)" },
              { key: "read", label: "Read", color: "var(--success)" },
              { key: "failed", label: "Failed", color: "var(--hot)" },
            ]}
          />
        </SectionCard>
        <SectionCard title="Campaigns by Status">
          <DonutChart data={campaignStatusData} />
        </SectionCard>
        <SectionCard title="Templates by Status">
          <DonutChart data={templateStatusData} />
        </SectionCard>
      </div>

      {/* Recent campaigns */}
      <SectionCard title="Recent Campaigns" subtitle="Last 5 campaigns, most recently created first.">
        <RecentCampaignsTable campaigns={recentCampaigns} loading={campaignsLoading} />
      </SectionCard>

      <div className="dashboard-two-col">
        {/* AI section */}
        <SectionCard title="AI" subtitle="Groq-powered agent activity, all-time.">
          <div className="campaign-stat-grid">
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><Bot size={16} /></span>
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.messages?.ai?.total)}</div>
                <div className="campaign-stat-label">AI Messages</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><MessageCircle size={16} /></span>
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.messages?.human?.total)}</div>
                <div className="campaign-stat-label">Human Messages</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><Gauge size={16} /></span>
              <div>
                <div className="campaign-stat-value dashboard-value-muted">Not tracked yet</div>
                <div className="campaign-stat-label">Avg. Response Time</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><Cpu size={16} /></span>
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.llm?.tokens?.total)}</div>
                <div className="campaign-stat-label">Estimated Tokens</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><DollarSign size={16} /></span>
              <div>
                <div className="campaign-stat-value">{formatUSD(allTime.costs?.aiUsd)}</div>
                <div className="campaign-stat-label">Estimated AI Cost</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <span className="campaign-stat-tile-icon"><Sparkles size={16} /></span>
              <div>
                <div className="campaign-stat-value dashboard-value-model">{modelLabel || "—"}</div>
                <div className="campaign-stat-label">Most Used Model</div>
              </div>
            </div>
          </div>
        </SectionCard>

        {/* Templates section */}
        <SectionCard
          title="Templates"
          subtitle="Approval status across your WhatsApp template catalog."
          action={
            <Link to="/templates?new=1" className="btn btn-primary btn-sm">Create Template</Link>
          }
        >
          <div className="campaign-stat-grid">
            <div className="campaign-stat-tile">
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.templates?.byStatus?.Approved)}</div>
                <div className="campaign-stat-label">Approved</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.templates?.byStatus?.Pending)}</div>
                <div className="campaign-stat-label">Pending</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.templates?.byStatus?.Rejected)}</div>
                <div className="campaign-stat-label">Rejected</div>
              </div>
            </div>
            <div className="campaign-stat-tile">
              <div>
                <div className="campaign-stat-value">{formatCount(allTime.templates?.byStatus?.Disabled)}</div>
                <div className="campaign-stat-label">Disabled</div>
              </div>
            </div>
          </div>
        </SectionCard>
      </div>

      <div className="dashboard-two-col">
        {/* Activity timeline */}
        <SectionCard title="Recent Activity" subtitle="Newest first — leads, templates, and campaign lifecycle events.">
          <ActivityTimeline items={activityItems} loading={activitySourcesLoading || campaignsLoading} />
        </SectionCard>

        {/* Quick actions */}
        <SectionCard title="Quick Actions">
          <QuickActions />
        </SectionCard>
      </div>
    </div>
  );
}
