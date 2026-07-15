const axios = require("axios");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { GRAPH_API_VERSION } = require("./config");
const { CampaignError } = require("./campaigns");
const { recordTemplateCreated, recordTemplateStatusChange, recordTemplateSyncBatch } = require("./metrics");

/**
 * WHATSAPP TEMPLATE MANAGEMENT
 * ---------------------------------------------------------------------------
 * `whatsappTemplates/{templateId}` — a local mirror of WhatsApp message
 * templates from Meta's WhatsApp Business Account. This module is the
 * single source of truth for all template operations:
 *
 *   syncTemplatesFromMeta      — full catalog refresh (all templates)
 *   createTemplateOnMeta       — create a new template via Meta API
 *   fetchTemplateFromMeta      — fetch one template by Meta template ID
 *   refreshSingleTemplate      — sync one template into Firestore
 *   assertTemplateApprovedForCampaign — campaign creation guard
 *
 * Schema fields stored in Firestore:
 *   templateId       string   Meta's template ID
 *   name             string
 *   category         string   MARKETING | UTILITY | AUTHENTICATION (normalised Title-Case)
 *   language         string   e.g. en_US
 *   status           string   Approved | Pending | Rejected | Disabled | Paused | InAppeal
 *   qualityScore     string   GREEN | YELLOW | RED | UNKNOWN (from Meta quality_score.score)
 *   rejectionReason  string   from Meta's rejected_reason field (if present)
 *   parameterFormat  string   positional | named (defaults to positional)
 *   components       array    Raw Meta components array
 *   variables        array    Extracted variable names/indices
 *   variableMappings object   CRM-only label map { "1": "Customer Name", ... }
 *   createdAt        Timestamp
 *   updatedAt        Timestamp
 *   lastSyncedAt     Timestamp
 */

// ── Categories & Statuses ─────────────────────────────────────────────────

const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY", "AUTHENTICATION"];
const TEMPLATE_STATUSES = ["Approved", "Pending", "Rejected", "Disabled", "Paused", "InAppeal"];

const CATEGORY_LABELS = {
  MARKETING: "Marketing",
  UTILITY: "Utility",
  AUTHENTICATION: "Authentication",
};

// STATUS_LABELS maps the full range of Meta API status values to our
// normalised Title-Case strings. Unknown values fall back to "Pending"
// so nothing unrecognised is treated as send-able.
const STATUS_LABELS = {
  APPROVED: "Approved",
  PENDING: "Pending",
  PENDING_DELETION: "Disabled",
  REJECTED: "Rejected",
  DISABLED: "Disabled",
  PAUSED: "Paused",
  IN_APPEAL: "InAppeal",
  APPEAL_REQUESTED: "InAppeal",
  FLAGGED: "Paused",
  DELETED: "Disabled",
};

// Quality score values from Meta's quality_score.score field.
const QUALITY_SCORE_LABELS = {
  GREEN: "GREEN",
  YELLOW: "YELLOW",
  RED: "RED",
  UNKNOWN: "UNKNOWN",
};

// Meta's known rejection reasons. We store raw so the UI can localise or
// humanise them; we also expose a human-readable map for the frontend.
const REJECTION_REASON_LABELS = {
  ABUSIVE_CONTENT: "Abusive content",
  INCORRECT_CATEGORY: "Incorrect category",
  INVALID_FORMAT: "Invalid format",
  SCAM: "Scam",
  NONE: "None",
};

// ── Errors ────────────────────────────────────────────────────────────────

class TemplateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "TemplateError";
    this.code = code || "invalid_argument";
  }
}

// ── Normalisers ───────────────────────────────────────────────────────────

function templatesCollection(db) {
  return db.collection("whatsappTemplates");
}

function normalizeCategory(raw) {
  if (!raw) return "Utility";
  const key = String(raw).toUpperCase();
  return CATEGORY_LABELS[key] || (raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase());
}

function normalizeStatus(raw) {
  if (!raw) return "Pending";
  const key = String(raw).toUpperCase().replace(/ /g, "_");
  return STATUS_LABELS[key] || "Pending";
}

function normalizeQualityScore(qualityScore) {
  if (!qualityScore) return "UNKNOWN";
  const score = qualityScore.score || qualityScore;
  return QUALITY_SCORE_LABELS[String(score).toUpperCase()] || "UNKNOWN";
}

function normalizeRejectionReason(raw) {
  if (!raw || raw === "NONE") return null;
  return String(raw);
}

// Variable extraction — matches {{1}} positional and {{name}} named params
const VARIABLE_PATTERN = /\{\{\s*([^}]+?)\s*\}\}/g;

function extractVariablesFromText(text) {
  if (typeof text !== "string" || !text) return [];
  const found = [];
  let match;
  VARIABLE_PATTERN.lastIndex = 0;
  while ((match = VARIABLE_PATTERN.exec(text)) !== null) {
    found.push(match[1].trim());
  }
  return found;
}

function extractVariables(components) {
  if (!Array.isArray(components)) return [];
  const seen = new Set();
  const variables = [];
  for (const component of components) {
    if (!component) continue;
    const texts = [];
    if (typeof component.text === "string") texts.push(component.text);
    if (Array.isArray(component.buttons)) {
      for (const button of component.buttons) {
        if (typeof button?.text === "string") texts.push(button.text);
        if (typeof button?.url === "string") texts.push(button.url);
      }
    }
    for (const text of texts) {
      for (const variable of extractVariablesFromText(text)) {
        if (!seen.has(variable)) {
          seen.add(variable);
          variables.push(variable);
        }
      }
    }
  }
  return variables;
}

/**
 * Firestore does not support nested arrays (arrays containing arrays).
 * Meta's API returns `example` sub-objects on components that contain exactly
 * this structure, e.g.:
 *   body.example.body_text = [["Pablo", "860198-230332"]]
 *
 * This function recursively sanitizes any value before it is stored in
 * Firestore by:
 *   1. Dropping any object key named `example` at any depth (Meta-only field).
 *   2. Flattening any array-within-array to a plain array of strings as a
 *      last-resort safety net, so a previously unseen structure can never
 *      cause a write failure.
 *
 * The example data is only needed during Meta API submission, never for CRM
 * display or campaign sending, so removing it is safe and correct.
 */
function sanitizeForFirestore(value) {
  // Nested array → flatten one level to plain array of strings
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (Array.isArray(item)) {
        // Flatten the inner array to a single comma-joined string so the
        // structure is still human-readable in Firestore but not a nested array.
        return item.map((v) => String(v)).join(", ");
      }
      return sanitizeForFirestore(item);
    });
  }
  // Plain object → recurse, dropping any key named "example"
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "example") continue;   // strip Meta example fields at every depth
      out[k] = sanitizeForFirestore(v);
    }
    return out;
  }
  // Primitive — return as-is
  return value;
}

function sanitizeComponentsForFirestore(components) {
  if (!Array.isArray(components)) return [];
  return components.map((comp) => sanitizeForFirestore(comp));
}

/**
 * Maps one Meta message_templates API object -> Firestore schema.
 * Captures all fields available from the API including quality_score,
 * rejected_reason, and parameter_format.
 *
 * NOTE: components are sanitized before storage — all `example` keys are
 * stripped and any nested arrays are flattened, because Firestore does not
 * allow nested arrays anywhere in a document.
 */
function normalizeTemplateFromMeta(meta) {
  const rawComponents = Array.isArray(meta.components) ? meta.components : [];
  const components = sanitizeComponentsForFirestore(rawComponents);
  return {
    templateId: meta.id,
    name: meta.name || "",
    category: normalizeCategory(meta.category),
    language: meta.language || "",
    status: normalizeStatus(meta.status),
    qualityScore: normalizeQualityScore(meta.quality_score),
    rejectionReason: normalizeRejectionReason(meta.rejected_reason),
    parameterFormat: meta.parameter_format || "positional",
    components,
    variables: extractVariables(components),
    // variableMappings is CRM-only — never overwrite it from Meta, the caller
    // (sync/refresh) must use { merge: true } so it is preserved.
  };
}

// ── Batch utilities ───────────────────────────────────────────────────────

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

const TEMPLATE_CHUNK_SIZE = 300;

// ── Meta API helpers ──────────────────────────────────────────────────────

const TEMPLATE_FIELDS =
  "id,name,category,language,status,components,quality_score,rejected_reason,parameter_format";

/**
 * Pages through ALL templates in a WABA.
 */
async function fetchAllTemplatesFromMeta({ wabaId, whatsappToken }) {
  const results = [];
  let url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates` +
    `?limit=100&fields=${TEMPLATE_FIELDS}`;

  while (url) {
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${whatsappToken}` },
    });
    const data = response.data || {};
    results.push(...(Array.isArray(data.data) ? data.data : []));
    url = data.paging && data.paging.next ? data.paging.next : null;
  }

  return results;
}

/**
 * Fetch a single template by its Meta template ID.
 */
async function fetchTemplateFromMeta({ templateId, whatsappToken }) {
  const response = await axios.get(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${templateId}?fields=${TEMPLATE_FIELDS}`,
    { headers: { Authorization: `Bearer ${whatsappToken}` } }
  );
  return response.data;
}

// ── Core operations ───────────────────────────────────────────────────────

/**
 * Full catalog sync — same semantics as before but now captures
 * quality_score, rejected_reason, and parameter_format.
 */
async function syncTemplatesFromMeta(db, { wabaId, whatsappToken }) {
  if (!wabaId || typeof wabaId !== "string") {
    throw new TemplateError("A WhatsApp Business Account ID is required.", "invalid_argument");
  }
  if (!whatsappToken || typeof whatsappToken !== "string") {
    throw new TemplateError("A WhatsApp access token is required.", "invalid_argument");
  }

  const startedAt = Date.now();

  let fetched;
  try {
    fetched = await fetchAllTemplatesFromMeta({ wabaId, whatsappToken });
  } catch (err) {
    logger.error("whatsappTemplates: fetch from Meta failed", {
      error: err.response?.data || err.message,
    });
    throw new TemplateError("Failed to fetch templates from the WhatsApp Cloud API.", "upstream_error");
  }

  const col = templatesCollection(db);
  const fetchedIds = new Set(fetched.map((t) => t.id));

  let added = 0;
  let updated = 0;
  // METRICS: accumulated across the WHOLE sync (every chunk, every
  // added/disabled pass below) and written as ONE increment call at the end
  // — see recordTemplateSyncBatch's own comment for why per-template writes
  // here would defeat the point of a sync.
  const metricsDeltas = {};
  function bumpMetric(path, amount) {
    metricsDeltas[path] = (metricsDeltas[path] || 0) + amount;
  }

  for (const chunk of chunkArray(fetched, TEMPLATE_CHUNK_SIZE)) {
    const refs = chunk.map((t) => col.doc(t.id));
    const existingSnaps = await db.getAll(...refs);

    const batch = db.batch();
    existingSnaps.forEach((snap, i) => {
      const normalized = normalizeTemplateFromMeta(chunk[i]);
      // JSON round-trip: eliminates any nested arrays that survive sanitization
      let safeComponents;
      try { safeComponents = JSON.parse(JSON.stringify(normalized.components)); }
      catch { safeComponents = []; }
      const safeNormalized = { ...normalized, components: safeComponents };

      if (snap.exists) {
        const previousStatus = snap.data().status;
        batch.set(
          refs[i],
          {
            ...safeNormalized,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        updated += 1;
        if (previousStatus !== safeNormalized.status) {
          if (previousStatus) bumpMetric(`templates.byStatus.${previousStatus}`, -1);
          bumpMetric(`templates.byStatus.${safeNormalized.status}`, 1);
        }
      } else {
        batch.set(refs[i], {
          ...safeNormalized,
          variableMappings: {},
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        added += 1;
        bumpMetric("templates.total", 1);
        bumpMetric(`templates.byStatus.${safeNormalized.status}`, 1);
      }
    });
    await batch.commit();
  }

  // Templates that were removed from Meta → flip to Disabled
  const existingSnap = await col.get();
  const toDisable = [];
  existingSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (!fetchedIds.has(data.templateId) && data.status !== "Disabled") {
      toDisable.push({ ref: docSnap.ref, previousStatus: data.status });
    }
  });

  let disabled = 0;
  for (const chunk of chunkArray(toDisable, TEMPLATE_CHUNK_SIZE)) {
    const batch = db.batch();
    chunk.forEach(({ ref, previousStatus }) => {
      batch.update(ref, {
        status: "Disabled",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      if (previousStatus) bumpMetric(`templates.byStatus.${previousStatus}`, -1);
      bumpMetric("templates.byStatus.Disabled", 1);
    });
    await batch.commit();
    disabled += chunk.length;
  }

  // METRICS: one accumulated increment write for the entire sync, however
  // many templates it touched — see bumpMetric/recordTemplateSyncBatch above.
  await recordTemplateSyncBatch(db, metricsDeltas);

  const durationMs = Date.now() - startedAt;
  const result = { added, updated, disabled, durationMs, totalFetched: fetched.length };
  logger.info("whatsappTemplates: sync complete", result);
  return result;
}

/**
 * Refresh a single template by its Meta template ID and upsert into Firestore.
 * Preserves CRM-only fields (variableMappings) via merge: true.
 */
async function refreshSingleTemplate(db, { templateId, whatsappToken }) {
  if (!templateId) throw new TemplateError("templateId is required.", "invalid_argument");
  if (!whatsappToken) throw new TemplateError("whatsappToken is required.", "invalid_argument");

  let meta;
  try {
    meta = await fetchTemplateFromMeta({ templateId, whatsappToken });
  } catch (err) {
    const apiError = err.response?.data?.error;
    if (apiError) {
      throw new TemplateError(
        `Meta API error: ${apiError.message || JSON.stringify(apiError)}`,
        "upstream_error"
      );
    }
    throw new TemplateError("Failed to fetch template from Meta.", "upstream_error");
  }

  const col = templatesCollection(db);
  const ref = col.doc(templateId);
  const snap = await ref.get();
  const normalized = normalizeTemplateFromMeta(meta);

  // JSON round-trip guarantees no Firestore-incompatible nested arrays survive
  let safeComponents;
  try { safeComponents = JSON.parse(JSON.stringify(normalized.components)); }
  catch { safeComponents = []; }
  const safeNormalized = { ...normalized, components: safeComponents };

  if (snap.exists) {
    const previousStatus = snap.data().status;
    await ref.set(
      {
        ...safeNormalized,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    await recordTemplateStatusChange(db, previousStatus, safeNormalized.status);
  } else {
    await ref.set({
      ...safeNormalized,
      variableMappings: {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await recordTemplateCreated(db, safeNormalized.status);
  }

  return safeNormalized;
}

/**
 * Create a new template via Meta's Business Management API, then immediately
 * upsert the result into Firestore so the CRM reflects it without needing a
 * manual sync.
 *
 * @param {object} db   - Firestore instance
 * @param {object} opts
 * @param {string} opts.wabaId
 * @param {string} opts.whatsappToken
 * @param {object} opts.payload - The full template creation payload (name,
 *   category, language, components, parameter_format)
 * @param {object} [opts.variableMappings] - CRM-only label map to store
 * @returns {Promise<{templateId: string, name: string, status: string}>}
 */
async function createTemplateOnMeta(db, { wabaId, whatsappToken, payload, variableMappings }) {
  if (!wabaId) throw new TemplateError("wabaId is required.", "invalid_argument");
  if (!whatsappToken) throw new TemplateError("whatsappToken is required.", "invalid_argument");
  if (!payload?.name) throw new TemplateError("Template name is required.", "invalid_argument");
  if (!payload?.category) throw new TemplateError("Template category is required.", "invalid_argument");
  if (!payload?.language) throw new TemplateError("Template language is required.", "invalid_argument");
  if (!Array.isArray(payload?.components) || payload.components.length === 0) {
    throw new TemplateError("At least one component is required.", "invalid_argument");
  }

  let metaResponse;
  try {
    const response = await axios.post(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/${wabaId}/message_templates`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${whatsappToken}`,
          "Content-Type": "application/json",
        },
      }
    );
    metaResponse = response.data;
  } catch (err) {
    const apiError = err.response?.data?.error;
    if (apiError) {
      throw new TemplateError(
        `Meta API error (${apiError.code || "?"}): ${apiError.message || JSON.stringify(apiError)}`,
        "upstream_error"
      );
    }
    throw new TemplateError("Failed to create template on Meta.", "upstream_error");
  }

  // metaResponse contains { id, status } — status is typically PENDING at creation.
  const newTemplateId = metaResponse.id;
  if (!newTemplateId) {
    throw new TemplateError("Meta did not return a template ID.", "upstream_error");
  }

  // Immediately fetch the full template to store all fields
  let fullTemplate;
  try {
    fullTemplate = await fetchTemplateFromMeta({ templateId: newTemplateId, whatsappToken });
    logger.info("whatsappTemplates: fetched template from Meta", {
      templateId: newTemplateId,
      rawComponentsJson: JSON.stringify(fullTemplate.components),
    });
  } catch (fetchErr) {
    logger.warn("whatsappTemplates: immediate fetch failed, using payload fallback", {
      templateId: newTemplateId,
      error: fetchErr.message,
    });
    // If the immediate fetch fails, build a partial record from what we sent
    fullTemplate = {
      id: newTemplateId,
      name: payload.name,
      category: payload.category,
      language: payload.language,
      status: metaResponse.status || "PENDING",
      components: payload.components,
      parameter_format: payload.parameter_format || "positional",
      quality_score: null,
      rejected_reason: null,
    };
  }

  const normalized = normalizeTemplateFromMeta(fullTemplate);
  const col = templatesCollection(db);

  // Build the Firestore document carefully.
  // Components are sanitized by normalizeTemplateFromMeta (all `example` keys
  // stripped recursively, nested arrays flattened). We do a final JSON
  // round-trip to guarantee no Firestore-incompatible structure survives —
  // JSON serialization collapses any object that cannot be serialized cleanly.
  let safeComponents;
  try {
    safeComponents = JSON.parse(JSON.stringify(normalized.components));
  } catch {
    safeComponents = [];
  }

  logger.info("whatsappTemplates: writing template to Firestore", {
    templateId: newTemplateId,
    status: normalized.status,
    componentCount: safeComponents.length,
  });

  await col.doc(newTemplateId).set({
    templateId: normalized.templateId,
    name: normalized.name,
    category: normalized.category,
    language: normalized.language,
    status: normalized.status,
    qualityScore: normalized.qualityScore,
    rejectionReason: normalized.rejectionReason || null,
    parameterFormat: normalized.parameterFormat,
    components: safeComponents,
    variables: normalized.variables,
    variableMappings: variableMappings || {},
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  logger.info("whatsappTemplates: created template", { templateId: newTemplateId, name: payload.name });
  // METRICS: this function only ever runs once per createTemplate HTTP call
  // (a fresh doc.set() above, never a merge onto an existing template), so
  // this is a one-time event.
  await recordTemplateCreated(db, normalized.status);

  return {
    templateId: newTemplateId,
    name: normalized.name,
    status: normalized.status,
  };
}

/**
 * Fetch a single template from Firestore by Meta template ID (not doc ID;
 * they are the same, but this makes intent explicit).
 */
async function getTemplateDetails(db, { templateId }) {
  if (!templateId) throw new TemplateError("templateId is required.", "invalid_argument");
  const snap = await templatesCollection(db).doc(templateId).get();
  if (!snap.exists) throw new TemplateError(`Template ${templateId} not found.`, "not_found");
  return { id: snap.id, ...snap.data() };
}

/**
 * Campaign creation guard — unchanged semantics.
 */
async function assertTemplateApprovedForCampaign(db, { templateName, templateLanguage }) {
  const snap = await templatesCollection(db)
    .where("name", "==", templateName)
    .where("language", "==", templateLanguage)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new CampaignError(
      `No WhatsApp template named '${templateName}' exists in language '${templateLanguage}'.`,
      "failed_precondition"
    );
  }

  const template = snap.docs[0].data();

  if (template.status === "Disabled" || template.status === "Paused") {
    throw new CampaignError(
      `Template '${templateName}' (${templateLanguage}) is ${template.status.toLowerCase()} and can't be used.`,
      "failed_precondition"
    );
  }
  if (template.status !== "Approved") {
    throw new CampaignError(
      `Template '${templateName}' (${templateLanguage}) is not approved yet (status: ${template.status}).`,
      "failed_precondition"
    );
  }

  return template;
}

module.exports = {
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
  REJECTION_REASON_LABELS,
  TemplateError,
  templatesCollection,
  normalizeCategory,
  normalizeStatus,
  normalizeQualityScore,
  extractVariables,
  sanitizeForFirestore,
  normalizeTemplateFromMeta,
  fetchAllTemplatesFromMeta,
  fetchTemplateFromMeta,
  syncTemplatesFromMeta,
  refreshSingleTemplate,
  createTemplateOnMeta,
  getTemplateDetails,
  assertTemplateApprovedForCampaign,
};
