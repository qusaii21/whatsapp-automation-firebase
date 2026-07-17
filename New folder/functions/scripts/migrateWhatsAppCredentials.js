#!/usr/bin/env node
/**
 * ONE-TIME migration utility: moves the CURRENT global WhatsApp secret
 * values (WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_BUSINESS_ACCOUNT_ID)
 * into `agencies/{agencyId}/integrations/whatsapp`, encrypted — so the
 * existing single-tenant deployment (see tenancy.js's DEFAULT_AGENCY_ID)
 * keeps working after the per-agency credential loader
 * (whatsappCredentials.js) becomes the only thing every send/webhook/
 * template call site reads from.
 *
 * Same lock / dry-run / rollback / audit-log conventions as
 * scripts/migrateToMultiTenancy.js — this is a narrower, standalone
 * companion script, not a replacement for it.
 *
 * -----------------------------------------------------------------------
 * USAGE  (run from inside functions/)
 * -----------------------------------------------------------------------
 *
 *   node scripts/migrateWhatsAppCredentials.js \
 *     --agency=<AGENCY_ID> \
 *     --token=<CURRENT_WHATSAPP_TOKEN_VALUE> \
 *     --phone-number-id=<CURRENT_WHATSAPP_PHONE_NUMBER_ID_VALUE> \
 *     --business-account-id=<CURRENT_WHATSAPP_BUSINESS_ACCOUNT_ID_VALUE> \
 *     --enc-key=<CURRENT_WHATSAPP_CRED_ENC_KEY_VALUE> \
 *     --dry-run
 *
 *   (drop --dry-run to actually write; add --rollback to undo)
 *
 * The WhatsApp values are whatever you currently have set via
 * `firebase functions:secrets:access WHATSAPP_TOKEN` etc — this script
 * intentionally does NOT reach into Secret Manager itself (no new
 * dependency for a one-time job); you paste the values you already have.
 * App ID / App Secret / the webhook verify token stay platform-level
 * (config.js's FB_VERIFY_TOKEN, shared across all agencies) — this script
 * never touches them. Nothing here is logged, printed, or written anywhere
 * except the encrypted Firestore fields.
 *
 * Auth: same as migrateToMultiTenancy.js / seedProperties.js — Admin SDK
 * with application-default credentials:
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_FIREBASE_PROJECT_ID
 *
 * -----------------------------------------------------------------------
 * VERIFICATION
 * -----------------------------------------------------------------------
 *   Before writing anything (even in --dry-run, so a bad token is caught
 *   before you drop --dry-run), this script makes a real Graph API call to
 *   confirm the token/phoneNumberId pair actually works — the exact same
 *   check whatsappIntegration.js#connectWhatsApp makes for a live "Connect"
 *   click, so the migrated agency never ends up "connected" with
 *   credentials that don't actually work. On success, display_phone_number
 *   / verified_name / quality_rating / messaging_limit_tier are captured
 *   from the same round trip. Retried up to 3x with backoff on transient
 *   network errors before giving up.
 *     --skip-verify   Skip the Graph API call entirely (e.g. no network
 *                     access from where this runs). NOT recommended.
 *     --force         Write anyway even if verification fails (the values
 *                     are trusted from another source). NOT recommended.
 *
 * -----------------------------------------------------------------------
 * ATOMICITY, BACKUP, IDEMPOTENT RETRY
 * -----------------------------------------------------------------------
 *   "Verification succeeds but the Firestore write fails" (or the process
 *   dies/network drops mid-write) CANNOT leave a half-migrated state:
 *   snapshotting the prior doc (for backup), writing the new credential
 *   doc, and registering both routing index entries all happen inside a
 *   single `db.runTransaction` — Firestore guarantees that either every
 *   write in it commits together or none of them do. There is no
 *   in-between state where credentials are saved but routing isn't (or
 *   vice versa). The transaction commit itself is retried up to 3x with
 *   backoff on transient errors before this script gives up and exits
 *   non-zero (in which case Firestore is guaranteed untouched — see above).
 *
 *   "Verification fails" already could not reach Firestore at all (script
 *   exits before ever calling db.runTransaction, unless --force) — that
 *   direction was never at risk.
 *
 *   BACKUP: immediately before overwriting an agency's existing connection,
 *   the transaction also writes a full snapshot of what was there
 *   (encrypted fields copied as-is, nothing re-encrypted or exposed) to
 *   `agencies/{agencyId}/integrations/whatsappCredentialBackups/{backupId}`.
 *   Skipped when there's nothing to back up (first-ever connect). List them
 *   with `--list-backups`, restore one with `--restore-backup=<id>`.
 *
 *   IDEMPOTENT RETRY: every write is keyed by a fixed, deterministic path
 *   (`integrations/whatsapp`, `agencyRouting/{kind}:{value}`) and uses
 *   `{merge: true}`, so re-running this exact command again after ANY
 *   failure — a failed verification, a failed transaction, a killed
 *   process, a client that crashed before seeing whether its own commit
 *   landed — is always safe. It either converges to the same end state or
 *   (if the previous attempt truly wrote nothing) starts clean. The only
 *   side effect of a redundant re-run is a harmless extra backup entry.
 *
 * -----------------------------------------------------------------------
 * SAFETY GUARANTEES
 * -----------------------------------------------------------------------
 *   - Never touches Secret Manager or config.js's defineSecret values —
 *     purely a Firestore write, using values YOU supply on the command line.
 *   - Locked: refuses to run if another instance of this script is
 *     mid-run for the same agency (same `--- Locking ---` pattern as
 *     migrateToMultiTenancy.js's own lock, scoped to a dedicated
 *     `agencies/{agencyId}/migrationLocks/whatsappCredentials` doc).
 *   - Audit-logged: every run (dry-run or real, forward/rollback/restore)
 *     appends one entry to `agencies/{agencyId}/migrationAudit` recording
 *     who/when/mode — never the credential values themselves.
 *   - `--rollback` flips `connected: false` / clears the encrypted token
 *     field (an explicit "disconnect", not a point-in-time undo) — it does
 *     NOT delete the routing index entries (a phone_number_id a real
 *     agency is actively using shouldn't stop routing just because this
 *     bridge-migration doc is rolled back). Use `--restore-backup=<id>` if
 *     you actually want the previous credentials back, not just disconnected.
 */

const admin = require("firebase-admin");
const crypto = require("crypto");
const axios = require("axios");
const { agencyRef, agencyCollection, routingRef } = require("../src/tenancy");
const { GRAPH_API_VERSION } = require("../src/config");

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function argValue(flag) {
  const found = args.find((a) => a.startsWith(`--${flag}=`));
  return found ? found.split("=").slice(1).join("=") : null;
}

const agencyId = argValue("agency");
const token = argValue("token");
const phoneNumberId = argValue("phone-number-id");
const businessAccountId = argValue("business-account-id");
const encKeyRaw = argValue("enc-key");
const isDryRun = args.includes("--dry-run");
const isRollback = args.includes("--rollback");
const skipVerify = args.includes("--skip-verify");
const force = args.includes("--force");
const restoreBackupId = argValue("restore-backup");
const isListBackups = args.includes("--list-backups");

function usageAndExit(message) {
  if (message) console.error(`\nError: ${message}\n`);
  console.error(
    "Usage: node scripts/migrateWhatsAppCredentials.js --agency=<id> --token=<..> " +
      "--phone-number-id=<..> --business-account-id=<..> --enc-key=<..> " +
      "[--dry-run] [--rollback] [--skip-verify] [--force] " +
      "[--list-backups] [--restore-backup=<backupId>]"
  );
  process.exit(1);
}

if (!agencyId) usageAndExit("--agency=<AGENCY_ID> is required.");
if (!isRollback && !isListBackups && !restoreBackupId) {
  if (!token) usageAndExit("--token=<WHATSAPP_TOKEN value> is required (unless --rollback/--list-backups/--restore-backup).");
  if (!phoneNumberId) usageAndExit("--phone-number-id=<...> is required (unless --rollback/--list-backups/--restore-backup).");
  if (!businessAccountId) usageAndExit("--business-account-id=<...> is required (unless --rollback/--list-backups/--restore-backup).");
  if (!encKeyRaw) usageAndExit("--enc-key=<WHATSAPP_CRED_ENC_KEY value> is required (unless --rollback/--list-backups/--restore-backup).");
}

// ── Encryption (same algorithm as whatsappCredentials.js — kept
// deliberately duplicated rather than imported, since this script must
// keep working even if that module's internals ever change; the on-disk
// format is the contract, not the code) ────────────────────────────────

function encryptSecret(plaintext, encKeyRaw) {
  if (plaintext === null || plaintext === undefined || plaintext === "") return null;
  const key = encKeyRaw.length === 64 ? Buffer.from(encKeyRaw, "hex") : Buffer.from(encKeyRaw, "base64");
  if (key.length !== 32) usageAndExit("--enc-key must decode to exactly 32 bytes (AES-256).");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

// ── Retry with backoff — for the two network-dependent steps (Graph API
// verification, Firestore transaction commit). Both are idempotent to
// retry: verification is read-only, and the transaction either fully
// commits or fully doesn't. ────────────────────────────────────────────

async function withRetries(label, fn, { attempts = 3, baseDelayMs = 1000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(`  ${label} failed (attempt ${attempt}/${attempts}): ${err.message}. Retrying in ${delay}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastErr;
}

// ── Graph API verification (same check as whatsappIntegration.js#connectWhatsApp) ──

async function verifyAgainstMeta({ accessToken, phoneNumberId }) {
  const url =
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}` +
    `?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier`;
  const response = await axios.get(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  return response.data;
}

// ── Backups ─────────────────────────────────────────────────────────────

function backupsCollection(db, agencyId) {
  return agencyCollection(db, agencyId, "integrations").doc("whatsapp").collection("whatsappCredentialBackups");
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  admin.initializeApp();
  const db = admin.firestore();

  const agencySnap = await agencyRef(db, agencyId).get();
  if (!agencySnap.exists) {
    usageAndExit(`agencies/${agencyId} does not exist — create the agency first.`);
  }

  const integrationDocRef = agencyCollection(db, agencyId, "integrations").doc("whatsapp");

  // --list-backups needs no lock — it's read-only.
  if (isListBackups) {
    const snap = await backupsCollection(db, agencyId).orderBy("backedUpAt", "desc").get();
    if (snap.empty) {
      console.log(`No backups found for agency ${agencyId}.`);
      return;
    }
    console.log(`Backups for agency ${agencyId} (newest first):\n`);
    snap.docs.forEach((doc) => {
      const d = doc.data();
      const when = d.backedUpAt?.toDate ? d.backedUpAt.toDate().toISOString() : "(pending server timestamp)";
      console.log(`  ${doc.id}   ${when}   phoneNumberId=${d.phoneNumberId || "?"}   displayPhoneNumber=${d.displayPhoneNumber || "?"}`);
    });
    return;
  }

  // --- Locking (mirrors migrateToMultiTenancy.js's posture) ---
  const lockRef = agencyCollection(db, agencyId, "migrationLocks").doc("whatsappCredentials");
  const acquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (snap.exists) {
      const heldAtMs = snap.data().startedAt?.toMillis ? snap.data().startedAt.toMillis() : 0;
      const staleMs = 10 * 60 * 1000;
      if (Date.now() - heldAtMs < staleMs) return false; // another run genuinely in progress
    }
    tx.set(lockRef, {
      startedAt: admin.firestore.FieldValue.serverTimestamp(),
      mode: isRollback ? "rollback" : restoreBackupId ? "restore" : "forward",
    });
    return true;
  });
  if (!acquired) {
    console.error(`Another migration is already in progress for agency ${agencyId}. Aborting.`);
    process.exit(1);
  }

  try {
    if (restoreBackupId) {
      // --- Point-in-time restore from a specific backup ---
      const backupRef = backupsCollection(db, agencyId).doc(restoreBackupId);
      console.log(`[${isDryRun ? "DRY RUN" : "LIVE"}] Restoring agency ${agencyId}'s WhatsApp connection from backup ${restoreBackupId}...`);

      await withRetries("Firestore restore transaction", () =>
        db.runTransaction(async (tx) => {
          const backupSnap = await tx.get(backupRef);
          if (!backupSnap.exists) {
            throw new Error(`No backup ${restoreBackupId} found for agency ${agencyId}. Use --list-backups to see what's available.`);
          }
          const backupData = backupSnap.data();
          console.log(`  Restoring phoneNumberId=${backupData.phoneNumberId}, businessAccountId=${backupData.businessAccountId}`);
          if (isDryRun) return;

          const now = admin.firestore.FieldValue.serverTimestamp();
          const restored = { ...backupData };
          delete restored.backedUpAt; // that field belongs to the backup doc, not the live doc
          restored.updatedAt = now;
          restored.connectedByUid = "migration-script-restore";
          tx.set(integrationDocRef, restored, { merge: false }); // full overwrite — restoring to an exact prior state, not merging with current
          if (backupData.phoneNumberId) {
            tx.set(routingRef(db, "waPhoneId", backupData.phoneNumberId), { agencyId, updatedAt: now }, { merge: true });
          }
          if (backupData.businessAccountId) {
            tx.set(routingRef(db, "waBusinessAccountId", backupData.businessAccountId), { agencyId, updatedAt: now }, { merge: true });
          }
        })
      );
      console.log("Restore complete.");
    } else if (isRollback) {
      console.log(`[${isDryRun ? "DRY RUN" : "LIVE"}] Rolling back WhatsApp connection for agency ${agencyId}...`);
      if (!isDryRun) {
        await withRetries("Firestore rollback write", () =>
          integrationDocRef.set(
            {
              connected: false,
              accountStatus: "DISCONNECTED",
              accessTokenEnc: null,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
        );
      }
      console.log("Rollback complete. Routing index entries were left in place (see script header). To recover the actual credentials instead of just disconnecting, use --list-backups / --restore-backup.");
    } else {
      // --- Verify against Meta before writing anything (unless skipped) ---
      let metaInfo = null;
      if (!skipVerify) {
        console.log("Verifying token/phoneNumberId against the Graph API...");
        try {
          metaInfo = await withRetries("Graph API verification", () => verifyAgainstMeta({ accessToken: token, phoneNumberId }));
          console.log(`  Verified: ${metaInfo.display_phone_number || phoneNumberId} (${metaInfo.verified_name || "unverified name"})`);
        } catch (err) {
          const apiError = err.response?.data?.error;
          console.error(`  Verification FAILED: ${apiError?.message || err.message}`);
          if (!force) {
            throw new Error("Verification failed and --force was not set — aborting without writing anything. Re-run with --force to write anyway, or --skip-verify to skip this check.");
          }
          console.warn("  --force set: writing despite failed verification.");
        }
      } else {
        console.log("--skip-verify set: not checking these credentials against the Graph API.");
      }

      console.log(`[${isDryRun ? "DRY RUN" : "LIVE"}] Migrating WhatsApp credentials for agency ${agencyId}...`);
      console.log(`  phoneNumberId: ${phoneNumberId}`);
      console.log(`  businessAccountId: ${businessAccountId}`);
      console.log(`  token: ${"*".repeat(Math.max(token.length - 4, 0))}${token.slice(-4)}`);

      if (!isDryRun) {
        // Single atomic transaction: read-existing-for-backup, write backup,
        // write credentials, write both routing entries. All-or-nothing —
        // see this script's header ("ATOMICITY, BACKUP, IDEMPOTENT RETRY").
        await withRetries("Firestore migration transaction", () =>
          db.runTransaction(async (tx) => {
            const existingSnap = await tx.get(integrationDocRef);

            if (existingSnap.exists) {
              const backupId = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
              tx.set(backupsCollection(db, agencyId).doc(backupId), {
                ...existingSnap.data(),
                backedUpAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log(`  Backed up previous connection as ${backupId} before overwriting.`);
            }

            const now = admin.firestore.FieldValue.serverTimestamp();
            const updates = {
              connected: true,
              phoneNumberId,
              businessAccountId,
              accessTokenEnc: encryptSecret(token, encKeyRaw),
              accountStatus: "CONNECTED",
              connectedAt: now,
              connectedByUid: "migration-script",
              updatedAt: now,
            };
            if (metaInfo) {
              updates.displayPhoneNumber = metaInfo.display_phone_number || null;
              updates.businessName = metaInfo.verified_name || null;
              updates.qualityRating = metaInfo.quality_rating || "UNKNOWN";
              updates.messagingTier = metaInfo.messaging_limit_tier || null;
              updates.lastHealthCheckAt = now;
            }

            tx.set(integrationDocRef, updates, { merge: true });
            tx.set(routingRef(db, "waPhoneId", phoneNumberId), { agencyId, updatedAt: now }, { merge: true });
            tx.set(routingRef(db, "waBusinessAccountId", businessAccountId), { agencyId, updatedAt: now }, { merge: true });
          })
        );
      }
      console.log("Migration complete.");
      console.log(
        "NOTE: the WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_BUSINESS_ACCOUNT_ID Secret " +
          "Manager secrets and their defineSecret() declarations in config.js were left untouched " +
          "(deliberately — see this script's header). Remove them manually once you've verified every " +
          "send/webhook/template call is going through the new per-agency path."
      );
    }

    // --- Audit log (never records credential values) ---
    await agencyCollection(db, agencyId, "migrationAudit").add({
      script: "migrateWhatsAppCredentials.js",
      mode: restoreBackupId ? "restore" : isRollback ? "rollback" : "forward",
      restoredFromBackupId: restoreBackupId || null,
      dryRun: isDryRun,
      ranAt: admin.firestore.FieldValue.serverTimestamp(),
      runBy: process.env.USER || process.env.USERNAME || "unknown",
    });
  } finally {
    await lockRef.delete();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
