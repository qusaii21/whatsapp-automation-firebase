#!/usr/bin/env node
/**
 * ONE-TIME migration utility: copies pre-multi-tenancy root-level Firestore
 * data into the new `agencies/{agencyId}/...` structure.
 *
 * This script does NOT touch tenancy.js, Cloud Functions, Cloud Tasks
 * queues, webhooks, auth, or the frontend. It only reads from the OLD root
 * collections and writes to the NEW `agencies/{agencyId}/...` collections,
 * using the exact same collection names and document IDs. It is a
 * standalone, offline, terminal-run script — it is never deployed as a
 * Cloud Function.
 *
 * -----------------------------------------------------------------------
 * USAGE  (run from inside functions/)
 * -----------------------------------------------------------------------
 *
 *   node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID> --dry-run
 *   node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID>
 *   node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID> --rollback
 *
 * Auth: talks to Firestore with the Admin SDK from your local machine, so
 * it needs application-default credentials, same as scripts/seedProperties.js:
 *
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_FIREBASE_PROJECT_ID
 *
 * or set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON.
 *
 * -----------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------
 * 1. Verifies `agencies/{agencyId}` exists before doing anything else.
 * 2. Builds the list of source root collections to migrate:
 *      - the known application collections (leads, campaigns,
 *        opportunities, properties, whatsappTemplates, metrics,
 *        metricsDaily, metricsWeekly, metricsMonthly, dispatcherLocks,
 *        campaignDispatchLocks, processedMessages, processedLeadgenEvents)
 *      - PLUS any other root collection that actually exists in the
 *        project, auto-detected via `db.listCollections()`, excluding the
 *        two collections that are already tenancy infrastructure and were
 *        never global "old data" (`agencies`, `agencyRouting` — see
 *        src/tenancy.js).
 * 3. For every document in every source collection, copies it (same doc
 *    ID, same field values, same Timestamps/References — Admin SDK
 *    round-trips these types natively, nothing is re-serialized through
 *    JSON) to `agencies/{agencyId}/{collection}/{docId}`, then recurses
 *    into that document's subcollections (arbitrary depth) and does the
 *    same thing under the destination document. Nothing is skipped.
 * 4. Never deletes or mutates anything in the source (root) collections.
 * 5. Overwrites (full `set`, not merge) whatever already exists at the
 *    destination path — so re-running the script is a no-op for
 *    already-migrated docs and simply picks up anything left over if a
 *    previous run was interrupted. No duplicates are ever created because
 *    document IDs are preserved, never regenerated.
 *
 * -----------------------------------------------------------------------
 * SAFETY GUARANTEES
 * -----------------------------------------------------------------------
 *   - Copy-only: source root collections are ONLY ever read, never
 *     written to or deleted, in any mode (including --rollback).
 *   - Idempotent forward migration: safe to run any number of times, and
 *     safe to re-run after an interruption (Ctrl+C, crash, quota error).
 *   - Idempotent rollback: --rollback recursively deletes ONLY
 *     `agencies/{agencyId}/{collection}` for the same collection list
 *     above. It never touches `agencies/{agencyId}/profile`, `/settings`,
 *     `/credits`, `/subscription`, `/members`, or any other agency root
 *     data — those were never written by this script. Running --rollback
 *     twice is safe (second run just finds nothing left to delete).
 *   - Streams documents page-by-page (does not load a whole collection
 *     into memory) and uses a BulkWriter (Admin SDK's managed batching
 *     +retry+rate-limit layer) for all writes/deletes, so Firestore's
 *     500-writes-per-batch limit is always respected automatically.
 *
 * -----------------------------------------------------------------------
 * LIMITATIONS
 * -----------------------------------------------------------------------
 *   - This script does not delete the old root collections. That is a
 *     deliberate manual step for you to do yourself (e.g. in the Firebase
 *     console) once you've verified the app against the new data.
 *   - "Resume after interruption" works by re-scanning and overwriting —
 *     it does not persist a separate checkpoint file. For very large
 *     collections this means a re-run re-reads/re-writes docs that were
 *     already copied (safe, just not free). If that cost ever matters,
 *     the per-collection counts printed at the end tell you exactly which
 *     collections still need another pass.
 *   - `--rollback` only removes what this script would migrate (the
 *     known + auto-detected root collections). If you manually created
 *     other data directly under `agencies/{agencyId}/...` outside of this
 *     script, rollback will not know about it.
 *   - Firestore security rules are not evaluated by the Admin SDK, so
 *     this script's own access is unaffected by firestore.rules either
 *     way — it only ever touches the paths described above.
 */

const admin = require("firebase-admin");
const { agencyRef, agencyCollection } = require("../src/tenancy");

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const agencyArg = args.find((a) => a.startsWith("--agency="));
const agencyId = agencyArg ? agencyArg.split("=")[1] : null;
const isDryRun = args.includes("--dry-run");
const isRollback = args.includes("--rollback");

// Known application root collections from the pre-multi-tenancy schema.
// (Kept in sync with the list in tenancy.js's own doc-comment.)
const KNOWN_COLLECTIONS = [
  "leads",
  "campaigns",
  "opportunities",
  "properties",
  "whatsappTemplates",
  "metrics",
  "metricsDaily",
  "metricsWeekly",
  "metricsMonthly",
  "dispatcherLocks",
  "campaignDispatchLocks",
  "processedMessages",
  "processedLeadgenEvents",
];

// Collections that are already tenancy infrastructure, not "old global
// data" — never candidates for migration or rollback.
const NEVER_MIGRATE = new Set(["agencies", "agencyRouting"]);

const PAGE_SIZE = 300; // docs read per page, keeps memory flat regardless of collection size

// ── Helpers ─────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function countOf(collectionRef) {
  const snap = await collectionRef.count().get();
  return snap.data().count;
}

/** Prints an in-place "N / total" progress line, like a progress bar without the bar. */
function printProgress(done, total) {
  process.stdout.write(`\r  ${done} / ${total}`);
}

/**
 * Streams every document in `sourceCol` page-by-page (ordered by document
 * ID, so pagination is stable even while writes are happening elsewhere),
 * copying each one to `destCol` (same doc ID) and recursing into its
 * subcollections. Returns the number of top-level documents processed.
 */
async function migrateCollection(sourceCol, destCol, bulkWriter, dryRun) {
  const total = await countOf(sourceCol);
  if (total === 0) return 0;

  let processed = 0;
  let lastDoc = null;

  while (true) {
    let query = sourceCol.orderBy(admin.firestore.FieldPath.documentId()).limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      const destDocRef = destCol.doc(doc.id);

      if (!dryRun) {
        // Full overwrite (not merge) — deterministic, idempotent, and
        // guarantees the destination doc ends up byte-for-byte equal to
        // the source doc's current field values. Admin SDK preserves
        // Timestamp / GeoPoint / DocumentReference types natively.
        bulkWriter.set(destDocRef, doc.data());
      }

      // Recurse into subcollections (leads/{phone}/opportunities,
      // campaigns/{campaignId}/recipients, etc.), arbitrary depth.
      const subcols = await doc.ref.listCollections();
      for (const subcol of subcols) {
        await migrateCollection(subcol, destDocRef.collection(subcol.id), bulkWriter, dryRun);
      }

      processed += 1;
      printProgress(processed, total);
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  process.stdout.write("\n");
  return processed;
}

/** Recursively deletes agencies/{agencyId}/{collectionName} and everything under it. */
async function rollbackCollection(db, agencyId, collectionName) {
  const ref = agencyCollection(db, agencyId, collectionName);
  const before = await countOf(ref);
  if (before === 0) {
    console.log(`  ${collectionName}: nothing to roll back`);
    return { deleted: 0 };
  }
  await db.recursiveDelete(ref);
  console.log(`  ${collectionName}: deleted ${before} top-level document(s) (and their subcollections)`);
  return { deleted: before };
}

/**
 * Known collections ∪ whatever else actually exists at the Firestore
 * root right now, minus the two tenancy-infrastructure collections that
 * were never "old data" to migrate.
 */
async function resolveCollectionsToMigrate(db) {
  const rootCols = await db.listCollections();
  const rootNames = rootCols.map((c) => c.id);
  const combined = new Set([...KNOWN_COLLECTIONS, ...rootNames]);
  for (const skip of NEVER_MIGRATE) combined.delete(skip);
  return [...combined];
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  if (!agencyId) {
    console.error("Missing required --agency=<AGENCY_ID> argument.\n");
    console.error("Usage:");
    console.error("  node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID> --dry-run");
    console.error("  node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID>");
    console.error("  node scripts/migrateToMultiTenancy.js --agency=<AGENCY_ID> --rollback");
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.applicationDefault() });
  const db = admin.firestore();

  console.log(`Project:  ${process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId || "(from ADC)"}`);
  console.log(`Agency:   ${agencyId}`);
  console.log(`Mode:     ${isRollback ? "ROLLBACK" : isDryRun ? "DRY RUN (no writes)" : "MIGRATE"}`);
  console.log("");

  // 1. Verify destination agency exists before doing anything else.
  const agencySnap = await agencyRef(db, agencyId).get();
  if (!agencySnap.exists) {
    console.error(
      `agencies/${agencyId} does not exist. Create the agency (e.g. via ensureAgencyDoc in tenancy.js / your ` +
        `onboarding flow) before migrating data into it. Aborting — nothing was read or written.`
    );
    process.exit(1);
  }
  console.log(`✓ agencies/${agencyId} exists\n`);

  const collections = await resolveCollectionsToMigrate(db);
  collections.sort();

  if (isRollback) {
    console.log("Rolling back copied data (source root collections are never touched)...\n");
    let totalDeleted = 0;
    for (const name of collections) {
      const { deleted } = await rollbackCollection(db, agencyId, name);
      totalDeleted += deleted;
    }
    console.log(`\n✓ Rollback complete. ${totalDeleted} top-level document(s) removed from agencies/${agencyId}/...`);
    console.log(`✓ Original root collections were not touched.`);
    process.exit(0);
  }

  // 2. Migrate (or dry-run) every resolved collection.
  const bulkWriter = db.bulkWriter();
  bulkWriter.onWriteError((error) => {
    // BulkWriter already retries transient errors internally; log and let
    // it keep retrying up to its default limit rather than aborting the
    // whole run over one flaky write.
    console.error(`\n  write retry (attempt ${error.failedAttempts}): ${error.message}`);
    return error.failedAttempts < 5;
  });

  const summary = []; // { name, sourceCount, destCount, status }

  for (const name of collections) {
    console.log(`Migrating ${name}...`);
    const sourceCol = db.collection(name);
    const destCol = agencyCollection(db, agencyId, name);

    const sourceCountBefore = await countOf(sourceCol);
    if (sourceCountBefore === 0) {
      console.log("  (empty, skipping)");
      summary.push({ name, sourceCount: 0, destCount: 0, status: "empty" });
      continue;
    }

    await migrateCollection(sourceCol, destCol, bulkWriter, isDryRun);
    await bulkWriter.flush(); // wait for this collection's writes to land before counting/moving on

    const sourceCount = await countOf(sourceCol);
    const destCount = isDryRun ? null : await countOf(destCol);
    const status = isDryRun ? "would migrate" : destCount >= sourceCount ? "OK" : "INCOMPLETE — re-run script";
    summary.push({ name, sourceCount, destCount, status });
  }

  await bulkWriter.close();

  // 3. Final summary table.
  console.log("\nCollection".padEnd(24) + "Source Count".padEnd(16) + "Destination Count".padEnd(20) + "Status");
  for (const row of summary) {
    console.log(
      row.name.padEnd(24) +
        String(row.sourceCount).padEnd(16) +
        String(row.destCount === null ? "—" : row.destCount).padEnd(20) +
        row.status
    );
  }

  if (isDryRun) {
    console.log("\nDry run complete — no data was written. Re-run without --dry-run to perform the migration.");
    process.exit(0);
  }

  const incomplete = summary.filter((r) => r.status === "INCOMPLETE — re-run script");
  if (incomplete.length > 0) {
    console.log(
      `\n⚠ ${incomplete.length} collection(s) did not fully migrate (likely a transient write error or an ` +
        `interruption). Re-run the exact same command — it is idempotent and will only touch what's missing.`
    );
    process.exit(1);
  }

  console.log("\n✓ Migration completed");
  console.log("");
  console.log("✓ Run application");
  console.log("✓ Verify Dashboard");
  console.log("✓ Verify Leads");
  console.log("✓ Verify Campaigns");
  console.log("✓ Verify Templates");
  console.log("✓ Verify AI Agent");
  console.log("✓ Verify Metrics");
  console.log("✓ Verify Campaign Sending");
  console.log("✓ Verify Webhooks");
  console.log("");
  console.log("Once verified, you may manually delete the old root collections. This script never does so.");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nMigration script failed:", err);
  process.exit(1);
});
