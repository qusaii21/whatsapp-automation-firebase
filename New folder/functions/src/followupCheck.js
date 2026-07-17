const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

const { WHATSAPP_CRED_ENC_KEY, FOLLOWUP_CLAIM_STALE_MS } = require("./config");
const { sendWhatsAppTemplate } = require("./whatsapp");
const { recordWhatsAppSystemSend } = require("./metrics");
const { agencyCollection, agencySettingsRef } = require("./tenancy");
const { loadWhatsAppCredentials, WhatsAppNotConnectedError } = require("./whatsappCredentials");

/**
 * Called exactly once, 24 hours after a lead was created, by the Cloud Task
 * scheduled in leadsWebhook. Not a cron job — this instance only ever looks
 * at the single lead named in its payload.
 *
 * `invoker: "private"` (see index.js) means only requests carrying a valid
 * OIDC token for the configured service account (i.e. Cloud Tasks) will
 * reach this handler at all.
 */
const followupCheck = onRequest(
  {
    secrets: [WHATSAPP_CRED_ENC_KEY],
    region: "us-central1",
    invoker: "private",
  },
  async (req, res) => {
    try {
      const { phone, agencyId } = req.body || {};
      if (!phone || !agencyId) {
        res.status(400).send("Missing phone/agencyId in task payload");
        return;
      }

      const db = admin.firestore();
      const leadRef = agencyCollection(db, agencyId, "leads").doc(phone);
      const snap = await leadRef.get();

      if (!snap.exists) {
        logger.warn("followupCheck: lead no longer exists", { phone });
        res.sendStatus(200);
        return;
      }

      const lead = snap.data();

      if (lead.status === "pending" || lead.status === "sending_followup") {
        // Resolve this agency's connection + its own approved follow-up
        // template BEFORE claiming the lead — a claim that can't actually
        // be fulfilled (no WhatsApp connection, or no follow-up template
        // configured) should never flip status away from "pending", or the
        // lead would be stuck with no automatic retry path.
        let creds;
        try {
          creds = await loadWhatsAppCredentials(db, agencyId);
        } catch (err) {
          if (err instanceof WhatsAppNotConnectedError) {
            logger.warn("followupCheck: agency has no connected WhatsApp account, skipping", { agencyId, phone });
            res.sendStatus(200);
            return;
          }
          throw err;
        }

        const settingsSnap = await agencySettingsRef(db, agencyId).get();
        const followupTemplateName = settingsSnap.exists ? settingsSnap.data()?.followupTemplateName : null;
        if (!followupTemplateName) {
          logger.warn("followupCheck: no follow-up template configured for agency, skipping", {
            agencyId,
            phone,
          });
          res.sendStatus(200);
          return;
        }

        // Same at-least-once-delivery hazard as processIncomingMessage: if
        // this function times out or crashes AFTER sendWhatsAppTemplate()
        // succeeds but BEFORE the status update commits, Cloud Tasks will
        // retry and status is still "pending" — sending a second follow-up.
        // Atomically flip status to a transitional "sending_followup" state
        // first so a retry that lands after a successful send sees a status
        // other than "pending" and skips.
        //
        // LOOPHOLE FIX: this used to only ever check `status === "pending"`,
        // so a crash AFTER the claim committed but BEFORE
        // sendWhatsAppTemplate actually succeeded left the lead permanently
        // stuck at "sending_followup" — no code path ever retried it, and the
        // follow-up was silently lost forever (this was previously called
        // out as a known, accepted trade-off in this comment; a stale-claim
        // check closes it using the same STALE_CLAIM_MS pattern already used
        // elsewhere in this codebase, e.g. processIncomingMessage.js).
        const claimed = await db.runTransaction(async (tx) => {
          const freshSnap = await tx.get(leadRef);
          if (!freshSnap.exists) return false;
          const freshData = freshSnap.data();

          if (freshData.status === "sending_followup") {
            const claimedAtMs = freshData.followupClaimedAt?.toMillis
              ? freshData.followupClaimedAt.toMillis()
              : 0;
            const isStale = Date.now() - claimedAtMs > FOLLOWUP_CLAIM_STALE_MS;
            if (!isStale) return false; // a healthy attempt is still in flight
          } else if (freshData.status !== "pending") {
            return false; // already progressed past follow-up entirely
          }

          tx.update(leadRef, {
            status: "sending_followup",
            followupClaimedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return true;
        });

        if (!claimed) {
          logger.info("followupCheck: lost race or already handled, no-op", { phone });
          res.sendStatus(200);
          return;
        }

        await sendWhatsAppTemplate({
          to: phone,
          templateName: followupTemplateName,
          whatsappToken: creds.whatsappToken,
          phoneNumberId: creds.phoneNumberId,
        });
        // METRICS: only reached after winning the "sending_followup" claim
        // transaction above, which is what makes this exactly-once across
        // Cloud Tasks redeliveries — see that transaction's own comment.
        await recordWhatsAppSystemSend(db, agencyId, "utility");

        await leadRef.update({ status: "followed_up" });
        logger.info("followupCheck: sent follow-up", { phone });
      } else {
        logger.info("followupCheck: lead already progressed, no-op", {
          phone,
          status: lead.status,
        });
      }

      res.sendStatus(200);
    } catch (err) {
      logger.error("followupCheck: error", err);
      res.sendStatus(500); // 500 lets Cloud Tasks retry per the queue's retry config.
    }
  }
);

module.exports = { followupCheck };
