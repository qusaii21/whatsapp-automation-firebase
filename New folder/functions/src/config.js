const { defineSecret } = require("firebase-functions/params");

// Every secret is declared here with defineSecret so each function can list
// exactly which secrets it needs (via { secrets: [...] } in its options) and
// Firebase will inject them as env vars at runtime.

const FB_VERIFY_TOKEN = defineSecret("FB_VERIFY_TOKEN");
const FB_PAGE_ACCESS_TOKEN = defineSecret("FB_PAGE_ACCESS_TOKEN");
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID");
// Needed only by syncTemplates.js — the message_templates API is scoped to
// the WhatsApp Business Account, not the phone number, so this is a
// separate ID from WHATSAPP_PHONE_NUMBER_ID above.
const WHATSAPP_BUSINESS_ACCOUNT_ID = defineSecret("WHATSAPP_BUSINESS_ACCOUNT_ID");
const WHATSAPP_WELCOME_TEMPLATE = defineSecret("WHATSAPP_WELCOME_TEMPLATE");
const WHATSAPP_FOLLOWUP_TEMPLATE = defineSecret("WHATSAPP_FOLLOWUP_TEMPLATE");
const GROQ_API_KEY = defineSecret("GROQ_API_KEY");

// Non-secret constants
const REGION = "us-central1";
const FOLLOWUP_QUEUE_NAME = "followup-queue";
const MESSAGE_QUEUE_NAME = "message-processing-queue";
const GRAPH_API_VERSION = "v20.0";

// --- Per-phone dispatcher (Phase 1: race-condition elimination) -----------
// If a dispatcher lock has been held longer than this with no progress, it
// is assumed the holder crashed/timed out without releasing it, and a new
// webhook delivery is allowed to steal the lock and re-enqueue a drain task.
// Set comfortably above PHONE_QUEUE_TIMEOUT_SECONDS so a *healthy* long-running
// drain is never mistaken for a dead one.
const DISPATCHER_STALE_LOCK_MS = 10 * 60 * 1000;

// Hard timeout for one processPhoneQueue invocation. Chosen so a single
// invocation has real headroom to drain several queued messages, while still
// leaving room to self-chain (see TIME_BUDGET_BUFFER_MS) before Cloud
// Functions kills it outright.
const PHONE_QUEUE_TIMEOUT_SECONDS = 300;

// How much time (out of PHONE_QUEUE_TIMEOUT_SECONDS) to reserve as safety
// margin: once elapsed time crosses (timeout - buffer), the drain loop stops
// picking up new inbox items and instead hands off to a fresh chained Cloud
// Task, so we never get killed mid-turn (mid-LLM-call or mid-WhatsApp-send).
const TIME_BUDGET_BUFFER_MS = 45 * 1000;

// Per inbox-item retry ceiling. After this many failed attempts on the SAME
// message, stop retrying automatically (would otherwise tight-loop burning
// Groq/Firestore calls on a permanently-failing input) and dead-letter it
// instead, flagging the lead for human follow-up rather than silently
// dropping the message or wedging the rest of that phone's queue forever.
const MAX_ITEM_ATTEMPTS = 5;

// Base delay for re-chaining after a failed attempt, doubled per attempt
// (capped) — gives transient Firestore/Groq/WhatsApp failures time to clear
// instead of hammering them in a tight retry loop.
const RETRY_BACKOFF_BASE_SECONDS = 15;
const RETRY_BACKOFF_MAX_SECONDS = 300;

// --- Campaign queue engine -------------------------------------------------
// Dedicated queue for campaign-recipient dispatch tasks, separate from
// MESSAGE_QUEUE_NAME (inbound conversation processing) and
// FOLLOWUP_QUEUE_NAME (scheduled follow-ups) so a large campaign blast can
// never starve either of those, and so a future "pause" that acts on the
// Cloud Tasks queue itself (not just Firestore state) only affects campaign
// sends, not conversations.
const CAMPAIGN_QUEUE_NAME = "campaign-dispatch-queue";

// Same "time-boxed loop + self-chain" posture as PHONE_QUEUE_TIMEOUT_SECONDS
// / TIME_BUDGET_BUFFER_MS above, applied to campaign dispatch instead of
// inbox draining.
const CAMPAIGN_DISPATCH_TIMEOUT_SECONDS = 300;
const CAMPAIGN_DISPATCH_TIME_BUDGET_BUFFER_MS = 45 * 1000;

// How many "pending" recipients one loop iteration reads per Firestore
// round trip. Kept well under the 500 write/batch cap since each recipient
// in the chunk gets an individual Cloud Task creation call plus a batched
// Firestore update.
const CAMPAIGN_DISPATCH_CHUNK_SIZE = 200;

// A dispatch lock held longer than this is assumed abandoned (crashed
// execution) and can be stolen by a fresh dispatch trigger — same rationale
// as DISPATCHER_STALE_LOCK_MS, scoped to campaign dispatch instead of the
// per-phone inbox lock.
const CAMPAIGN_DISPATCH_LOCK_STALE_MS = 10 * 60 * 1000;

// --- Campaign recipient worker (processCampaignRecipient) -----------------
// Hard timeout for one recipient's send attempt. Generous relative to a
// single WhatsApp Cloud API call, but short enough that a genuinely hung
// invocation dies quickly and its send-claim (see
// CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS below) is soon eligible to be
// re-claimed rather than left permanently stuck.
const CAMPAIGN_RECIPIENT_TIMEOUT_SECONDS = 60;

// Same purpose/shape as processIncomingMessage.js's STALE_CLAIM_MS: a
// recipient's in-flight send claim older than this is assumed abandoned
// (crashed/killed execution) and can be re-claimed by a fresh delivery,
// instead of a crash permanently wedging that one recipient as "queued"
// forever.
const CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS = 5 * 60 * 1000;

// Per-recipient retry ceiling for transient (429/5xx/timeout) send failures.
// Same give-up posture as MAX_ITEM_ATTEMPTS above, scoped to one campaign
// recipient's own send attempts rather than one inbox item — after this many
// failed attempts the recipient is marked permanently "failed" instead of
// being retried indefinitely.
const CAMPAIGN_RECIPIENT_MAX_ATTEMPTS = 5;

// A follow-up claim ("sending_followup") held longer than this is assumed to
// belong to a crashed/failed attempt (e.g. sendWhatsAppTemplate threw after
// the claim committed) rather than a still-running one, and can be retried
// instead of being permanently skipped — see followupCheck.js.
const FOLLOWUP_CLAIM_STALE_MS = 5 * 60 * 1000;

// --- Cost estimation (metrics.js) ------------------------------------------
// Every rate below feeds metrics.js's cost/credit recorders. These are
// ESTIMATES for internal usage/cost tracking — the actual Groq and Meta
// invoices are the only billing source of truth. Nothing outside metrics.js
// reads these directly, so adjusting a rate here (a pricing change, a new
// model, a new Meta rate card) never requires touching a call site.

// Groq per-token USD pricing, keyed by the exact model string passed to
// `new ChatGroq({ model: ... })` elsewhere in this codebase (agent.js,
// intentClassifier.js, currentRequirementExtractor.js). Published per-1M-
// token rates, divided down to a per-token rate so metrics.js can multiply
// directly against raw token counts.
const LLM_PRICING_USD_PER_TOKEN = {
  "llama-3.3-70b-versatile": { input: 0.59 / 1_000_000, output: 0.79 / 1_000_000 },
  "llama-3.1-8b-instant": { input: 0.05 / 1_000_000, output: 0.08 / 1_000_000 },
};

// Fallback rate for any model string not in the table above (e.g. after a
// model swap the table hasn't been updated for yet), so usage is never
// silently recorded at $0 — it just falls back to the closest known rate
// (the main agent model) until the table is updated.
const LLM_PRICING_DEFAULT_USD_PER_TOKEN = LLM_PRICING_USD_PER_TOKEN["llama-3.3-70b-versatile"];

// Meta's own per-message charge, in USD, by WhatsApp conversation category
// (Meta's April-2025-era per-message pricing model). "service" covers
// free-form replies inside the customer-service window (AI/human agent
// replies, non-text acks) and is typically $0; "utility"/"marketing" cover
// business-initiated template sends (lead welcome, follow-up, campaigns);
// "authentication" is included for completeness even though this CRM
// doesn't currently send OTP-style templates. ADJUST THESE to your actual
// Meta rate card / country rate — they vary by destination country and
// change periodically.
const META_WHATSAPP_RATE_USD = {
  service: 0.0,
  utility: 0.02,
  marketing: 0.04,
  authentication: 0.03,
};

// Multiplier applied on top of META_WHATSAPP_RATE_USD to estimate the total
// "WhatsApp cost" line — Meta's own charge plus any BSP/platform markup this
// business pays on top of the raw Graph API rate. Set to 1.0 (no markup)
// when sending directly via Meta's own Graph API, as this codebase does.
const WHATSAPP_BSP_MARKUP_MULTIPLIER = 1.0;

// How many credits one estimated USD of spend (AI + WhatsApp combined)
// consumes. Purely a display/allocation unit for the dashboard's "Estimated
// Credits" figure — has no effect on what Groq/Meta actually bill.
const CREDITS_PER_USD = 100;

module.exports = {
  FB_VERIFY_TOKEN,
  FB_PAGE_ACCESS_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
  WHATSAPP_BUSINESS_ACCOUNT_ID,
  WHATSAPP_WELCOME_TEMPLATE,
  WHATSAPP_FOLLOWUP_TEMPLATE,
  GROQ_API_KEY,
  REGION,
  FOLLOWUP_QUEUE_NAME,
  MESSAGE_QUEUE_NAME,
  GRAPH_API_VERSION,
  DISPATCHER_STALE_LOCK_MS,
  PHONE_QUEUE_TIMEOUT_SECONDS,
  TIME_BUDGET_BUFFER_MS,
  MAX_ITEM_ATTEMPTS,
  RETRY_BACKOFF_BASE_SECONDS,
  RETRY_BACKOFF_MAX_SECONDS,
  CAMPAIGN_QUEUE_NAME,
  CAMPAIGN_DISPATCH_TIMEOUT_SECONDS,
  CAMPAIGN_DISPATCH_TIME_BUDGET_BUFFER_MS,
  CAMPAIGN_DISPATCH_CHUNK_SIZE,
  CAMPAIGN_DISPATCH_LOCK_STALE_MS,
  CAMPAIGN_RECIPIENT_TIMEOUT_SECONDS,
  CAMPAIGN_RECIPIENT_SEND_CLAIM_STALE_MS,
  CAMPAIGN_RECIPIENT_MAX_ATTEMPTS,
  FOLLOWUP_CLAIM_STALE_MS,
  LLM_PRICING_USD_PER_TOKEN,
  LLM_PRICING_DEFAULT_USD_PER_TOKEN,
  META_WHATSAPP_RATE_USD,
  WHATSAPP_BSP_MARKUP_MULTIPLIER,
  CREDITS_PER_USD,
};
