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
};
