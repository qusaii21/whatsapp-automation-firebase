import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { collection, doc, onSnapshot, updateDoc } from "firebase/firestore";
import {
  FileText, RefreshCw, Search, X, Plus, ChevronDown, ChevronUp,
  AlertCircle, Phone, ExternalLink, Copy, MessageSquare, RotateCcw,
  Info, GripVertical, Trash2, CheckCircle,
} from "lucide-react";
import { db } from "../firebase.js";
import { formatDateTime, sortByRecency } from "../lib/format.js";
import { functionsBaseUrl } from "../lib/functions.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const STATUS_BADGE_CLASS = {
  Approved:  "badge-success",
  Pending:   "badge-warm",
  Rejected:  "badge-hot",
  Disabled:  "badge-muted",
  Paused:    "badge-warm",
  InAppeal:  "badge-info",
};

const QUALITY_BADGE_CLASS = {
  GREEN:   "badge-success",
  YELLOW:  "badge-warm",
  RED:     "badge-hot",
  UNKNOWN: "badge-muted",
};

const STATUS_FILTERS   = ["All", "Approved", "Pending", "Rejected", "Disabled", "Paused", "InAppeal"];
const CATEGORY_FILTERS = ["All", "Marketing", "Utility", "Authentication"];

// Comprehensive WhatsApp language codes
const LANGUAGES = [
  { code: "af",    label: "Afrikaans" },
  { code: "sq",    label: "Albanian" },
  { code: "ar",    label: "Arabic" },
  { code: "az",    label: "Azerbaijani" },
  { code: "bn",    label: "Bengali" },
  { code: "bg",    label: "Bulgarian" },
  { code: "ca",    label: "Catalan" },
  { code: "zh_CN", label: "Chinese (Simplified)" },
  { code: "zh_TW", label: "Chinese (Traditional)" },
  { code: "hr",    label: "Croatian" },
  { code: "cs",    label: "Czech" },
  { code: "da",    label: "Danish" },
  { code: "nl",    label: "Dutch" },
  { code: "en",    label: "English" },
  { code: "en_GB", label: "English (UK)" },
  { code: "en_US", label: "English (US)" },
  { code: "et",    label: "Estonian" },
  { code: "fil",   label: "Filipino" },
  { code: "fi",    label: "Finnish" },
  { code: "fr",    label: "French" },
  { code: "ka",    label: "Georgian" },
  { code: "de",    label: "German" },
  { code: "el",    label: "Greek" },
  { code: "gu",    label: "Gujarati" },
  { code: "ha",    label: "Hausa" },
  { code: "he",    label: "Hebrew" },
  { code: "hi",    label: "Hindi" },
  { code: "hu",    label: "Hungarian" },
  { code: "id",    label: "Indonesian" },
  { code: "ga",    label: "Irish" },
  { code: "it",    label: "Italian" },
  { code: "ja",    label: "Japanese" },
  { code: "kn",    label: "Kannada" },
  { code: "kk",    label: "Kazakh" },
  { code: "ko",    label: "Korean" },
  { code: "lo",    label: "Lao" },
  { code: "lv",    label: "Latvian" },
  { code: "lt",    label: "Lithuanian" },
  { code: "mk",    label: "Macedonian" },
  { code: "ms",    label: "Malay" },
  { code: "ml",    label: "Malayalam" },
  { code: "mr",    label: "Marathi" },
  { code: "nb",    label: "Norwegian" },
  { code: "fa",    label: "Persian" },
  { code: "pl",    label: "Polish" },
  { code: "pt_BR", label: "Portuguese (Brazil)" },
  { code: "pt_PT", label: "Portuguese (Portugal)" },
  { code: "pa",    label: "Punjabi" },
  { code: "ro",    label: "Romanian" },
  { code: "ru",    label: "Russian" },
  { code: "sr",    label: "Serbian" },
  { code: "sk",    label: "Slovak" },
  { code: "sl",    label: "Slovenian" },
  { code: "es",    label: "Spanish" },
  { code: "es_AR", label: "Spanish (Argentina)" },
  { code: "es_ES", label: "Spanish (Spain)" },
  { code: "es_MX", label: "Spanish (Mexico)" },
  { code: "sw",    label: "Swahili" },
  { code: "sv",    label: "Swedish" },
  { code: "ta",    label: "Tamil" },
  { code: "te",    label: "Telugu" },
  { code: "th",    label: "Thai" },
  { code: "tr",    label: "Turkish" },
  { code: "uk",    label: "Ukrainian" },
  { code: "ur",    label: "Urdu" },
  { code: "uz",    label: "Uzbek" },
  { code: "vi",    label: "Vietnamese" },
  { code: "zu",    label: "Zulu" },
];

// Button types supported by Meta's API
const BUTTON_TYPES = [
  { value: "QUICK_REPLY",   label: "Quick Reply",     icon: "↩" },
  { value: "PHONE_NUMBER",  label: "Phone Number",    icon: "📞" },
  { value: "URL",           label: "Visit Website",   icon: "🔗" },
  { value: "COPY_CODE",     label: "Copy Code",       icon: "📋" },
];

const EMPTY_FORM = {
  name: "",
  category: "MARKETING",
  language: "en_US",
  parameter_format: "positional",
  headerType: "NONE",   // NONE | TEXT | IMAGE | VIDEO | DOCUMENT | LOCATION
  headerText: "",
  headerExample: "",
  bodyText: "",
  footerText: "",
  buttons: [],
  variableMappings: {},
};

// ─── Validation ───────────────────────────────────────────────────────────────

function validateForm(form) {
  const errors = [];

  if (!form.name.trim()) {
    errors.push("Template name is required.");
  } else if (!/^[a-z0-9_]{1,512}$/.test(form.name.trim())) {
    errors.push("Name must be lowercase letters, numbers and underscores only (max 512 chars).");
  }

  if (!form.language) errors.push("Language is required.");

  if (!form.bodyText.trim()) {
    errors.push("Body text is required.");
  } else if (form.bodyText.trim().length > 1024) {
    errors.push(`Body text is too long (${form.bodyText.trim().length}/1024 chars).`);
  }

  if (form.headerType === "TEXT") {
    if (!form.headerText.trim()) {
      errors.push("Header text is required when header type is Text.");
    } else if (form.headerText.trim().length > 60) {
      errors.push(`Header text is too long (${form.headerText.trim().length}/60 chars).`);
    }
  }

  if (form.footerText.trim().length > 60) {
    errors.push(`Footer text is too long (${form.footerText.trim().length}/60 chars).`);
  }

  if (form.buttons.length > 10) {
    errors.push("Maximum 10 buttons allowed.");
  }

  // Quick reply + non-quick-reply mixing rules
  const qr = form.buttons.filter((b) => b.type === "QUICK_REPLY");
  const nonQr = form.buttons.filter((b) => b.type !== "QUICK_REPLY");
  if (qr.length > 0 && nonQr.length > 0) {
    // Valid combos: QR then non-QR, or non-QR then QR — but never interleaved
    const firstNonQrIdx = form.buttons.findIndex((b) => b.type !== "QUICK_REPLY");
    const lastQrIdx = form.buttons.map((b) => b.type).lastIndexOf("QUICK_REPLY");
    if (firstNonQrIdx < lastQrIdx) {
      errors.push(
        "Quick Reply buttons cannot be interleaved with other button types. " +
        "Group them together (all Quick Replies first or last)."
      );
    }
  }

  const phoneButtons = form.buttons.filter((b) => b.type === "PHONE_NUMBER");
  if (phoneButtons.length > 1) errors.push("Maximum 1 Phone Number button allowed.");
  const copyButtons = form.buttons.filter((b) => b.type === "COPY_CODE");
  if (copyButtons.length > 1) errors.push("Maximum 1 Copy Code button allowed.");
  const urlButtons = form.buttons.filter((b) => b.type === "URL");
  if (urlButtons.length > 2) errors.push("Maximum 2 URL buttons allowed.");

  // Per-button validation
  form.buttons.forEach((btn, i) => {
    const n = i + 1;
    if (!btn.text?.trim()) {
      if (btn.type !== "COPY_CODE") errors.push(`Button ${n}: label text is required.`);
    } else if (btn.text.trim().length > 25) {
      errors.push(`Button ${n}: label too long (max 25 chars).`);
    }
    if (btn.type === "PHONE_NUMBER" && !btn.phone_number?.trim()) {
      errors.push(`Button ${n}: phone number is required.`);
    }
    if (btn.type === "URL" && !btn.url?.trim()) {
      errors.push(`Button ${n}: URL is required.`);
    }
    if (btn.type === "COPY_CODE" && !btn.example?.trim()) {
      errors.push(`Button ${n}: example code is required.`);
    }
  });

  // Positional variable numbering
  if (form.parameter_format === "positional") {
    const bodyVars = extractPositionalVars(form.bodyText);
    const seq = [...bodyVars].sort((a, b) => a - b);
    for (let i = 0; i < seq.length; i++) {
      if (seq[i] !== i + 1) {
        errors.push(`Body variables must be sequential: {{1}}, {{2}}, … Got {{${seq[i]}}} out of order.`);
        break;
      }
    }
  }

  return errors;
}

function extractPositionalVars(text) {
  const nums = new Set();
  const re = /\{\{(\d+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) nums.add(Number(m[1]));
  return nums;
}

function extractAllVars(text) {
  const vars = [];
  const re = /\{\{([^}]+)\}\}/g;
  let m;
  while ((m = re.exec(text)) !== null) vars.push(m[1].trim());
  return vars;
}

function collectAllVariables(form) {
  const seen = new Set();
  const result = [];
  const add = (v) => { if (!seen.has(v)) { seen.add(v); result.push(v); } };
  extractAllVars(form.headerText).forEach(add);
  extractAllVars(form.bodyText).forEach(add);
  extractAllVars(form.footerText).forEach(add);
  form.buttons.forEach((btn) => {
    extractAllVars(btn.text || "").forEach(add);
    extractAllVars(btn.url  || "").forEach(add);
  });
  return result;
}

// ─── Payload builder ──────────────────────────────────────────────────────────

function buildComponentsPayload(form) {
  const components = [];

  // HEADER
  if (form.headerType === "TEXT" && form.headerText.trim()) {
    const headerVars = extractAllVars(form.headerText);
    const headerComp = {
      type: "HEADER",
      format: "TEXT",
      text: form.headerText.trim(),
    };
    if (headerVars.length > 0) {
      const exampleFor = (v) => {
        const label = form.variableMappings?.[v];
        if (label && label.trim()) return label.trim();
        return `Sample ${v}`;
      };
      if (form.parameter_format === "named") {
        headerComp.example = {
          header_text_named_params: headerVars.map((v) => ({
            param_name: v,
            example: exampleFor(v),
          })),
        };
      } else {
        // Header supports only 1 variable
        headerComp.example = {
          header_text: [exampleFor(headerVars[0])],
        };
      }
    }
    components.push(headerComp);
  } else if (["IMAGE", "VIDEO", "DOCUMENT"].includes(form.headerType)) {
    // Media header — handle is provided by the user (mediaHandle field)
    components.push({
      type: "HEADER",
      format: form.headerType,
      example: { header_handle: [form.mediaHandle || ""] },
    });
  } else if (form.headerType === "LOCATION") {
    components.push({ type: "HEADER", format: "LOCATION" });
  }

  // BODY (required)
  if (form.bodyText.trim()) {
    const bodyVars = extractAllVars(form.bodyText);
    // De-duplicate while preserving order
    const uniqueBodyVars = [...new Set(bodyVars)];
    const bodyComp = { type: "BODY", text: form.bodyText.trim() };
    if (uniqueBodyVars.length > 0) {
      // exampleFor: returns a non-empty sample string for Meta review.
      // Uses the CRM label if set (e.g. "Customer Name"), otherwise a
      // generic "Sample N" — never a bracketed placeholder like "[1]"
      // which Meta rejects with error 100.
      const exampleFor = (v) => {
        const label = form.variableMappings?.[v];
        if (label && label.trim()) return label.trim();
        return `Sample ${v}`;
      };
      if (form.parameter_format === "named") {
        bodyComp.example = {
          body_text_named_params: uniqueBodyVars.map((v) => ({
            param_name: v,
            example: exampleFor(v),
          })),
        };
      } else {
        // Positional: Meta expects body_text as [[val1, val2, ...]]
        const sortedVars = uniqueBodyVars.sort((a, b) => Number(a) - Number(b));
        bodyComp.example = {
          body_text: [sortedVars.map((v) => exampleFor(v))],
        };
      }
    }
    components.push(bodyComp);
  }

  // FOOTER
  if (form.footerText.trim()) {
    components.push({ type: "FOOTER", text: form.footerText.trim() });
  }

  // BUTTONS
  if (form.buttons.length > 0) {
    const buttons = form.buttons.map((btn) => {
      if (btn.type === "QUICK_REPLY")  return { type: "QUICK_REPLY", text: btn.text };
      if (btn.type === "PHONE_NUMBER") return { type: "PHONE_NUMBER", text: btn.text, phone_number: btn.phone_number };
      if (btn.type === "URL") return { type: "URL", text: btn.text, url: btn.url, ...(btn.url?.includes("{{") ? { example: [btn.urlExample || "example-value"] } : {}) };
      if (btn.type === "COPY_CODE")    return { type: "COPY_CODE", example: btn.example };
      return btn;
    });
    components.push({ type: "BUTTONS", buttons });
  }

  return components;
}

// ─── Shared small components ──────────────────────────────────────────────────

function StatusBadge({ status }) {
  return (
    <span className={`badge ${STATUS_BADGE_CLASS[status] || "badge-muted"}`}>
      {status}
    </span>
  );
}

function QualityBadge({ score }) {
  if (!score || score === "UNKNOWN") return null;
  return (
    <span className={`badge ${QUALITY_BADGE_CLASS[score] || "badge-muted"}`} title="Quality score">
      {score}
    </span>
  );
}

function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className={`recipients-toast recipients-toast-${toast.type}`} role="status">
      <span>{toast.message}</span>
      <button type="button" className="recipients-toast-close" onClick={onDismiss} aria-label="Dismiss">×</button>
    </div>
  );
}

function getComponentParts(components) {
  const list = Array.isArray(components) ? components : [];
  return {
    header:  list.find((c) => c?.type === "HEADER")  || null,
    body:    list.find((c) => c?.type === "BODY")    || null,
    footer:  list.find((c) => c?.type === "FOOTER")  || null,
    buttons: list.find((c) => c?.type === "BUTTONS") || null,
  };
}

function summarizeSyncResult(result) {
  return `${result.added} added, ${result.updated} updated, ${result.disabled} disabled · ${(result.durationMs / 1000).toFixed(1)}s`;
}

// ─── WhatsApp Live Preview ────────────────────────────────────────────────────

function highlightVars(text) {
  if (!text) return null;
  const parts = text.split(/(\{\{[^}]+\}\})/g);
  return parts.map((part, i) =>
    /^\{\{[^}]+\}\}$/.test(part)
      ? <mark key={i} className="tpl-var-highlight">{part}</mark>
      : part
  );
}

function WhatsAppPreview({ form }) {
  const allVars = collectAllVariables(form);
  const hasHeader  = form.headerType !== "NONE";
  const hasBody    = !!form.bodyText.trim();
  const hasFooter  = !!form.footerText.trim();
  const hasButtons = form.buttons.length > 0;

  return (
    <div className="wa-preview-shell">
      <div className="wa-preview-phone">
        <div className="wa-preview-screen">
          <div className="wa-preview-chat-bg">
            <div className="wa-bubble-wrap">
              <div className="wa-bubble">
                {/* Header */}
                {hasHeader && (
                  <div className="wa-bubble-header">
                    {form.headerType === "TEXT" && (
                      <span className="wa-bubble-header-text">{highlightVars(form.headerText) || <em className="wa-placeholder">Header text</em>}</span>
                    )}
                    {form.headerType === "IMAGE" && (
                      <div className="wa-media-placeholder wa-media-image">🖼 Image</div>
                    )}
                    {form.headerType === "VIDEO" && (
                      <div className="wa-media-placeholder wa-media-video">▶ Video</div>
                    )}
                    {form.headerType === "DOCUMENT" && (
                      <div className="wa-media-placeholder wa-media-doc">📄 Document</div>
                    )}
                    {form.headerType === "LOCATION" && (
                      <div className="wa-media-placeholder wa-media-location">📍 Location</div>
                    )}
                  </div>
                )}

                {/* Body */}
                <div className="wa-bubble-body">
                  {hasBody
                    ? <span style={{ whiteSpace: "pre-wrap" }}>{highlightVars(form.bodyText)}</span>
                    : <em className="wa-placeholder">Body text will appear here…</em>
                  }
                </div>

                {/* Footer */}
                {hasFooter && (
                  <div className="wa-bubble-footer">{form.footerText}</div>
                )}

                {/* Timestamp */}
                <div className="wa-bubble-meta">
                  <span>10:42</span>
                  <span className="wa-tick">✓✓</span>
                </div>
              </div>

              {/* Buttons */}
              {hasButtons && (
                <div className="wa-buttons">
                  {form.buttons.slice(0, 3).map((btn, i) => (
                    <div key={i} className="wa-button">
                      {btn.type === "PHONE_NUMBER" && <Phone size={12} />}
                      {btn.type === "URL"          && <ExternalLink size={12} />}
                      {btn.type === "COPY_CODE"    && <Copy size={12} />}
                      {btn.type === "QUICK_REPLY"  && <MessageSquare size={12} />}
                      <span>{btn.text || <em className="wa-placeholder">Button label</em>}</span>
                    </div>
                  ))}
                  {form.buttons.length > 3 && (
                    <div className="wa-button wa-button-more">
                      See all options ({form.buttons.length - 3} more)
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Variable mapping panel */}
      {allVars.length > 0 && (
        <div className="tpl-var-map-panel">
          <div className="form-section-title" style={{ marginBottom: 8 }}>Variable labels (CRM-only)</div>
          <div className="empty-note" style={{ marginBottom: 10, fontSize: 11.5 }}>
            Labels are stored in your CRM for campaign personalisation. They are not sent to Meta.
          </div>
          {allVars.map((v) => (
            <div key={v} className="tpl-var-row">
              <span className="badge badge-info" style={{ minWidth: 48, justifyContent: "center" }}>
                {`{{${v}}}`}
              </span>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder={`Label for {{${v}}} e.g. "Customer Name"`}
                value={form.variableMappings?.[v] || ""}
                onChange={(e) => {
                  form._onVarMapping?.(v, e.target.value);
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Button editor ────────────────────────────────────────────────────────────

function ButtonEditor({ buttons, onChange }) {
  function addButton() {
    if (buttons.length >= 10) return;
    onChange([...buttons, { type: "QUICK_REPLY", text: "", _id: Date.now() }]);
  }

  function removeButton(idx) {
    onChange(buttons.filter((_, i) => i !== idx));
  }

  function updateButton(idx, patch) {
    onChange(buttons.map((b, i) => i === idx ? { ...b, ...patch } : b));
  }

  function moveButton(idx, dir) {
    const next = [...buttons];
    const swap = idx + dir;
    if (swap < 0 || swap >= next.length) return;
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onChange(next);
  }

  return (
    <div className="tpl-btn-editor">
      {buttons.map((btn, i) => (
        <div key={btn._id || i} className="tpl-btn-row">
          <div className="tpl-btn-reorder">
            <button type="button" className="btn btn-icon btn-ghost btn-sm"
              onClick={() => moveButton(i, -1)} disabled={i === 0} aria-label="Move up">
              <ChevronUp size={13} />
            </button>
            <button type="button" className="btn btn-icon btn-ghost btn-sm"
              onClick={() => moveButton(i, 1)} disabled={i === buttons.length - 1} aria-label="Move down">
              <ChevronDown size={13} />
            </button>
          </div>

          <div className="tpl-btn-fields">
            <select
              className="select"
              value={btn.type}
              onChange={(e) => updateButton(i, { type: e.target.value, text: btn.text, phone_number: "", url: "", urlExample: "", example: "" })}
            >
              {BUTTON_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.icon} {t.label}</option>
              ))}
            </select>

            {btn.type !== "COPY_CODE" && (
              <input className="input" placeholder="Button label (max 25 chars)"
                maxLength={25} value={btn.text || ""}
                onChange={(e) => updateButton(i, { text: e.target.value })} />
            )}

            {btn.type === "PHONE_NUMBER" && (
              <input className="input" placeholder="Phone number e.g. 15550051310"
                value={btn.phone_number || ""}
                onChange={(e) => updateButton(i, { phone_number: e.target.value })} />
            )}

            {btn.type === "URL" && (
              <>
                <input className="input" placeholder="URL e.g. https://example.com/order?id={{1}}"
                  value={btn.url || ""}
                  onChange={(e) => updateButton(i, { url: e.target.value })} />
                {btn.url?.includes("{{") && (
                  <input className="input" placeholder="Example URL value for Meta review"
                    value={btn.urlExample || ""}
                    onChange={(e) => updateButton(i, { urlExample: e.target.value })} />
                )}
              </>
            )}

            {btn.type === "COPY_CODE" && (
              <input className="input" placeholder="Example code (max 20 chars)" maxLength={20}
                value={btn.example || ""}
                onChange={(e) => updateButton(i, { example: e.target.value })} />
            )}
          </div>

          <button type="button" className="btn btn-icon btn-ghost btn-sm"
            onClick={() => removeButton(i)} aria-label="Remove button">
            <Trash2 size={13} style={{ color: "var(--danger)" }} />
          </button>
        </div>
      ))}

      {buttons.length < 10 && (
        <button type="button" className="btn btn-sm" onClick={addButton} style={{ marginTop: 8 }}>
          <Plus size={13} /> Add button
        </button>
      )}
      {buttons.length === 0 && (
        <div className="empty-note" style={{ marginTop: 6 }}>No buttons — optional.</div>
      )}
    </div>
  );
}

// ─── Create Template Drawer ───────────────────────────────────────────────────

function CreateTemplateDrawer({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState([]);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors([]);
    setServerError(null);
  }

  function setVarMapping(varName, label) {
    setForm((f) => ({
      ...f,
      variableMappings: { ...f.variableMappings, [varName]: label },
    }));
  }

  // Pass the callback into the form so WhatsAppPreview can call it
  const formWithCallback = { ...form, _onVarMapping: setVarMapping };

  const charCount = { body: form.bodyText.length, header: form.headerText.length, footer: form.footerText.length };

  async function handleSubmit(e) {
    e.preventDefault();
    const validationErrors = validateForm(form);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }

    setSaving(true);
    setServerError(null);
    try {
      const components = buildComponentsPayload(form);
      const res = await fetch(`${functionsBaseUrl()}/createTemplate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name:             form.name.trim(),
          category:         form.category,
          language:         form.language,
          parameter_format: form.parameter_format,
          components,
          variableMappings: form.variableMappings,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      onCreated(body);
    } catch (err) {
      setServerError(err.message || "Couldn't create template. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="drawer-overlay" onClick={() => { if (!saving) onClose(); }} />
      <form className="drawer tpl-create-drawer" onSubmit={handleSubmit} noValidate>
        <div className="drawer-header">
          <strong>New Template</strong>
          <button type="button" className="btn btn-icon btn-ghost" onClick={onClose} disabled={saving}>
            <X size={16} />
          </button>
        </div>

        <div className="tpl-create-body">
          {/* ── Left: form ── */}
          <div className="tpl-create-form">

            {/* Validation errors */}
            {(errors.length > 0 || serverError) && (
              <div className="tpl-error-box">
                <AlertCircle size={14} />
                <ul>
                  {serverError && <li>{serverError}</li>}
                  {errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </div>
            )}

            {/* Basics */}
            <div className="form-section">
              <div className="form-section-title">Basics</div>
              <div className="form-grid">
                <label className="form-full-width">
                  <span className="field-label">Template name</span>
                  <input className="input" required
                    placeholder="e.g. order_confirmation"
                    value={form.name}
                    onChange={(e) => set("name", e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                  />
                  <span className="field-hint">Lowercase, letters/numbers/underscores only</span>
                </label>

                <label>
                  <span className="field-label">Category</span>
                  <select className="select" value={form.category} onChange={(e) => set("category", e.target.value)}>
                    <option value="MARKETING">Marketing</option>
                    <option value="UTILITY">Utility</option>
                    <option value="AUTHENTICATION">Authentication</option>
                  </select>
                </label>

                <label>
                  <span className="field-label">Language</span>
                  <select className="select" value={form.language} onChange={(e) => set("language", e.target.value)}>
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>{l.label} ({l.code})</option>
                    ))}
                  </select>
                </label>

                <label>
                  <span className="field-label">Variable format</span>
                  <select className="select" value={form.parameter_format} onChange={(e) => set("parameter_format", e.target.value)}>
                    <option value="positional">Positional &#123;&#123;1&#125;&#125;</option>
                    <option value="named">Named &#123;&#123;name&#125;&#125;</option>
                  </select>
                </label>
              </div>
            </div>

            {/* Header */}
            <div className="form-section">
              <div className="form-section-title">Header <span className="field-hint-inline">(optional)</span></div>
              <div className="form-grid">
                <label className="form-full-width">
                  <span className="field-label">Header type</span>
                  <select className="select" value={form.headerType} onChange={(e) => set("headerType", e.target.value)}>
                    <option value="NONE">None</option>
                    <option value="TEXT">Text</option>
                    <option value="IMAGE">Image</option>
                    <option value="VIDEO">Video</option>
                    <option value="DOCUMENT">Document</option>
                    <option value="LOCATION">Location (Utility/Marketing only)</option>
                  </select>
                </label>

                {form.headerType === "TEXT" && (
                  <label className="form-full-width">
                    <span className="field-label">Header text ({charCount.header}/60)</span>
                    <input className="input" maxLength={60}
                      placeholder="e.g. Your order is confirmed!"
                      value={form.headerText}
                      onChange={(e) => set("headerText", e.target.value)}
                    />
                  </label>
                )}

                {["IMAGE", "VIDEO", "DOCUMENT"].includes(form.headerType) && (
                  <div className="form-full-width">
                    <div className="tpl-media-note">
                      <Info size={13} />
                      <span>
                        Media templates require an <strong>asset handle</strong> from Meta's Resumable Upload API.
                        Upload your media file first, then paste the handle below.
                      </span>
                    </div>
                    <label style={{ marginTop: 8, display: "block" }}>
                      <span className="field-label">Media handle (from Resumable Upload API)</span>
                      <input className="input"
                        placeholder="e.g. 4::aW1hZ2..."
                        value={form.mediaHandle || ""}
                        onChange={(e) => set("mediaHandle", e.target.value)}
                      />
                    </label>
                  </div>
                )}

                {form.headerType === "LOCATION" && (
                  <div className="form-full-width">
                    <div className="tpl-media-note">
                      <Info size={13} />
                      <span>Location is a placeholder header. The actual coordinates are provided at send time (not stored in the template).</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Body */}
            <div className="form-section">
              <div className="form-section-title">Body</div>
              <label>
                <span className="field-label">Body text ({charCount.body}/1024) *</span>
                <textarea className="textarea" rows={5} required
                  placeholder={"Hello {{1}}, your appointment is on {{2}}.\n\nUse named: Hello {{customer_name}}."}
                  value={form.bodyText}
                  onChange={(e) => set("bodyText", e.target.value)}
                />
              </label>
            </div>

            {/* Footer */}
            <div className="form-section">
              <div className="form-section-title">Footer <span className="field-hint-inline">(optional)</span></div>
              <label>
                <span className="field-label">Footer text ({charCount.footer}/60)</span>
                <input className="input" maxLength={60}
                  placeholder="e.g. Reply STOP to unsubscribe"
                  value={form.footerText}
                  onChange={(e) => set("footerText", e.target.value)}
                />
              </label>
            </div>

            {/* Buttons */}
            <div className="form-section">
              <div className="form-section-title">Buttons <span className="field-hint-inline">(optional · max 10)</span></div>
              <ButtonEditor
                buttons={form.buttons}
                onChange={(btns) => set("buttons", btns)}
              />
            </div>
          </div>

          {/* ── Right: preview ── */}
          <div className="tpl-create-preview">
            <div className="form-section-title" style={{ marginBottom: 12 }}>Live Preview</div>
            <WhatsAppPreview form={formWithCallback} />
          </div>
        </div>

        <div className="drawer-footer">
          <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? <><RefreshCw size={13} className="spin" /> Submitting…</> : "Submit to Meta"}
          </button>
        </div>
      </form>
    </>
  );
}

// ─── Template Detail Drawer ───────────────────────────────────────────────────

function RejectionReasonLabel({ reason }) {
  if (!reason) return null;
  const readable = {
    ABUSIVE_CONTENT: "Abusive content",
    INCORRECT_CATEGORY: "Incorrect category",
    INVALID_FORMAT: "Invalid format",
    SCAM: "Scam",
    NONE: null,
  };
  const label = readable[reason] || reason;
  if (!label) return null;
  return <span className="badge badge-hot">{label}</span>;
}

function TemplateDetailDrawer({ template, onClose, onRefresh, refreshing }) {
  if (!template) return null;
  const { header, body, footer, buttons } = getComponentParts(template.components);

  const paramFormat = template.parameterFormat || "positional";
  const variables   = Array.isArray(template.variables) ? template.variables : [];
  const mappings    = template.variableMappings || {};

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {template.name}
            </strong>
            <StatusBadge status={template.status} />
            {template.qualityScore && template.qualityScore !== "UNKNOWN" && (
              <QualityBadge score={template.qualityScore} />
            )}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={onRefresh}
              disabled={refreshing}
              title="Re-fetch this template from Meta"
            >
              <RotateCcw size={13} className={refreshing ? "spin" : ""} />
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>
            <button type="button" className="btn btn-icon btn-ghost" onClick={onClose}>
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="drawer-body">
          {/* Overview */}
          <div className="form-section">
            <div className="form-section-title">Overview</div>
            <div className="panel-two-col">
              <div className="panel-field">
                <div className="panel-field-label">Category</div>
                <div className="panel-field-value">{template.category}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Language</div>
                <div className="panel-field-value">{template.language}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Status</div>
                <div className="panel-field-value"><StatusBadge status={template.status} /></div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Quality</div>
                <div className="panel-field-value">
                  {template.qualityScore && template.qualityScore !== "UNKNOWN"
                    ? <QualityBadge score={template.qualityScore} />
                    : <span className="empty-note">—</span>}
                </div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Variable format</div>
                <div className="panel-field-value" style={{ textTransform: "capitalize" }}>{paramFormat}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Template ID</div>
                <div className="panel-field-value" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {template.templateId}
                </div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Created</div>
                <div className="panel-field-value">{formatDateTime(template.createdAt)}</div>
              </div>
              <div className="panel-field">
                <div className="panel-field-label">Last synced</div>
                <div className="panel-field-value">{formatDateTime(template.lastSyncedAt)}</div>
              </div>
            </div>

            {template.rejectionReason && (
              <div className="panel-field" style={{ marginTop: 12 }}>
                <div className="panel-field-label">Rejection reason</div>
                <div className="panel-field-value">
                  <RejectionReasonLabel reason={template.rejectionReason} />
                </div>
              </div>
            )}
          </div>

          {/* Variables */}
          <div className="form-section">
            <div className="form-section-title">Variables</div>
            {variables.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {variables.map((v) => (
                  <div key={v} className="tpl-var-row">
                    <span className="badge badge-info" style={{ minWidth: 52, justifyContent: "center" }}>
                      {`{{${v}}}`}
                    </span>
                    <span className="panel-field-value" style={{ flex: 1, margin: 0, padding: "4px 0" }}>
                      {mappings[v]
                        ? <><CheckCircle size={11} style={{ color: "var(--success)", verticalAlign: -1 }} /> {mappings[v]}</>
                        : <span className="empty-note">No label set</span>}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-note">No variables in this template.</div>
            )}
          </div>

          {/* Content preview */}
          <div className="form-section">
            <div className="form-section-title">Content</div>

            {header && (
              <div className="panel-field" style={{ marginBottom: 10 }}>
                <div className="panel-field-label">Header — {header.format || "TEXT"}</div>
                <div className="panel-field-value">
                  {header.text
                    ? <span style={{ whiteSpace: "pre-wrap" }}>{highlightVars(header.text)}</span>
                    : header.format !== "TEXT"
                      ? <span className="badge badge-muted">{header.format} media</span>
                      : <span className="empty-note">—</span>}
                </div>
              </div>
            )}

            <div className="panel-field" style={{ marginBottom: 10 }}>
              <div className="panel-field-label">Body</div>
              <div className="panel-field-value" style={{ whiteSpace: "pre-wrap" }}>
                {body?.text ? highlightVars(body.text) : <span className="empty-note">—</span>}
              </div>
            </div>

            {footer && (
              <div className="panel-field" style={{ marginBottom: 10 }}>
                <div className="panel-field-label">Footer</div>
                <div className="panel-field-value">{footer.text || <span className="empty-note">—</span>}</div>
              </div>
            )}

            {buttons && Array.isArray(buttons.buttons) && buttons.buttons.length > 0 && (
              <div className="panel-field">
                <div className="panel-field-label">Buttons</div>
                <div className="panel-tag-row" style={{ marginTop: 4 }}>
                  {buttons.buttons.map((b, i) => (
                    <div key={i} className="tpl-detail-button">
                      {b.type === "PHONE_NUMBER" && <Phone size={11} />}
                      {b.type === "URL"          && <ExternalLink size={11} />}
                      {b.type === "COPY_CODE"    && <Copy size={11} />}
                      {b.type === "QUICK_REPLY"  && <MessageSquare size={11} />}
                      <span>{b.text || b.type}</span>
                      <span className="badge badge-muted" style={{ fontSize: 10, padding: "1px 6px" }}>{b.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Status explanation box */}
          {(template.status === "Rejected" || template.status === "Paused" || template.status === "Disabled") && (
            <div className="tpl-status-info-box">
              <Info size={13} />
              <span>
                {template.status === "Rejected"
                  ? "This template was rejected by Meta. Review the rejection reason and create a new version."
                  : template.status === "Paused"
                  ? "This template was paused by Meta due to poor quality signals. It will be re-evaluated automatically."
                  : "This template is disabled. It cannot be used in campaigns."}
                {" "}
                <a href="https://www.facebook.com/business/help/120491922019120" target="_blank" rel="noreferrer"
                  style={{ color: "var(--accent)" }}>
                  Learn more ↗
                </a>
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Templates() {
  const [searchParams, setSearchParams]   = useSearchParams();
  const [templates, setTemplates]         = useState([]);
  const [loading, setLoading]             = useState(true);
  const [search, setSearch]               = useState("");
  const [statusFilter, setStatusFilter]   = useState("All");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [selected, setSelected]           = useState(null);
  const [syncing, setSyncing]             = useState(false);
  const [createOpen, setCreateOpen]       = useState(false);
  const [refreshingId, setRefreshingId]   = useState(null);
  const [toast, setToast]                 = useState(null);

  // Deep link from the Dashboard's "Create Template" quick action.
  useEffect(() => {
    if (searchParams.get("new") === "1") {
      setCreateOpen(true);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live Firestore listener
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "whatsappTemplates"),
      (snap) => {
        const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setTemplates(docs);
        setLoading(false);
        // If a detail panel is open, keep it in sync
        setSelected((prev) => {
          if (!prev) return prev;
          const updated = docs.find((d) => d.id === prev.id);
          return updated || prev;
        });
      },
      () => setLoading(false)
    );
    return unsub;
  }, []);

  // Auto-dismiss toast after 6 s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortByRecency(
      templates.filter((t) => {
        if (term && !(t.name || "").toLowerCase().includes(term)) return false;
        if (statusFilter !== "All"   && t.status   !== statusFilter)   return false;
        if (categoryFilter !== "All" && t.category !== categoryFilter) return false;
        return true;
      }),
      "lastSyncedAt"
    );
  }, [templates, search, statusFilter, categoryFilter]);

  // Counts for filter chips
  const statusCounts = useMemo(() => {
    const map = {};
    templates.forEach((t) => { map[t.status] = (map[t.status] || 0) + 1; });
    return map;
  }, [templates]);

  async function handleSync() {
    setSyncing(true);
    try {
      const res = await fetch(`${functionsBaseUrl()}/syncTemplates`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      setToast({ type: "success", message: `Sync complete — ${summarizeSyncResult(body)}` });
    } catch (err) {
      setToast({ type: "error", message: err.message || "Sync failed. Try again." });
    } finally {
      setSyncing(false);
    }
  }

  async function handleRefresh(templateId) {
    setRefreshingId(templateId);
    try {
      const res = await fetch(`${functionsBaseUrl()}/refreshTemplate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `Error ${res.status}`);
      setToast({ type: "success", message: `Refreshed — status: ${body.status || "updated"}` });
    } catch (err) {
      setToast({ type: "error", message: err.message || "Refresh failed." });
    } finally {
      setRefreshingId(null);
    }
  }

  function handleCreated(result) {
    setCreateOpen(false);
    setToast({
      type: "success",
      message: `Template "${result.name}" submitted — status: ${result.status}`,
    });
  }

  return (
    <div className="page">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1>Templates</h1>
          <div className="page-subtitle">
            {templates.length} template{templates.length !== 1 ? "s" : ""} · WhatsApp Business Account
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={handleSync} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? "spin" : ""} />
            {syncing ? "Syncing…" : "Sync All"}
          </button>
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={14} /> New Template
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="campaigns-toolbar" style={{ flexDirection: "column", alignItems: "flex-start", gap: 10 }}>
        <div style={{ display: "flex", gap: 10, width: "100%", flexWrap: "wrap" }}>
          <div className="conv-search" style={{ flex: 1, minWidth: 220, maxWidth: 380 }}>
            <Search size={14} />
            <input
              type="text"
              placeholder="Search by name…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button type="button" onClick={() => setSearch("")}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "0 6px", color: "var(--ink-faint)" }}>
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        {/* Status filters */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATUS_FILTERS.map((s) => (
            <button key={s} className={"chip" + (statusFilter === s ? " chip-active" : "")}
              onClick={() => setStatusFilter(s)}>
              {s}
              {s !== "All" && statusCounts[s] ? (
                <span style={{ marginLeft: 4, opacity: 0.7, fontSize: 11 }}>({statusCounts[s]})</span>
              ) : null}
            </button>
          ))}
        </div>

        {/* Category filters */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {CATEGORY_FILTERS.map((c) => (
            <button key={c} className={"chip" + (categoryFilter === c ? " chip-active" : "")}
              onClick={() => setCategoryFilter(c)}>
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* Loading skeletons */}
      {loading && (
        <div className="table-wrap">
          <table className="data-table">
            <tbody>
              {Array.from({ length: 5 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 7 }).map((__, j) => (
                    <td key={j}><div className="skeleton skeleton-line" style={{ width: j === 0 ? "70%" : "50%" }} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && (
        <div className="empty-state">
          <FileText size={28} style={{ marginBottom: 8, color: "var(--ink-faint)" }} />
          <div className="empty-state-title">
            {templates.length === 0 ? "No templates yet" : "No templates match this filter"}
          </div>
          <div className="empty-note">
            {templates.length === 0
              ? "Click \"Sync All\" to pull templates from WhatsApp, or create a new one."
              : "Try adjusting the search or filters."}
          </div>
        </div>
      )}

      {/* Table */}
      {!loading && filtered.length > 0 && (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Language</th>
                <th>Status</th>
                <th>Quality</th>
                <th>Variables</th>
                <th>Last Synced</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSelected(t)}>
                  <td style={{ fontWeight: 600 }}>{t.name}</td>
                  <td>{t.category}</td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{t.language}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>
                    {t.qualityScore && t.qualityScore !== "UNKNOWN"
                      ? <QualityBadge score={t.qualityScore} />
                      : <span className="empty-note">—</span>}
                  </td>
                  <td style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                    {Array.isArray(t.variables) && t.variables.length > 0
                      ? t.variables.length
                      : <span className="empty-note">—</span>}
                  </td>
                  <td style={{ color: "var(--ink-muted)", fontSize: 12 }}>{formatDateTime(t.lastSyncedAt)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
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
        </div>
      )}

      {/* Detail drawer */}
      {selected && (
        <TemplateDetailDrawer
          template={selected}
          onClose={() => setSelected(null)}
          onRefresh={() => handleRefresh(selected.id)}
          refreshing={refreshingId === selected.id}
        />
      )}

      {/* Create drawer */}
      {createOpen && (
        <CreateTemplateDrawer
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
