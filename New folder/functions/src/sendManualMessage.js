const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_CRED_ENC_KEY } = require("./config");
const { sendWhatsAppText } = require("./whatsapp");
const { recordHumanMessageSent } = require("./metrics");
const { agencyCollection } = require("./tenancy");
const { requireAuthContext, AuthError } = require("./auth");
const { loadWhatsAppCredentials, WhatsAppNotConnectedError } = require("./whatsappCredentials");

/**
 * HUMAN AGENT MODE — manual send endpoint.
 *
 * This is the ONLY function in the project meant to be called directly from
 * the browser (every other function is a Meta/Cloud-Tasks webhook target).
 * The CRM has no server layer of its own — it normally talks to Firestore
 * straight from the client SDK — but sending a WhatsApp message requires the
 * WHATSAPP_TOKEN secret, which must never reach the browser. So this thin
 * endpoint exists purely to let a human agent's typed message reach the
 * WhatsApp Cloud API, using the exact same `sendWhatsAppText` helper the AI
 * pipeline already uses (see whatsapp.js) — no new send path, no duplicated
 * Graph API logic.
 *
 * It writes the exact same turn SHAPE the AI pipeline writes
 * (`{ role, text, timestamp }`, see processPhoneQueue.js's `assistantTurn`),
 * plus `sentBy: "human"` so the CRM thread (ConversationThread.jsx already
 * checks for this — via `sentBy === "human"`, not `role`) can render it
 * distinctly from an AI reply. Because it's appended to the SAME
 * `conversationHistory` array the AI reads from, the moment a lead is
 * switched back to AI mode, `runAgent` sees this message like any other past
 * assistant turn (see agent.js's `historyToMessages`, which treats every
 * non-"user" role as an AIMessage) — no separate merge step needed for the
 * "AI continues seamlessly" requirement.
 *
 * IMPORTANT: `role` here MUST be `"assistant"`, matching every other
 * bot-side turn — NOT a distinct `"agent"` role. agent.js's requirement-
 * extraction step (`.find((turn) => turn.role === "assistant")`, used to
 * look up "what did we just say to this customer" for detecting a changed
 * requirement) filters specifically on `role === "assistant"`. A distinct
 * `"agent"` role would make that lookup silently skip straight past a human
 * agent's reply to an OLDER bot turn (or find nothing) every time a human
 * agent's message is the most recent one before the customer's next
 * message — corrupting that context for no visible error. `sentBy: "human"`
 * is what the UI actually keys off for the "Human agent" badge, so `role`
 * is free to stay consistent with the rest of the pipeline.
 *
 * Deliberately does NOT touch `leads/{phone}/opportunities/*` — the
 * customer -> opportunities architecture is exclusively updated by the AI
 * pipeline in processPhoneQueue.js, and this feature must not change that.
 */
const sendManualMessage = onRequest(
  {
    secrets: [WHATSAPP_CRED_ENC_KEY],
    region: "us-central1",
    cors: true,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.sendStatus(405);
      return;
    }

    try {
      const { agencyId } = await requireAuthContext(req, { roles: ["owner", "admin", "agent"] });
      const { phone, text } = req.body || {};

      if (!phone || typeof phone !== "string") {
        res.status(400).json({ error: "Missing or invalid 'phone'" });
        return;
      }

      const trimmedText = typeof text === "string" ? text.trim() : "";
      if (!trimmedText) {
        res.status(400).json({ error: "Missing or empty 'text'" });
        return;
      }

      const db = admin.firestore();
      const creds = await loadWhatsAppCredentials(db, agencyId);

      // Send first — if the WhatsApp Cloud API call fails, we don't want a
      // message sitting in the CRM's history claiming it was delivered.
      await sendWhatsAppText({
        to: phone,
        text: trimmedText,
        whatsappToken: creds.whatsappToken,
        phoneNumberId: creds.phoneNumberId,
      });

      // METRICS: one HTTP call -> one send -> one metrics update, same
      // one-shot posture as this endpoint's own Firestore write below.
      await recordHumanMessageSent(db, agencyId);
      const leadRef = agencyCollection(db, agencyId, "leads").doc(phone);

      const turn = {
        role: "assistant",
        text: trimmedText,
        timestamp: Date.now(),
        sentBy: "human",
      };

      const snap = await leadRef.get();
      const updates = {
        conversationHistory: admin.firestore.FieldValue.arrayUnion(turn),
        lastMessageAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      // Mirror the AI pipeline's own status bookkeeping (processPhoneQueue.js)
      // so a manually-answered lead doesn't keep showing as "pending" — but
      // never downgrade a lead that's already further along (e.g. qualified).
      const currentStatus = snap.exists ? snap.data().status : null;
      if (currentStatus !== "qualified" && currentStatus !== "visit_requested") {
        updates.status = "replied";
      }

      await leadRef.set(updates, { merge: true });

      logger.info("sendManualMessage: sent", { phone });
      res.status(200).json({ ok: true, turn });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      if (err instanceof WhatsAppNotConnectedError) {
        res.status(409).json({ error: err.message, code: "not_connected" });
        return;
      }
      logger.error("sendManualMessage: failed", {
        error: err.message,
        stack: err.stack,
      });
      res.status(500).json({ error: "Failed to send message" });
    }
  }
);

module.exports = { sendManualMessage };
