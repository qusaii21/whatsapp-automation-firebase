const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");
const {
  LLM_PRICING_USD_PER_TOKEN,
  LLM_PRICING_DEFAULT_USD_PER_TOKEN,
  META_WHATSAPP_RATE_USD,
  WHATSAPP_BSP_MARKUP_MULTIPLIER,
  CREDITS_PER_USD,
} = require("./config");

/**
 * DASHBOARD METRICS ENGINE
 * ---------------------------------------------------------------------------
 * ONE all-time document — `metrics/dashboard` — plus one doc per period
 * (`metricsDaily/{YYYY-MM-DD}`, `metricsWeekly/{YYYY-Www}`,
 * `metricsMonthly/{YYYY-MM}` — see periodRefs below) holds every number the
 * CRM dashboard needs: Leads, Opportunities, Campaigns, Templates, AI
 * Messages, Human Messages, WhatsApp Messages sent/delivered/read/failed,
 * estimated LLM tokens (input/output/total, overall and per-model),
 * estimated AI cost (`costs.aiUsd`, Groq token cost), estimated Meta cost
 * (`costs.metaUsd`, Meta's own per-message charge), estimated WhatsApp cost
 * (`costs.whatsappUsd`, Meta cost + any BSP markup), and estimated credits
 * (`credits.used`). Nothing here ever reads or scans another collection to
 * compute a count: every field is a running total, moved by exactly ±1 (or a
 * small in-memory-batched delta — see recordTemplateSyncBatch — or a
 * computed cost/token delta — see recordLlmUsage/whatsappSendCostUsd) at the
 * same moment — and, wherever the source event is already transactional,
 * inside the SAME Firestore transaction — as the event that changes it. This
 * is the same pattern campaigns.js already established for its own counters
 * (totalRecipients/sentCount/deliveredCount/...): a counter is derived BY
 * CONSTRUCTION, never by re-deriving it later from a collection scan. The
 * period docs are populated by the exact same recorders as the all-time doc
 * — see applyMetrics/applyMetricsInTransaction, which fan every delta out to
 * all four docs in one atomic batch/transaction — so every call site below
 * needed zero changes to become "incremental daily/weekly/monthly metrics";
 * only this file's two write primitives changed.
 *
 * WHY ONE DOCUMENT (not one doc per metric, not a subcollection of events):
 *   - The dashboard's job is to render a handful of numbers on page load.
 *     One `get()`/`onSnapshot()` on a single doc is one read, full stop,
 *     however many counters live inside it. A subcollection-of-events model
 *     would need either a client-side aggregation query (still a scan) or a
 *     second layer of counters to stay O(1) — at which point it's just this
 *     design with extra steps and extra writes.
 *   - Firestore's real limit on this approach is sustained write throughput
 *     to a SINGLE document (soft cap ~1 write/sec before contention/latency
 *     climbs). This CRM's event volume — inbound WhatsApp turns, campaign
 *     sends, webhook status updates — is nowhere near that. If it ever does
 *     get there, the fix is sharding this one doc into N shard docs (e.g.
 *     `metrics/dashboard_shard_{0..9}`, chosen by hashing an event id) summed
 *     on read — a change fully contained to this file; no call site below
 *     would need to change, since they'd still just call the same recorder
 *     functions.
 *   - `FieldValue.increment()` on a field (or a whole document) that doesn't
 *     exist yet is treated as starting from 0 when written via
 *     `set(..., {merge:true})`. This doc therefore needs no bootstrap/seed
 *     step and no read-before-write anywhere in this file — the very first
 *     event of any kind creates it, and every field before its first
 *     increment is implicitly 0 (render it as 0 on the dashboard, not
 *     "missing").
 *
 * IDEMPOTENCY: this module performs NO dedup of its own — it doesn't need
 * to. Every call site that uses it sits behind a guard that ALREADY exists
 * elsewhere in this codebase to make the underlying business event
 * exactly-once: a dedupe transaction (leadsWebhook.js/whatsappWebhook.js), a
 * recipient claim + terminal-state check (processCampaignRecipient.js), a
 * status-transition legality table (campaigns.js), or a `cached.*` replay
 * flag (processPhoneQueue.js). A metrics call therefore only ever fires once
 * per real event — the same guarantee the write it rides alongside already
 * has. See each call site's own comment for which guard applies there.
 *
 * FAILURE ISOLATION: a metrics write failing must NEVER fail the underlying
 * business operation (the lead was already created / the WhatsApp message
 * was already sent by the time any recorder below runs). Every entry point
 * that isn't already inside someone else's transaction therefore swallows
 * its own errors (logs and moves on) — the same posture processPhoneQueue.js
 * already uses for its own non-critical property-image send.
 */

function metricsRef(db) {
  return db.collection("metrics").doc("dashboard");
}

/**
 * PERIODIZED ROLLUPS (Daily / Weekly / Monthly)
 * ---------------------------------------------------------------------------
 * `metrics/dashboard` (above) is the all-time counter. Alongside it, every
 * recorder in this file ALSO fans the same delta out to one doc per period —
 * `metricsDaily/{YYYY-MM-DD}`, `metricsWeekly/{YYYY-Www}` (ISO week),
 * `metricsMonthly/{YYYY-MM}` — using the exact same shape and the exact same
 * `FieldValue.increment` pattern. This is still O(1) writes per event (4
 * small doc writes instead of 1, batched together — see applyMetrics/
 * applyMetricsInTransaction below), NOT a scan: nothing ever re-derives a
 * period's totals by querying a range of events, so a dashboard asking "show
 * today" or "show this month" is still exactly one `get()` on one doc, same
 * as the all-time view. Bucketing is computed from the writer's clock (UTC)
 * at write time — acceptable for a dashboard rollup, and consistent with the
 * rest of this file never reading anything back before writing.
 */
function pad2(n) {
  return String(n).padStart(2, "0");
}

function dayKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`;
}

// Standard ISO-8601 week key (weeks start Monday; week 1 is the week
// containing the year's first Thursday), computed entirely in UTC so it
// never depends on the executing environment's local timezone.
function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to this ISO week's Thursday
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d - firstThursday) / (7 * 24 * 60 * 60 * 1000));
  return `${d.getUTCFullYear()}-W${pad2(week)}`;
}

function periodRefs(db, date = new Date()) {
  return {
    daily: db.collection("metricsDaily").doc(dayKey(date)),
    weekly: db.collection("metricsWeekly").doc(isoWeekKey(date)),
    monthly: db.collection("metricsMonthly").doc(monthKey(date)),
  };
}

// Turns a flat { "campaigns.byStatus.draft": 1, "leads.total": 1 } delta map
// into the nested { campaigns: { byStatus: { draft: increment(1) } }, ... }
// shape `set(..., {merge:true})` expects, so call sites never hand-nest
// objects or repeat FieldValue.increment boilerplate. Zero-amount deltas are
// dropped rather than written as a no-op increment(0).
function buildPatch(deltas) {
  const patch = {};
  for (const [path, amount] of Object.entries(deltas)) {
    if (!amount) continue;
    const parts = path.split(".");
    let node = patch;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] = node[parts[i]] || {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = admin.firestore.FieldValue.increment(amount);
  }
  patch.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  return patch;
}

/**
 * Standalone update for call sites that are NOT already inside a Firestore
 * transaction (e.g. leadsWebhook.js's lead creation, sendManualMessage.js —
 * both single, non-retried writes). Best-effort: logs and swallows any
 * error rather than throwing, per the file header's FAILURE ISOLATION note.
 */
async function applyMetrics(db, deltas) {
  try {
    const patch = buildPatch(deltas);
    const { daily, weekly, monthly } = periodRefs(db);
    const batch = db.batch();
    batch.set(metricsRef(db), patch, { merge: true });
    batch.set(daily, patch, { merge: true });
    batch.set(weekly, patch, { merge: true });
    batch.set(monthly, patch, { merge: true });
    await batch.commit();
  } catch (err) {
    logger.error("metrics: update failed", { deltas, error: err.message });
  }
}

/**
 * Same update, issued INSIDE an already-open Firestore transaction (e.g.
 * campaigns.js's launchCampaign/pauseCampaign/resumeCampaign/cancelCampaign/
 * completeCampaignIfFinished/applyRecipientStatusUpdate,
 * processCampaignRecipient.js's finalizeSuccess/finalizeFailure). Costs no
 * extra round trip — it's one more write folded into a commit that was
 * already happening — and inherits that transaction's atomicity: the
 * metrics delta can never land without the state change it describes, or
 * vice versa. Never throws on its own (tx.set only queues the write; any
 * failure surfaces as the transaction's own failure/retry, exactly like
 * every other tx.set in that same transaction).
 */
function applyMetricsInTransaction(tx, db, deltas) {
  const patch = buildPatch(deltas);
  const { daily, weekly, monthly } = periodRefs(db);
  tx.set(metricsRef(db), patch, { merge: true });
  tx.set(daily, patch, { merge: true });
  tx.set(weekly, patch, { merge: true });
  tx.set(monthly, patch, { merge: true });
}

// --- Cost/credit calculation helpers -----------------------------------
// Pure functions only — no I/O, no Firestore. Kept separate from the
// recorders below so the arithmetic is easy to unit-test/eyeball in one
// place rather than buried inline in each recorder.

/** Estimated USD cost of one Groq call, from config.js's per-token rate table. */
function llmCostUsd(model, inputTokens, outputTokens) {
  const rate = LLM_PRICING_USD_PER_TOKEN[model] || LLM_PRICING_DEFAULT_USD_PER_TOKEN;
  return inputTokens * rate.input + outputTokens * rate.output;
}

/**
 * Estimated { metaCost, whatsappCost } USD for one outbound WhatsApp Cloud
 * API send, from config.js's per-category rate table. `category` is
 * lower-cased and defaults to "service" (the cheapest/most common case —
 * a free-form reply inside the customer-service window) if unset or
 * unrecognized, so a call site that doesn't know/track a category yet never
 * throws or silently records the wrong (more expensive) rate.
 */
function whatsappSendCostUsd(category) {
  const key = String(category || "service").toLowerCase();
  const metaCost = META_WHATSAPP_RATE_USD[key] ?? META_WHATSAPP_RATE_USD.service ?? 0;
  const whatsappCost = metaCost * WHATSAPP_BSP_MARKUP_MULTIPLIER;
  return { metaCost, whatsappCost };
}

// --- Named recorders — one per tracked dashboard event ----------------------
// Thin, self-documenting wrappers around the two primitives above, so each
// call site reads as "record what just happened" rather than repeating a
// metrics-implementation detail (which path, which transaction) inline.

/** New `leads/{phone}` doc created (leadsWebhook.js, brand-new lead only). */
function recordLeadCreated(db) {
  return applyMetrics(db, { "leads.total": 1 });
}

/** New `leads/{phone}/opportunities/{id}` doc created (opportunities.js). */
function recordOpportunityCreated(db) {
  return applyMetrics(db, { "opportunities.total": 1 });
}

/** New campaign created in `draft` status (campaigns.js's createCampaign). */
function recordCampaignCreated(db) {
  return applyMetrics(db, {
    "campaigns.total": 1,
    "campaigns.byStatus.draft": 1,
  });
}

/**
 * Campaign moved from `previousStatus` -> `newStatus` (launchCampaign,
 * pauseCampaign, resumeCampaign, cancelCampaign, completeCampaignIfFinished
 * — every one of these already runs inside a transaction that re-checks
 * CAMPAIGN_STATUS_TRANSITIONS before writing, so this is always a legal,
 * single, exactly-once move). Call from inside that same transaction.
 */
function recordCampaignStatusChangeInTx(tx, db, previousStatus, newStatus) {
  if (!newStatus || previousStatus === newStatus) return;
  const deltas = {};
  if (previousStatus) deltas[`campaigns.byStatus.${previousStatus}`] = -1;
  deltas[`campaigns.byStatus.${newStatus}`] = 1;
  applyMetricsInTransaction(tx, db, deltas);
}

/** New `whatsappTemplates/{id}` doc created via createTemplate endpoint. */
function recordTemplateCreated(db, status) {
  const deltas = { "templates.total": 1 };
  if (status) deltas[`templates.byStatus.${status}`] = 1;
  return applyMetrics(db, deltas);
}

/** A single template's status changed (refreshTemplate.js's single-template refresh). */
function recordTemplateStatusChange(db, previousStatus, newStatus) {
  if (!newStatus || previousStatus === newStatus) return Promise.resolve();
  const deltas = {};
  if (previousStatus) deltas[`templates.byStatus.${previousStatus}`] = -1;
  deltas[`templates.byStatus.${newStatus}`] = 1;
  return applyMetrics(db, deltas);
}

/**
 * Bulk counterpart for syncTemplatesFromMeta: that loop already touches every
 * synced template once for its OWN Firestore write (it has to — that's the
 * point of a sync), so metrics deltas are accumulated in a plain JS object
 * across the whole loop instead of writing here once per template, then
 * applied as a SINGLE increment write at the end. This is what keeps a
 * 200-template sync at one extra Firestore write, not 200.
 */
function recordTemplateSyncBatch(db, deltas) {
  if (!deltas || Object.keys(deltas).length === 0) return Promise.resolve();
  return applyMetrics(db, deltas);
}

/**
 * One AI-generated WhatsApp reply went out (processPhoneQueue.js, guarded by
 * that file's own `cached.textSent` replay flag — see call site). Counts
 * toward both the AI-specific total and the overall WhatsApp send total.
 * Also books the estimated Meta/WhatsApp cost + credits for a "service"
 * category send (see whatsappSendCostUsd) — separate from the LLM/AI token
 * cost, which is booked by recordLlmUsage below at the point runAgent
 * returns, not here at send time.
 */
function recordAIMessageSent(db) {
  const { metaCost, whatsappCost } = whatsappSendCostUsd("service");
  const deltas = {
    "messages.ai.total": 1,
    "messages.whatsapp.sent": 1,
    "costs.metaUsd": metaCost,
    "costs.whatsappUsd": whatsappCost,
    "credits.used": whatsappCost * CREDITS_PER_USD,
  };
  return applyMetrics(db, deltas);
}

/**
 * One human-agent WhatsApp reply went out (sendManualMessage.js). Counts
 * toward both the human-specific total and the overall WhatsApp send total.
 * Booked as a "service" category send — same rationale as recordAIMessageSent.
 */
function recordHumanMessageSent(db) {
  const { metaCost, whatsappCost } = whatsappSendCostUsd("service");
  const deltas = {
    "messages.human.total": 1,
    "messages.whatsapp.sent": 1,
    "costs.metaUsd": metaCost,
    "costs.whatsappUsd": whatsappCost,
    "credits.used": whatsappCost * CREDITS_PER_USD,
  };
  return applyMetrics(db, deltas);
}

/**
 * Any outbound WhatsApp Cloud API call that is NEITHER an AI reply NOR a
 * human reply — the lead-gen welcome template (leadsWebhook.js), the 24h
 * follow-up template (followupCheck.js), or a deterministic non-text-message
 * ack (whatsappWebhook.js's NON_TEXT_ACKS). Meta still counts it as a sent
 * message, so it belongs in the overall WhatsApp total — it's just not
 * attributable to "AI" or "Human" specifically.
 *
 * @param {string} [category="service"] Meta conversation category this send
 *   bills under — "utility" for the welcome/follow-up templates
 *   (leadsWebhook.js/followupCheck.js), "service" (default) for the
 *   free-form non-text ack (whatsappWebhook.js), which rides inside the
 *   existing customer-service window rather than opening a billable
 *   template conversation. See config.js's META_WHATSAPP_RATE_USD.
 */
function recordWhatsAppSystemSend(db, category = "service") {
  const { metaCost, whatsappCost } = whatsappSendCostUsd(category);
  const deltas = {
    "messages.whatsapp.sent": 1,
    "costs.metaUsd": metaCost,
    "costs.whatsappUsd": whatsappCost,
    "credits.used": whatsappCost * CREDITS_PER_USD,
  };
  return applyMetrics(db, deltas);
}

/**
 * A campaign recipient's send succeeded (processCampaignRecipient.js's
 * finalizeSuccess, in-tx).
 *
 * @param {string} [category="marketing"] The template's Meta category
 *   (template.category from whatsappTemplates.js — "Marketing", "Utility",
 *   or "Authentication", normalized to lower-case here), so a campaign's
 *   cost is booked at the rate its actual template bills under rather than
 *   a flat guess. Defaults to "marketing" since that's the overwhelmingly
 *   common case for a bulk campaign send.
 */
function recordWhatsAppSentInTx(tx, db, category = "marketing") {
  const { metaCost, whatsappCost } = whatsappSendCostUsd(category);
  applyMetricsInTransaction(tx, db, {
    "messages.whatsapp.sent": 1,
    "costs.metaUsd": metaCost,
    "costs.whatsappUsd": whatsappCost,
    "credits.used": whatsappCost * CREDITS_PER_USD,
  });
}

/** A campaign recipient's send permanently failed (processCampaignRecipient.js's finalizeFailure, in-tx). */
function recordWhatsAppFailedInTx(tx, db) {
  applyMetricsInTransaction(tx, db, { "messages.whatsapp.failed": 1 });
}

// "sent" is deliberately excluded here — it's recorded once, at send time,
// by recordWhatsAppSentInTx above. This is only for delivery-status webhook
// transitions (delivered/read/failed), mirroring
// whatsappWebhook.js's own STATUS_TO_RECIPIENT_STATUS map, which for the
// exact same reason never maps Meta's "sent" status webhook to anything.
const TRACKED_WHATSAPP_STATUSES = ["delivered", "read", "failed"];

/** A campaign recipient's status advanced via Meta's status webhook (campaigns.js's applyRecipientStatusUpdate, in-tx). */
function recordWhatsAppStatusInTx(tx, db, status) {
  if (!TRACKED_WHATSAPP_STATUSES.includes(status)) return;
  applyMetricsInTransaction(tx, db, { [`messages.whatsapp.${status}`]: 1 });
}

/**
 * Records one turn's worth of Groq LLM usage — tokens, estimated AI cost,
 * and the credits that cost consumes. Called from processPhoneQueue.js
 * immediately after `runAgent` returns, from inside the SAME
 * `if (!agentResult)` guard that file already uses to make the whole agent
 * turn exactly-once across Cloud Tasks retries/redeliveries (a cached
 * `agentResult` on retry means this is never reached a second time for the
 * same turn) — see that call site's own comment.
 *
 * `usages` is an array of `{ model, inputTokens, outputTokens }`, one entry
 * per Groq call that happened during the turn (intent classifier +
 * requirement extractor + the main agent's 1-3 calls — see agent.js's
 * `_meta.llmUsage`), so a turn with several Groq calls is still just ONE
 * metrics write here, not one per call.
 */
function recordLlmUsage(db, usages) {
  if (!Array.isArray(usages) || usages.length === 0) return Promise.resolve();

  const deltas = {};
  let totalCostUsd = 0;

  for (const entry of usages) {
    const inputTokens = entry?.inputTokens || 0;
    const outputTokens = entry?.outputTokens || 0;
    if (!inputTokens && !outputTokens) continue;

    const totalTokens = inputTokens + outputTokens;
    const cost = llmCostUsd(entry.model, inputTokens, outputTokens);
    totalCostUsd += cost;

    // Firestore field names can't contain "." — the model string has none
    // currently (llama-3.3-70b-versatile etc. use hyphens), but replace any
    // that show up in a future model string rather than let buildPatch
    // mis-nest the path.
    const safeModel = String(entry.model || "unknown").replace(/\./g, "_");

    deltas["llm.tokens.input"] = (deltas["llm.tokens.input"] || 0) + inputTokens;
    deltas["llm.tokens.output"] = (deltas["llm.tokens.output"] || 0) + outputTokens;
    deltas["llm.tokens.total"] = (deltas["llm.tokens.total"] || 0) + totalTokens;
    deltas["llm.calls"] = (deltas["llm.calls"] || 0) + 1;
    deltas[`llm.byModel.${safeModel}.input`] = (deltas[`llm.byModel.${safeModel}.input`] || 0) + inputTokens;
    deltas[`llm.byModel.${safeModel}.output`] = (deltas[`llm.byModel.${safeModel}.output`] || 0) + outputTokens;
    deltas[`llm.byModel.${safeModel}.total`] = (deltas[`llm.byModel.${safeModel}.total`] || 0) + totalTokens;
  }

  if (totalCostUsd > 0) {
    deltas["costs.aiUsd"] = totalCostUsd;
    deltas["credits.used"] = (deltas["credits.used"] || 0) + totalCostUsd * CREDITS_PER_USD;
  }

  if (Object.keys(deltas).length === 0) return Promise.resolve();
  return applyMetrics(db, deltas);
}

module.exports = {
  metricsRef,
  applyMetrics,
  applyMetricsInTransaction,
  recordLeadCreated,
  recordOpportunityCreated,
  recordCampaignCreated,
  recordCampaignStatusChangeInTx,
  recordTemplateCreated,
  recordTemplateStatusChange,
  recordTemplateSyncBatch,
  recordAIMessageSent,
  recordHumanMessageSent,
  recordWhatsAppSystemSend,
  recordWhatsAppSentInTx,
  recordWhatsAppFailedInTx,
  recordWhatsAppStatusInTx,
  recordLlmUsage,
  dayKey,
  monthKey,
  isoWeekKey,
};
