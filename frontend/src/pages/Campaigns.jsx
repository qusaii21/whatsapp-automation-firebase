import { useEffect, useMemo, useState } from "react";
import { onSnapshot } from "firebase/firestore";
import { useSearchParams } from "react-router-dom";
import {
  Plus,
  Search,
  X,
  ArrowLeft,
  Megaphone,
  Send,
  CheckCheck,
  Eye,
  AlertTriangle,
  Users,
  Clock,
} from "lucide-react";
import { campaignsCollection, campaignDoc, templatesCollection } from "../lib/agencyPath.js";
import { useAuth } from "../contexts/AuthContext.jsx";
import { formatDateTime, sortByRecency } from "../lib/format.js";
import { authedFetch } from "../lib/functions.js";
import CampaignRecipients from "../components/CampaignRecipients.jsx";
import CampaignLaunch from "../components/CampaignLaunch.jsx";
import CampaignActions from "../components/CampaignActions.jsx";

/**
 * CAMPAIGNS PAGE
 * ---------------------------------------------------------------------------
 * Talks to the `campaigns` collection the same way the rest of this CRM talks
 * to Firestore: read directly via onSnapshot for live list/detail views.
 * Writes are different on purpose — firestore.rules denies direct client
 * writes to `campaigns/*` (see the rules file's comment), so campaign
 * creation goes through the `createCampaign` Cloud Function instead, exactly
 * the way MessageComposer.jsx calls `sendManualMessage` rather than writing
 * to `leads/{phone}` itself for anything that needs server-side validation.
 *
 * Scope of this page (deliberately, per the current build phase):
 *   - Campaign list
 *   - Campaign details (read-only status/counters)
 *   - Create campaign (always lands in "draft" — the backend enforces this)
 *   - Recipient management (see components/CampaignRecipients.jsx) — adding
 *     recipients via paste/CSV/CRM-select, plus a read-only recipient list.
 * NOT implemented yet: launching/sending a campaign, audience-filter
 * querying, delivery tracking business logic (opt-in / 24h window
 * computation). See CampaignRecipients.jsx for exactly what's foundation-only
 * there.
 */

// Campaign "type" (marketing/utility) is a separate, pre-existing field on
// the campaign document itself (see campaigns.js CAMPAIGN_TYPES) — NOT the
// same thing as a template's category. It's derived automatically from the
// chosen template's category below rather than shown as its own selector,
// so the operator only ever makes one choice (which template) instead of
// two that could disagree with each other. Authentication-category
// templates map to "utility" since the campaign schema only supports
// marketing/utility (kept as-is, not redesigned here).
function campaignTypeForTemplateCategory(category) {
  return category === "Marketing" ? "marketing" : "utility";
}

const STATUS_BADGE_CLASS = {
  draft: "badge-muted",
  queued: "badge-info",
  sending: "badge-warm",
  completed: "badge-success",
  failed: "badge-hot",
  cancelled: "badge-muted",
};

const STATUS_LABEL = {
  draft: "Draft",
  queued: "Queued",
  sending: "Sending",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_FILTERS = ["all", "draft", "queued", "sending", "completed", "failed", "cancelled"];

const EMPTY_FORM = {
  name: "",
  description: "",
  type: "marketing",
  templateCategory: "",
  templateName: "",
  templateLanguage: "",
};

// Mirrors whatsappTemplates.js's TEMPLATE_CATEGORIES exactly (duplicated by
// value, same pattern already used for propertyEnums.js / campaigns.js's
// phone validation on the client).
const TEMPLATE_CATEGORIES = ["Marketing", "Utility", "Authentication"];

const TEMPLATE_STATUS_BADGE_CLASS = {
  Approved: "badge-success",
  Pending: "badge-warm",
  Rejected: "badge-hot",
  Disabled: "badge-muted",
};

function TemplateStatusBadge({ status }) {
  return <span className={`badge ${TEMPLATE_STATUS_BADGE_CLASS[status] || "badge-muted"}`}>{status}</span>;
}

// Same shape-reading helper as Templates.jsx's getComponentParts — kept
// local (rather than a shared import) since it's a small pure function and
// pages/ already duplicates small helpers like this by value elsewhere
// (see normalizePhone/isValidPhone in CampaignRecipients.jsx).
function getTemplateComponentParts(components) {
  const list = Array.isArray(components) ? components : [];
  return {
    header: list.find((c) => c?.type === "HEADER") || null,
    body: list.find((c) => c?.type === "BODY") || null,
    footer: list.find((c) => c?.type === "FOOTER") || null,
    buttons: list.find((c) => c?.type === "BUTTONS") || null,
  };
}

function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_BADGE_CLASS[status] || "badge-muted"}`}>{STATUS_LABEL[status] || status}</span>;
}

function CampaignCard({ campaign, onOpen }) {
  return (
    <div className="campaign-card" onClick={() => onOpen(campaign.id)}>
      <div className="campaign-card-top">
        <div className="campaign-card-name-block">
          <div className="campaign-card-name">{campaign.name || "Untitled campaign"}</div>
          <div className="campaign-card-template">
            {campaign.templateName || "no template"} · {campaign.templateLanguage || "—"}
          </div>
        </div>
        <StatusBadge status={campaign.status} />
      </div>

      {campaign.description && <div className="campaign-card-desc">{campaign.description}</div>}

      <div className="campaign-card-stats">
        <span title="Total recipients">
          <Users size={12} style={{ verticalAlign: -2 }} /> {campaign.totalRecipients || 0}
        </span>
        <span title="Sent">
          <Send size={12} style={{ verticalAlign: -2 }} /> {campaign.sentCount || 0}
        </span>
        <span title="Delivered">
          <CheckCheck size={12} style={{ verticalAlign: -2 }} /> {campaign.deliveredCount || 0}
        </span>
        <span title="Read">
          <Eye size={12} style={{ verticalAlign: -2 }} /> {campaign.readCount || 0}
        </span>
        {campaign.failedCount > 0 && (
          <span className="campaign-card-stat-danger" title="Failed">
            <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> {campaign.failedCount}
          </span>
        )}
      </div>

      <div className="campaign-card-footer empty-note">
        <span className="badge badge-muted" style={{ textTransform: "capitalize" }}>
          {campaign.type}
        </span>
        <span>Created {formatDateTime(campaign.createdAt)}</span>
      </div>
    </div>
  );
}

function StatTile({ icon: Icon, label, value, tone }) {
  return (
    <div className={"campaign-stat-tile" + (tone ? ` campaign-stat-tile-${tone}` : "")}>
      <div className="campaign-stat-tile-icon">
        <Icon size={16} />
      </div>
      <div>
        <div className="campaign-stat-value">{value ?? 0}</div>
        <div className="campaign-stat-label">{label}</div>
      </div>
    </div>
  );
}

function CampaignDetail({ campaignId, onBack, onNavigate }) {
  const { agencyId } = useAuth();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!agencyId) {
      setCampaign(null);
      setLoading(true);
      return undefined;
    }
    setLoading(true);
    setNotFound(false);
    const unsubscribe = onSnapshot(
      campaignDoc(agencyId, campaignId),
      (snap) => {
        if (!snap.exists()) {
          setCampaign(null);
          setNotFound(true);
        } else {
          setCampaign({ id: snap.id, ...snap.data() });
        }
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, [agencyId, campaignId]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-sm" onClick={onBack} style={{ marginBottom: 10 }}>
            <ArrowLeft size={13} /> Back to campaigns
          </button>
          <h1>{loading ? "Loading…" : campaign?.name || "Campaign not found"}</h1>
          {campaign && (
            <div className="page-subtitle">
              {campaign.templateName} · {campaign.templateLanguage} ·{" "}
              <span style={{ textTransform: "capitalize" }}>{campaign.type}</span>
            </div>
          )}
        </div>
        {campaign && <StatusBadge status={campaign.status} />}
      </div>

      {loading && (
        <div className="card" style={{ padding: 20 }}>
          <div className="skeleton skeleton-line" style={{ width: "40%" }} />
          <div className="skeleton skeleton-line" style={{ width: "70%" }} />
        </div>
      )}

      {!loading && notFound && (
        <div className="empty-state">
          <div className="empty-state-title">This campaign doesn't exist (or was removed).</div>
        </div>
      )}

      {!loading && campaign && (
        <>
          {campaign.description && (
            <div className="card" style={{ padding: 16, marginBottom: 20 }}>
              {campaign.description}
            </div>
          )}

          <div className="campaign-stat-grid">
            <StatTile icon={Users} label="Total recipients" value={campaign.totalRecipients} />
            <StatTile icon={Clock} label="Queued" value={campaign.queuedCount} />
            <StatTile icon={Send} label="Sent" value={campaign.sentCount} />
            <StatTile icon={CheckCheck} label="Delivered" value={campaign.deliveredCount} />
            <StatTile icon={Eye} label="Read" value={campaign.readCount} />
            <StatTile icon={AlertTriangle} label="Failed" value={campaign.failedCount} tone="danger" />
          </div>

          <div className="form-section" style={{ marginTop: 24 }}>
            <div className="form-section-title">Details</div>
            <div className="panel-two-col">
              <div className="panel-field">
                <div className="panel-field-label">Template name</div>
                <div className="panel-field-value">{campaign.templateName}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Template language</div>
                <div className="panel-field-value">{campaign.templateLanguage}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Created</div>
                <div className="panel-field-value">{formatDateTime(campaign.createdAt)}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Last updated</div>
                <div className="panel-field-value">{formatDateTime(campaign.updatedAt)}</div>
              </div>
            </div>
          </div>

          <CampaignRecipients campaignId={campaignId} campaign={campaign} />

          <CampaignLaunch campaignId={campaignId} campaign={campaign} />

          <CampaignActions campaignId={campaignId} campaign={campaign} onNavigate={onNavigate} />
        </>
      )}
    </div>
  );
}

export default function Campaigns() {
  const { agencyId } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("id");

  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // Template picker data — read live from `whatsappTemplates` the same way
  // the campaign list itself is read, so newly-synced templates (or a
  // status flipping to Disabled) show up in the Create Campaign drawer
  // without a page refresh.
  const [templates, setTemplates] = useState([]);

  useEffect(() => {
    if (!agencyId) {
      setCampaigns([]);
      setLoading(true);
      return undefined;
    }
    const unsubscribe = onSnapshot(
      campaignsCollection(agencyId),
      (snapshot) => {
        setCampaigns(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, [agencyId]);

  useEffect(() => {
    if (!agencyId) {
      setTemplates([]);
      return undefined;
    }
    const unsubscribe = onSnapshot(
      templatesCollection(agencyId),
      (snapshot) => setTemplates(snapshot.docs.map((d) => ({ id: d.id, ...d.data() }))),
      () => {}
    );
    return unsubscribe;
  }, [agencyId]);

  // Deep link from the Dashboard's "Create Campaign" quick action.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      openCreateDrawer();
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Category -> Template -> Language cascade. Each level is derived from
  // the previous form selection, so the dropdowns always narrow correctly
  // even as `templates` updates live from Firestore.
  const templateNameOptions = useMemo(() => {
    if (!form.templateCategory) return [];
    const names = new Set(
      templates.filter((t) => t.category === form.templateCategory).map((t) => t.name)
    );
    return Array.from(names).sort();
  }, [templates, form.templateCategory]);

  const templateLanguageOptions = useMemo(() => {
    if (!form.templateName) return [];
    return templates
      .filter((t) => t.name === form.templateName && t.category === form.templateCategory)
      .sort((a, b) => a.language.localeCompare(b.language));
  }, [templates, form.templateName, form.templateCategory]);

  const selectedTemplate = useMemo(() => {
    return (
      templates.find(
        (t) =>
          t.category === form.templateCategory &&
          t.name === form.templateName &&
          t.language === form.templateLanguage
      ) || null
    );
  }, [templates, form.templateCategory, form.templateName, form.templateLanguage]);

  const isTemplateSelectionValid = selectedTemplate?.status === "Approved";

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortByRecency(
      campaigns.filter((c) => {
        if (term && !(c.name || "").toLowerCase().includes(term)) return false;
        if (statusFilter !== "all" && c.status !== statusFilter) return false;
        return true;
      }),
      "createdAt"
    );
  }, [campaigns, search, statusFilter]);

  function openCampaign(id) {
    setSearchParams({ id });
  }

  function backToList() {
    setSearchParams({});
  }

  function openCreateDrawer() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDrawerOpen(true);
  }

  function closeDrawer() {
    if (saving) return;
    setDrawerOpen(false);
  }

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  // Changing an upstream level of the cascade clears everything downstream
  // of it, so the form can never end up holding a Template/Language
  // combination that doesn't actually match the newly-picked Category.
  function setTemplateCategory(category) {
    setForm((f) => ({ ...f, templateCategory: category, templateName: "", templateLanguage: "" }));
  }

  function setTemplateName(name) {
    setForm((f) => ({ ...f, templateName: name, templateLanguage: "" }));
  }

  function setTemplateLanguage(language) {
    setForm((f) => ({ ...f, templateLanguage: language }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isTemplateSelectionValid) {
      setFormError("Pick an Approved template (category, name, and language) before saving.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const res = await authedFetch("/createCampaign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          description: form.description.trim(),
          type: campaignTypeForTemplateCategory(form.templateCategory),
          templateName: form.templateName.trim(),
          templateLanguage: form.templateLanguage.trim(),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't create campaign (${res.status})`);
      }
      setDrawerOpen(false);
      setForm(EMPTY_FORM);
    } catch (err) {
      console.error("Campaigns: create failed", err);
      setFormError(err.message || "Couldn't create that campaign. Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (selectedId) {
    return <CampaignDetail campaignId={selectedId} onBack={backToList} onNavigate={openCampaign} />;
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Campaigns</h1>
          <div className="page-subtitle">
            {campaigns.length} campaign{campaigns.length === 1 ? "" : "s"} · WhatsApp template broadcasts
          </div>
        </div>
        <button className="btn btn-primary" onClick={openCreateDrawer}>
          <Plus size={15} /> New campaign
        </button>
      </div>

      <div className="campaigns-toolbar">
        <div className="conv-search">
          <Search size={14} />
          <input
            type="text"
            placeholder="Search campaigns by name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              className={"chip" + (statusFilter === s ? " chip-active" : "")}
              onClick={() => setStatusFilter(s)}
            >
              {s === "all" ? "All" : STATUS_LABEL[s]}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="campaigns-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="campaign-card">
              <div className="skeleton skeleton-line" style={{ width: "55%" }} />
              <div className="skeleton skeleton-line" style={{ width: "80%" }} />
              <div className="skeleton skeleton-line" style={{ width: "40%" }} />
            </div>
          ))}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          <Megaphone size={28} style={{ marginBottom: 8, color: "var(--ink-faint)" }} />
          <div className="empty-state-title">
            {campaigns.length === 0 ? "No campaigns yet" : "No campaigns match this filter"}
          </div>
          <div className="empty-note">Create a campaign to get started — it'll be saved as a draft.</div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="campaigns-grid">
          {filtered.map((c) => (
            <CampaignCard key={c.id} campaign={c} onOpen={openCampaign} />
          ))}
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="drawer-overlay" onClick={closeDrawer} />
          <form className="drawer" onSubmit={handleSubmit}>
            <div className="drawer-header">
              <strong>New campaign</strong>
              <button type="button" className="btn btn-icon btn-ghost" onClick={closeDrawer}>
                <X size={16} />
              </button>
            </div>

            <div className="drawer-body">
              {formError && <div className="chat-composer-error">{formError}</div>}

              <div className="form-section">
                <div className="form-section-title">Campaign basics</div>
                <div className="form-grid">
                  <label className="form-full-width">
                    <span className="field-label">Campaign name</span>
                    <input
                      className="input"
                      required
                      placeholder="e.g. Diwali 2BHK Offer"
                      value={form.name}
                      onChange={(e) => set("name", e.target.value)}
                    />
                  </label>
                  <label className="form-full-width">
                    <span className="field-label">Description</span>
                    <textarea
                      className="textarea"
                      rows={3}
                      placeholder="Optional — what this campaign is for"
                      value={form.description}
                      onChange={(e) => set("description", e.target.value)}
                    />
                  </label>
                </div>
              </div>

              <div className="form-section" style={{ marginBottom: 0 }}>
                <div className="form-section-title">WhatsApp template</div>
                <div className="form-grid">
                  <label>
                    <span className="field-label">Category</span>
                    <select
                      className="select"
                      required
                      value={form.templateCategory}
                      onChange={(e) => setTemplateCategory(e.target.value)}
                    >
                      <option value="" disabled>
                        Select a category
                      </option>
                      {TEMPLATE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    <span className="field-label">Template</span>
                    <select
                      className="select"
                      required
                      disabled={!form.templateCategory}
                      value={form.templateName}
                      onChange={(e) => setTemplateName(e.target.value)}
                    >
                      <option value="" disabled>
                        {form.templateCategory ? "Select a template" : "Pick a category first"}
                      </option>
                      {templateNameOptions.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {form.templateCategory && templateNameOptions.length === 0 && (
                      <span className="empty-note">
                        No templates in this category yet — try Sync Templates on the Templates page.
                      </span>
                    )}
                  </label>

                  <label className="form-full-width">
                    <span className="field-label">Language</span>
                    <select
                      className="select"
                      required
                      disabled={!form.templateName}
                      value={form.templateLanguage}
                      onChange={(e) => setTemplateLanguage(e.target.value)}
                    >
                      <option value="" disabled>
                        {form.templateName ? "Select a language" : "Pick a template first"}
                      </option>
                      {templateLanguageOptions.map((t) => (
                        <option key={t.id} value={t.language} disabled={t.status !== "Approved"}>
                          {t.language} — {t.status}
                          {t.status !== "Approved" ? " (not selectable)" : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {selectedTemplate && (
                  <div className="panel-two-col" style={{ marginTop: 14 }}>
                    <div className="panel-field">
                      <div className="panel-field-label">Status</div>
                      <div className="panel-field-value">
                        <TemplateStatusBadge status={selectedTemplate.status} />
                      </div>
                    </div>
                    <div className="panel-field">
                      <div className="panel-field-label">Variables</div>
                      <div className="panel-field-value">
                        {Array.isArray(selectedTemplate.variables) && selectedTemplate.variables.length > 0
                          ? selectedTemplate.variables.map((v) => `{{${v}}}`).join(", ")
                          : "None"}
                      </div>
                    </div>
                    {(() => {
                      const { header, body, footer, buttons } = getTemplateComponentParts(
                        selectedTemplate.components
                      );
                      return (
                        <>
                          {header && (
                            <div className="panel-field form-full-width">
                              <div className="panel-field-label">Header ({header.format || "TEXT"})</div>
                              <div className="panel-field-value">{header.text || "—"}</div>
                            </div>
                          )}
                          <div className="panel-field form-full-width">
                            <div className="panel-field-label">Body preview</div>
                            <div className="panel-field-value" style={{ whiteSpace: "pre-wrap" }}>
                              {body?.text || "—"}
                            </div>
                          </div>
                          {footer && (
                            <div className="panel-field form-full-width">
                              <div className="panel-field-label">Footer preview</div>
                              <div className="panel-field-value">{footer.text || "—"}</div>
                            </div>
                          )}
                          {buttons && Array.isArray(buttons.buttons) && buttons.buttons.length > 0 && (
                            <div className="panel-field form-full-width">
                              <div className="panel-field-label">Buttons</div>
                              <div className="panel-tag-row">
                                {buttons.buttons.map((b, i) => (
                                  <span key={i} className="badge badge-muted">
                                    {b.text || b.type}
                                  </span>
                                ))}
                              </div>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>

            <div className="drawer-footer">
              <button type="button" className="btn" onClick={closeDrawer} disabled={saving}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || !isTemplateSelectionValid}>
                {saving ? "Saving..." : "Save as draft"}
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
