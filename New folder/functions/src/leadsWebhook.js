const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const axios = require("axios");

const {
  FB_VERIFY_TOKEN,
  WHATSAPP_CRED_ENC_KEY,
  GRAPH_API_VERSION,
} = require("./config");
const { sendWhatsAppTemplate } = require("./whatsapp");
const { createFollowupTask } = require("./cloudTasks");
const { recordLeadCreated, recordWhatsAppSystemSend } = require("./metrics");
const { agencyCollection, agencySettingsRef, resolveAgencyIdForWebhook } = require("./tenancy");
const { loadWhatsAppCredentials, WhatsAppNotConnectedError } = require("./whatsappCredentials");
const { loadFacebookCredentials, FacebookNotConnectedError } = require("./facebookCredentials");

/**
 * Fetches the full field data for a lead from the Graph API and pulls out
 * the name + phone number. Pattern adapted from fbsamples/lead-ads-webhook-sample.
 */
async function fetchLeadDetails(leadgenId, pageAccessToken) {
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${leadgenId}`;
  const { data } = await axios.get(url, {
    params: { access_token: pageAccessToken },
  });

  // field_data looks like: [{ name: "full_name", values: ["Jane Doe"] }, ...]
  const fields = {};
  for (const field of data.field_data || []) {
    fields[field.name] = field.values && field.values[0];
  }

  const name = fields.full_name || fields.name || "there";
  // Meta lead forms typically label this "phone_number".
  let phone = fields.phone_number || fields.phone || "";
  // Normalize to digits only (WhatsApp Cloud API wants no "+", no spaces/dashes).
  phone = phone.replace(/[^\d]/g, "");

  return { name, phone };
}

const leadsWebhook = onRequest(
  {
    secrets: [FB_VERIFY_TOKEN, WHATSAPP_CRED_ENC_KEY],
    region: "us-central1",
  },
  async (req, res) => {
    // --- GET: Meta's webhook verification handshake ---------------------
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      if (mode === "subscribe" && token === FB_VERIFY_TOKEN.value()) {
        logger.info("leadsWebhook: verification succeeded");
        res.status(200).send(challenge);
      } else {
        logger.warn("leadsWebhook: verification failed", { mode });
        res.sendStatus(403);
      }
      return;
    }

    // --- POST: new leadgen event -----------------------------------------
    if (req.method === "POST") {
      try {
        const body = req.body;

        if (body.object !== "page") {
          res.sendStatus(404);
          return;
        }

        const projectId = process.env.GCLOUD_PROJECT;

        for (const entry of body.entry || []) {
          // MULTI-TENANCY: `entry.id` is the Facebook Page ID this leadgen
          // event came in on. Each agency registers its own Page ID via
          // tenancy.js's setAgencyRouting (a follow-up onboarding phase) —
          // resolving it here is what lets ALL of this webhook's Firestore
          // writes below land under the correct `agencies/{agencyId}/...`
          // subtree instead of a shared global one. See tenancy.js's header
          // for why this falls back to DEFAULT_AGENCY_ID today.
          const db = admin.firestore();
          const agencyId = await resolveAgencyIdForWebhook(db, "fbPageId", entry.id);

          for (const change of entry.changes || []) {
            if (change.field !== "leadgen") continue;

            const { leadgen_id: leadgenId } = change.value || {};
            if (!leadgenId) continue;

            // Meta redelivers leadgen webhooks (on slow responses, retries,
            // occasional dupes) exactly like it does message webhooks. This
            // handler previously had NO dedup at all, which meant a
            // redelivery would: (a) resend the welcome template to a lead
            // who already got it, (b) schedule a SECOND 24h follow-up task
            // for the same lead, and (c) — worst — blindly overwrite
            // `conversationHistory: []` even if the lead had already started
            // chatting, silently wiping their conversation. Guard the whole
            // thing with the same atomic claim pattern used for inbound
            // messages, keyed by leadgen_id.
            const dedupeRef = agencyCollection(db, agencyId, "processedLeadgenEvents").doc(leadgenId);
            const alreadyHandled = await db.runTransaction(async (tx) => {
              const dedupeSnap = await tx.get(dedupeRef);
              if (dedupeSnap.exists) return true;
              tx.set(dedupeRef, {
                handledAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              return false;
            });

            if (alreadyHandled) {
              logger.info("leadsWebhook: duplicate leadgen delivery, skipping", { leadgenId });
              continue;
            }

            // MULTI-TENANCY: fetch this lead's details using THIS agency's
            // own connected Facebook Page — not a global page token (see
            // facebookCredentials.js). A lead can only be created once we
            // have its name/phone from this call, so if the agency hasn't
            // connected a Facebook Page yet (or its token has gone bad),
            // there is nothing to create yet; log and move on rather than
            // throwing (Meta would otherwise retry-storm this delivery).
            let pageAccessToken;
            try {
              const fbCreds = await loadFacebookCredentials(db, agencyId);
              pageAccessToken = fbCreds.pageAccessToken;
            } catch (err) {
              if (err instanceof FacebookNotConnectedError) {
                logger.warn("leadsWebhook: agency has no connected Facebook Page, skipping leadgen event", {
                  agencyId,
                  pageId: entry.id,
                  leadgenId,
                });
                continue;
              }
              throw err;
            }

            const { name, phone } = await fetchLeadDetails(leadgenId, pageAccessToken);

            if (!phone) {
              logger.error("leadsWebhook: lead had no phone number", { leadgenId });
              continue;
            }

            const leadRef = agencyCollection(db, agencyId, "leads").doc(phone);
            const existingSnap = await leadRef.get();

            // Only initialize conversationHistory for a brand-new lead —
            // never stomp an existing conversation just because the same
            // (or a second) leadgen event came in for this phone number.
            const leadDoc = {
              name,
              phone,
              status: "pending",
            };
            const isNewLead = !existingSnap.exists;
            if (isNewLead) {
              leadDoc.createdAt = admin.firestore.FieldValue.serverTimestamp();
              leadDoc.conversationHistory = [];
            }
            await leadRef.set(leadDoc, { merge: true });

            // METRICS: dedup above (processedLeadgenEvents) already makes this
            // a one-time event per leadgen_id, so this fires exactly once per
            // real new lead — see metrics.js's IDEMPOTENCY note.
            if (isNewLead) {
              await recordLeadCreated(db, agencyId);
            }

            // 1. Send the WhatsApp welcome template — using THIS agency's
            // own connected WhatsApp Business Account and its own approved
            // welcome template, not a global one. A lead is still created
            // even if the agency's WhatsApp isn't connected/configured yet
            // (so nothing is lost), it just won't get an automatic welcome
            // message or follow-up until that's fixed.
            let sentWelcome = false;
            try {
              const creds = await loadWhatsAppCredentials(db, agencyId);
              const settingsSnap = await agencySettingsRef(db, agencyId).get();
              const welcomeTemplateName = settingsSnap.exists
                ? settingsSnap.data()?.welcomeTemplateName
                : null;

              if (!welcomeTemplateName) {
                logger.warn("leadsWebhook: no welcome template configured for agency, skipping send", {
                  agencyId,
                  phone,
                });
              } else {
                await sendWhatsAppTemplate({
                  to: phone,
                  templateName: welcomeTemplateName,
                  whatsappToken: creds.whatsappToken,
                  phoneNumberId: creds.phoneNumberId,
                });
                await recordWhatsAppSystemSend(db, agencyId, "utility");
                sentWelcome = true;
              }
            } catch (err) {
              if (err instanceof WhatsAppNotConnectedError) {
                logger.warn("leadsWebhook: agency has no connected WhatsApp account, skipping welcome send", {
                  agencyId,
                  phone,
                });
              } else {
                throw err;
              }
            }

            // 2. Schedule exactly one follow-up check, 24h from now — only
            // if the welcome actually went out; otherwise there's nothing
            // for followupCheck.js to have followed up ON yet.
            if (sentWelcome) {
              await createFollowupTask(phone, agencyId, projectId);
            }

            logger.info("leadsWebhook: processed new lead", { phone, agencyId });
          }
        }

        res.sendStatus(200);
      } catch (err) {
        logger.error("leadsWebhook: error processing request", err);
        // Still return 200 so Meta doesn't retry-storm us; the error is logged for debugging.
        res.sendStatus(200);
      }
      return;
    }

    res.sendStatus(405);
  }
);

module.exports = { leadsWebhook };
