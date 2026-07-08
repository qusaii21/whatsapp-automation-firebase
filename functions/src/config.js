const { defineSecret } = require("firebase-functions/params");

// Every secret is declared here with defineSecret so each function can list
// exactly which secrets it needs (via { secrets: [...] } in its options) and
// Firebase will inject them as env vars at runtime.

const FB_VERIFY_TOKEN = defineSecret("FB_VERIFY_TOKEN");
const FB_PAGE_ACCESS_TOKEN = defineSecret("FB_PAGE_ACCESS_TOKEN");
const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID");
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

module.exports = {
  FB_VERIFY_TOKEN,
  FB_PAGE_ACCESS_TOKEN,
  WHATSAPP_TOKEN,
  WHATSAPP_PHONE_NUMBER_ID,
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
};
