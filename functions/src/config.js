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
const GRAPH_API_VERSION = "v20.0";

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
  GRAPH_API_VERSION,
};
