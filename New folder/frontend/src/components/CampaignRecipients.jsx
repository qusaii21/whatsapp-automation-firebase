import { useEffect, useMemo, useRef, useState } from "react";
import { collection, onSnapshot } from "firebase/firestore";
import { ClipboardPaste, FileUp, Users, SlidersHorizontal, Search, Upload } from "lucide-react";
import { db } from "../firebase.js";
import { functionsBaseUrl } from "../lib/functions.js";
import { formatDateTime, sortByRecency } from "../lib/format.js";
import { PROPERTY_TYPES } from "../constants/propertyEnums.js";

/**
 * CAMPAIGN RECIPIENTS
 * ---------------------------------------------------------------------------
 * Recipient-management-only slice of the Campaign feature. Everything here
 * is a thin client for the existing `addCampaignRecipients` Cloud Function
 * and the `campaigns/{id}/recipients` subcollection — no sending, no Cloud
 * Tasks, no Meta API calls, no analytics. See campaigns.js on the backend
 * for the dedup/validation/counter logic this UI triggers.
 *
 * Four ways to build up a recipient list (tabs below), all funneling into
 * the same addRecipients() -> addCampaignRecipients call:
 *   1. Paste Numbers   — one phone per line
 *   2. CSV Upload      — phone[,name] columns, previewed before adding
 *   3. CRM Customers   — multi-select existing `leads`
 *   4. Audience Filters — UI-only placeholder for a future querying phase
 *
 * Eligibility indicators (Opted In/Out, 24-hour Window) intentionally only
 * *read* fields that may or may not exist yet on a recipient doc — no
 * opt-in/window business logic is computed here. If a future phase starts
 * writing `optedIn` (boolean) and `windowStatus` ("inside" | "outside") onto
 * recipient docs, these indicators will pick them up automatically.
 */

// Mirrors functions/src/campaigns.js's normalizePhone/isValidPhone exactly
// (digits only, 7-15 length) so the client can dedupe/preview before
// submitting. The backend re-validates and re-normalizes independently —
// this is a client-side courtesy, not the source of truth. Same
// duplicated-by-value pattern already used for propertyEnums.js.
function normalizePhone(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[^\d]/g, "");
}

function isValidPhone(phone) {
  return /^\d{7,15}$/.test(phone);
}

const RECIPIENT_STATUS_BADGE_CLASS = {
  pending: "badge-muted",
  queued: "badge-info",
  sent: "badge-warm",
  delivered: "badge-cold",
  read: "badge-success",
  failed: "badge-hot",
};

const RECIPIENT_STATUS_LABEL = {
  pending: "Pending",
  queued: "Queued",
  sent: "Sent",
  delivered: "Delivered",
  read: "Read",
  failed: "Failed",
};

const LEAD_SOURCE_OPTIONS = ["All", "Meta Ads", "Website", "Manual", "Referral"];
const OPPORTUNITY_STATUS_OPTIONS = ["Active", "Closed"];
const INTEREST_LEVEL_OPTIONS = ["Hot", "Warm", "Cold"];

const TABS = [
  { key: "paste", label: "Paste Numbers", icon: ClipboardPaste },
  { key: "csv", label: "CSV Upload", icon: FileUp },
  { key: "crm", label: "CRM Customers", icon: Users },
  { key: "filters", label: "Audience Filters", icon: SlidersHorizontal },
];

function RecipientStatusBadge({ status }) {
  return (
    <span className={`badge ${RECIPIENT_STATUS_BADGE_CLASS[status] || "badge-muted"}`}>
      {RECIPIENT_STATUS_LABEL[status] || status}
    </span>
  );
}

// Reads an existing field if present; renders "Unknown" rather than
// inferring/computing anything. See file header note above.
function OptInBadge({ recipient }) {
  if (recipient.optedIn === true) return <span className="badge badge-success">Opted In</span>;
  if (recipient.optedIn === false) return <span className="badge badge-hot">Opted Out</span>;
  return <span className="badge badge-muted">Unknown</span>;
}

function WindowBadge({ recipient }) {
  const status = recipient.windowStatus;
  if (status === "inside") return <span className="badge badge-success">Inside Window</span>;
  if (status === "outside") return <span className="badge badge-warm">Outside Window</span>;
  return <span className="badge badge-muted">Unknown</span>;
}

// -----------------------------------------------------------------------
// Toast — no toast primitive exists elsewhere in this CRM yet, so this is a
// small self-contained one built from the same design tokens/badge-adjacent
// styling as the rest of the app (see .recipients-toast in index.css).
// -----------------------------------------------------------------------
function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className={`recipients-toast recipients-toast-${toast.type}`} role="status">
      <span>{toast.message}</span>
      <button type="button" className="recipients-toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

function summarizeResult(result) {
  const parts = [`${result.added} added`];
  if (result.skippedDuplicates) parts.push(`${result.skippedDuplicates} duplicate${result.skippedDuplicates === 1 ? "" : "s"} skipped`);
  if (result.skippedInvalid) parts.push(`${result.skippedInvalid} invalid skipped`);
  return parts.join(", ");
}

// --- Tab 1: Paste Numbers ---------------------------------------------------

function PasteNumbersTab({ onSubmit, submitting, existingPhones }) {
  const [text, setText] = useState("");

  const parsed = useMemo(() => {
    const lines = text.split(/\r\n|\n/).map((l) => l.trim()).filter(Boolean);
    const seen = new Set();
    let invalid = 0;
    let alreadyInCampaign = 0;
    const valid = [];
    for (const line of lines) {
      const phone = normalizePhone(line);
      if (!isValidPhone(phone)) {
        invalid += 1;
        continue;
      }
      if (seen.has(phone)) continue;
      seen.add(phone);
      if (existingPhones.has(phone)) {
        alreadyInCampaign += 1;
        continue;
      }
      valid.push(phone);
    }
    return { total: lines.length, valid, invalid, alreadyInCampaign };
  }, [text, existingPhones]);

  async function handleAdd() {
    if (parsed.valid.length === 0) return;
    await onSubmit(parsed.valid.map((phone) => ({ phone })));
    setText("");
  }

  return (
    <div className="recipients-tab-panel">
      <label className="form-full-width">
        <span className="field-label">Phone numbers (one per line)</span>
        <textarea
          className="textarea"
          rows={7}
          placeholder={"919876543210\n919999999999"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {text.trim() && (
        <div className="empty-note" style={{ marginTop: 6 }}>
          {parsed.valid.length} ready to add
          {parsed.invalid > 0 ? `, ${parsed.invalid} invalid` : ""}
          {parsed.alreadyInCampaign > 0 ? `, ${parsed.alreadyInCampaign} already in this campaign` : ""}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting || parsed.valid.length === 0}
          onClick={handleAdd}
        >
          {submitting ? "Adding..." : "Add Recipients"}
        </button>
      </div>
    </div>
  );
}

// --- Tab 2: CSV Upload -------------------------------------------------------

function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { error: "That file looks empty." };

  const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const phoneIdx = headers.indexOf("phone");
  const nameIdx = headers.indexOf("name");
  if (phoneIdx === -1) {
    return { error: "CSV must have a 'phone' column." };
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const phone = cells[phoneIdx] || "";
    const name = nameIdx !== -1 ? cells[nameIdx] || "" : "";
    if (!phone) continue;
    rows.push({ phone, name });
  }
  return { rows };
}

function CsvUploadTab({ onSubmit, submitting, existingPhones }) {
  const [fileName, setFileName] = useState(null);
  const [rawRows, setRawRows] = useState([]);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);

  const preview = useMemo(() => {
    const seen = new Set();
    let invalid = 0;
    let alreadyInCampaign = 0;
    const valid = [];
    for (const row of rawRows) {
      const phone = normalizePhone(row.phone);
      if (!isValidPhone(phone)) {
        invalid += 1;
        continue;
      }
      if (seen.has(phone)) continue;
      seen.add(phone);
      if (existingPhones.has(phone)) {
        alreadyInCampaign += 1;
        continue;
      }
      valid.push({ phone, name: row.name || "" });
    }
    return { valid, invalid, alreadyInCampaign };
  }, [rawRows, existingPhones]);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const { rows, error: parseError } = parseCsv(String(reader.result || ""));
      if (parseError) {
        setError(parseError);
        setRawRows([]);
        return;
      }
      setRawRows(rows);
    };
    reader.onerror = () => setError("Couldn't read that file.");
    reader.readAsText(file);
  }

  async function handleAdd() {
    if (preview.valid.length === 0) return;
    await onSubmit(preview.valid.map((r) => ({ phone: r.phone })));
    setRawRows([]);
    setFileName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <div className="recipients-tab-panel">
      <div className="csv-upload-drop">
        <Upload size={18} />
        <div>
          <div style={{ fontWeight: 600, fontSize: 13 }}>{fileName || "Choose a CSV file"}</div>
          <div className="empty-note">Columns: phone (required), name (optional). Other columns are ignored.</div>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => fileInputRef.current?.click()}>
          Browse
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          onChange={handleFile}
          style={{ display: "none" }}
        />
      </div>

      {error && <div className="chat-composer-error" style={{ position: "static", marginTop: 10 }}>{error}</div>}

      {rawRows.length > 0 && !error && (
        <>
          <div className="empty-note" style={{ margin: "12px 0 6px" }}>
            {preview.valid.length} ready to add
            {preview.invalid > 0 ? `, ${preview.invalid} invalid` : ""}
            {preview.alreadyInCampaign > 0 ? `, ${preview.alreadyInCampaign} already in this campaign` : ""}
          </div>
          <div className="table-wrap" style={{ maxHeight: 260, overflowY: "auto" }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
                {preview.valid.map((r) => (
                  <tr key={r.phone}>
                    <td>{r.name || <span className="empty-note">—</span>}</td>
                    <td>{r.phone}</td>
                  </tr>
                ))}
                {preview.valid.length === 0 && (
                  <tr>
                    <td colSpan={2} className="empty-note">
                      Nothing valid to preview.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting || preview.valid.length === 0}
          onClick={handleAdd}
        >
          {submitting ? "Adding..." : "Add Recipients"}
        </button>
      </div>
    </div>
  );
}

// --- Tab 3: CRM Customers ----------------------------------------------------

function CrmCustomersTab({ onSubmit, submitting, existingPhones }) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "leads"),
      (snapshot) => {
        setLeads(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })));
        setLoading(false);
      },
      () => setLoading(false)
    );
    return unsubscribe;
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (!term) return true;
      return (lead.name || "").toLowerCase().includes(term) || (lead.phone || "").toLowerCase().includes(term);
    });
  }, [leads, search]);

  function toggle(phone) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(phone)) next.delete(phone);
      else next.add(phone);
      return next;
    });
  }

  async function handleAdd() {
    const chosen = leads.filter((l) => selected.has(l.id));
    if (chosen.length === 0) return;
    await onSubmit(chosen.map((l) => ({ phone: l.id, leadId: l.id })));
    setSelected(new Set());
  }

  return (
    <div className="recipients-tab-panel">
      <div className="conv-search" style={{ maxWidth: 340 }}>
        <Search size={14} />
        <input
          type="text"
          placeholder="Search by name or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="table-wrap" style={{ marginTop: 12, maxHeight: 320, overflowY: "auto" }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}></th>
              <th>Name</th>
              <th>Phone</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="empty-note">
                  Loading customers…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="empty-note">
                  No CRM customers match this search.
                </td>
              </tr>
            )}
            {!loading &&
              filtered.map((lead) => {
                const normalized = normalizePhone(lead.phone || lead.id);
                const alreadyAdded = existingPhones.has(normalized);
                return (
                  <tr key={lead.id} style={alreadyAdded ? { opacity: 0.55 } : undefined}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        disabled={alreadyAdded}
                        onChange={() => toggle(lead.id)}
                      />
                    </td>
                    <td>{lead.name || <span className="empty-note">Unnamed lead</span>}</td>
                    <td>{lead.phone || lead.id}</td>
                    <td>
                      {alreadyAdded ? (
                        <span className="badge badge-muted">Already added</span>
                      ) : (
                        lead.source || <span className="empty-note">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={submitting || selected.size === 0} onClick={handleAdd}>
          {submitting ? "Adding..." : `Add Selected${selected.size ? ` (${selected.size})` : ""}`}
        </button>
      </div>
    </div>
  );
}

// --- Tab 4: Audience Filters (foundation only) -------------------------------

function AudienceFiltersTab() {
  return (
    <div className="recipients-tab-panel">
      <div className="empty-note" style={{ marginBottom: 14 }}>
        Audience filtering is coming in a later phase. These controls are placeholders and don't do anything yet.
      </div>
      <div className="form-grid">
        <label>
          <span className="field-label">Lead source</span>
          <select className="select" disabled defaultValue="All">
            {LEAD_SOURCE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Opportunity status</span>
          <select className="select" disabled defaultValue="">
            <option value="" disabled>
              Any status
            </option>
            {OPPORTUNITY_STATUS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Interest level</span>
          <select className="select" disabled defaultValue="">
            <option value="" disabled>
              Any level
            </option>
            {INTEREST_LEVEL_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Property type</span>
          <select className="select" disabled defaultValue="">
            <option value="" disabled>
              Any type
            </option>
            {PROPERTY_TYPES.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}

// --- Recipient list -----------------------------------------------------

function RecipientList({ recipients, leadsByPhone, loading }) {
  if (loading) {
    return (
      <div className="card" style={{ padding: 20, marginTop: 16 }}>
        <div className="skeleton skeleton-line" style={{ width: "40%" }} />
        <div className="skeleton skeleton-line" style={{ width: "70%" }} />
      </div>
    );
  }

  if (recipients.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "28px 20px" }}>
        <div className="empty-state-title">No recipients yet</div>
        <div className="empty-note">Use the tabs above to add recipients to this draft campaign.</div>
      </div>
    );
  }

  return (
    <div className="table-wrap" style={{ marginTop: 16 }}>
      <table className="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Status</th>
            <th>Opt-in</th>
            <th>24-hour Window</th>
            <th>Added At</th>
          </tr>
        </thead>
        <tbody>
          {recipients.map((r) => {
            const lead = leadsByPhone.get(r.id);
            return (
              <tr key={r.id}>
                <td>{lead?.name || <span className="empty-note">—</span>}</td>
                <td>{r.phone}</td>
                <td>
                  <RecipientStatusBadge status={r.status} />
                </td>
                <td>
                  <OptInBadge recipient={r} />
                </td>
                <td>
                  <WindowBadge recipient={r} />
                </td>
                <td>{formatDateTime(r.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Main component -----------------------------------------------------

export default function CampaignRecipients({ campaignId, campaign }) {
  const [activeTab, setActiveTab] = useState("paste");
  const [recipients, setRecipients] = useState([]);
  const [loadingRecipients, setLoadingRecipients] = useState(true);
  const [leadsByPhone, setLeadsByPhone] = useState(new Map());
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);

  const isDraft = campaign?.status === "draft";

  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "campaigns", campaignId, "recipients"),
      (snapshot) => {
        setRecipients(sortByRecency(snapshot.docs.map((d) => ({ id: d.id, ...d.data() })), "createdAt"));
        setLoadingRecipients(false);
      },
      () => setLoadingRecipients(false)
    );
    return unsubscribe;
  }, [campaignId]);

  // Only needed to show a name next to a phone number in the recipient list
  // (recipient docs don't store a name). Reuses the same `leads` collection
  // the CRM Customers tab already reads.
  useEffect(() => {
    const unsubscribe = onSnapshot(
      collection(db, "leads"),
      (snapshot) => {
        const map = new Map();
        snapshot.docs.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }));
        setLeadsByPhone(map);
      },
      () => {}
    );
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const existingPhones = useMemo(() => new Set(recipients.map((r) => r.id)), [recipients]);

  async function addRecipients(list) {
    setSubmitting(true);
    try {
      const res = await fetch(`${functionsBaseUrl()}/addCampaignRecipients`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ campaignId, recipients: list }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Couldn't add recipients (${res.status})`);
      }
      setToast({ type: "success", message: `Added recipients — ${summarizeResult(body)}.` });
    } catch (err) {
      console.error("CampaignRecipients: addRecipients failed", err);
      setToast({ type: "error", message: err.message || "Couldn't add those recipients. Try again." });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="form-section" style={{ marginTop: 24 }}>
      <div className="form-section-title">Recipients</div>

      {!isDraft && (
        <div className="empty-note" style={{ marginBottom: 12 }}>
          This campaign is no longer a draft, so its recipient list is locked — recipients can only be added while a
          campaign is in draft.
        </div>
      )}

      {isDraft && (
        <>
          <div className="recipients-tabs">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.key}
                  type="button"
                  className={"chip" + (activeTab === tab.key ? " chip-active" : "")}
                  onClick={() => setActiveTab(tab.key)}
                >
                  <Icon size={13} /> {tab.label}
                </button>
              );
            })}
          </div>

          <div className="card recipients-tab-card">
            {activeTab === "paste" && (
              <PasteNumbersTab onSubmit={addRecipients} submitting={submitting} existingPhones={existingPhones} />
            )}
            {activeTab === "csv" && (
              <CsvUploadTab onSubmit={addRecipients} submitting={submitting} existingPhones={existingPhones} />
            )}
            {activeTab === "crm" && (
              <CrmCustomersTab onSubmit={addRecipients} submitting={submitting} existingPhones={existingPhones} />
            )}
            {activeTab === "filters" && <AudienceFiltersTab />}
          </div>
        </>
      )}

      <RecipientList recipients={recipients} leadsByPhone={leadsByPhone} loading={loadingRecipients} />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
