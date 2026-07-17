#!/usr/bin/env node
/**
 * ONE-TIME backfill utility: re-issues Firebase Auth custom claims
 * ({ agencyId, role, status }) for every member from their Firestore member
 * doc (agencies/{agencyId}/members/{uid}) — the source of truth (see
 * src/memberClaims.js's header for the full ownership model).
 *
 * WHY THIS EXISTS: every member's claims are supposed to always mirror
 * their Firestore doc, kept in sync going forward by
 * memberClaims.js#writeMemberRecord (the single write path every mutation
 * now goes through — see that file). But any account whose claims were
 * set BEFORE writeMemberRecord existed — including before the `status`
 * field was ever added to the claims shape — has claims that were never
 * re-issued, and will silently disagree with Firestore until something
 * explicitly fixes them. This script is that fix, run once against
 * production to repair every account already in that state, in the same
 * spirit as migrateToMultiTenancy.js's one-time Firestore migration.
 *
 * This is also the general-purpose repair tool for any future claims/
 * Firestore drift (e.g. a claims write that failed after the Firestore
 * write succeeded — see writeMemberRecord's documented failure mode) —
 * safe to re-run at any time.
 *
 * -----------------------------------------------------------------------
 * USAGE  (run from inside functions/)
 * -----------------------------------------------------------------------
 *
 *   node scripts/backfillMemberClaims.js --dry-run
 *   node scripts/backfillMemberClaims.js --dry-run --agency=<AGENCY_ID>
 *   node scripts/backfillMemberClaims.js
 *   node scripts/backfillMemberClaims.js --agency=<AGENCY_ID>
 *
 * Auth: same as migrateToMultiTenancy.js / seedProperties.js — Admin SDK
 * with application-default credentials:
 *
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_FIREBASE_PROJECT_ID
 *
 * -----------------------------------------------------------------------
 * WHAT IT DOES
 * -----------------------------------------------------------------------
 * 1. Resolves the agencies to check: either the single `--agency=` given,
 *    or every doc in the root `agencies` collection (auto-detected).
 * 2. For every agency, streams its `members` subcollection page-by-page
 *    (does not load a whole collection into memory).
 * 3. For each member doc, reads { agencyId, role, status } — the Firestore
 *    values — and compares them against that uid's CURRENT Firebase Auth
 *    custom claims.
 * 4. If they already match: reported as "OK", nothing written.
 *    If they differ (including claims missing entirely, or missing just
 *    the `status` field): re-issues claims from the Firestore values.
 * 5. Runs with bounded concurrency (Admin Auth calls are plain network
 *    round trips, not BulkWriter-batched like Firestore writes) so a
 *    large member base doesn't fire thousands of simultaneous requests.
 *
 * -----------------------------------------------------------------------
 * SAFETY GUARANTEES
 * -----------------------------------------------------------------------
 *   - Copy-only, one direction: Firestore member docs are ONLY ever read,
 *     never written, by this script. Only Firebase Auth claims are
 *     written — matching the ownership model (Firestore is truth, claims
 *     are the mirror).
 *   - Idempotent: safe to run any number of times. Members whose claims
 *     already match Firestore are left untouched and reported as "OK".
 *     Safe to re-run after an interruption (Ctrl+C, crash, quota error) —
 *     it will simply re-check everything and only write what's still
 *     mismatched.
 *   - Per-record failures (e.g. a member doc whose Firebase Auth user was
 *     deleted outside this app — `auth/user-not-found`) are caught and
 *     reported individually; they do not abort the run.
 *
 * -----------------------------------------------------------------------
 * LIMITATIONS
 * -----------------------------------------------------------------------
 *   - Does not persist a checkpoint file — "resume after interruption"
 *     works by re-scanning from the start, which re-reads (but does not
 *     re-write) already-fixed members. Safe, not free, at very large
 *     scale; the per-agency summary at the end shows exactly what's left
 *     if a re-run is needed.
 *   - Does not back up the claims it overwrites. This is intentional: the
 *     claims being replaced are, by definition, the incorrect state this
 *     script exists to repair.
 *   - Firestore security rules are not evaluated by the Admin SDK, so this
 *     script's access is unaffected by firestore.rules.
 */

const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const { agencyMembersCollection } = require("../src/tenancy");

/**
 * Resolves a project ID for admin.initializeApp() the same way the Firebase
 * CLI does: GOOGLE_CLOUD_PROJECT / GCLOUD_PROJECT env var first, falling
 * back to the repo's own .firebaserc. This matters specifically for the
 * Auth Admin SDK — unlike Firestore, it does NOT reliably infer a project
 * ID from `gcloud config set project` alone on a local machine (this bites
 * hardest on Windows), so admin.auth().getUser()/setCustomUserClaims()
 * fail with "Failed to determine project ID for Auth" even though Firestore
 * reads in the same run work fine. Explicit beats implicit here.
 */
function resolveProjectId() {
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  if (process.env.GCLOUD_PROJECT) return process.env.GCLOUD_PROJECT;
  try {
    const rcPath = path.join(__dirname, "..", "..", ".firebaserc");
    const rc = JSON.parse(fs.readFileSync(rcPath, "utf8"));
    return rc.projects && rc.projects.default;
  } catch {
    return undefined;
  }
}

// ── CLI args ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const agencyArg = args.find((a) => a.startsWith("--agency="));
const singleAgencyId = agencyArg ? agencyArg.split("=")[1] : null;
const isDryRun = args.includes("--dry-run");

const PAGE_SIZE = 300; // member docs read per page, keeps memory flat regardless of collection size
const CONCURRENCY = 10; // bounded concurrent Auth Admin SDK calls per page

const CLAIM_FIELDS = ["agencyId", "role", "status"];

// ── Helpers ─────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function claimsMatch(current, expected) {
  return CLAIM_FIELDS.every((field) => (current || {})[field] === expected[field]);
}

/**
 * Checks one member doc's Firestore fields against that uid's current
 * Auth claims, and (outside dry-run) repairs them if they differ.
 * Returns one of: "ok" | "fixed" | "would-fix" | "missing-auth-user" | "error".
 */
async function reconcileMember(memberDoc) {
  const data = memberDoc.data();
  const uid = memberDoc.id;
  const expected = {
    agencyId: data.agencyId,
    role: data.role,
    status: data.status,
  };

  if (!expected.agencyId || !expected.role || !expected.status) {
    console.error(`  ⚠ ${uid}: Firestore doc is missing agencyId/role/status — skipping (data: ${JSON.stringify(data)})`);
    return "error";
  }

  let authUser;
  try {
    authUser = await admin.auth().getUser(uid);
  } catch (err) {
    if (err.code === "auth/user-not-found") {
      console.error(`  ⚠ ${uid}: no matching Firebase Auth user (deleted outside the app?) — skipping`);
      return "missing-auth-user";
    }
    console.error(`  ⚠ ${uid}: failed to read Auth user — ${err.message}`);
    return "error";
  }

  if (claimsMatch(authUser.customClaims, expected)) {
    return "ok";
  }

  if (isDryRun) {
    console.log(
      `  would fix ${uid}: claims=${JSON.stringify(authUser.customClaims || {})} -> ${JSON.stringify(expected)}`
    );
    return "would-fix";
  }

  try {
    await admin.auth().setCustomUserClaims(uid, expected);
    console.log(
      `  fixed ${uid}: claims=${JSON.stringify(authUser.customClaims || {})} -> ${JSON.stringify(expected)}`
    );
    return "fixed";
  } catch (err) {
    console.error(`  ⚠ ${uid}: failed to write claims — ${err.message}`);
    return "error";
  }
}

/** Streams one agency's members collection page-by-page, reconciling each doc with bounded concurrency. */
async function reconcileAgency(agencyId, db) {
  const counts = { ok: 0, fixed: 0, "would-fix": 0, "missing-auth-user": 0, error: 0 };
  let lastDoc = null;

  while (true) {
    let query = agencyMembersCollection(db, agencyId)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (lastDoc) query = query.startAfter(lastDoc);

    const snap = await query.get();
    if (snap.empty) break;

    for (const batch of chunk(snap.docs, CONCURRENCY)) {
      const results = await Promise.all(batch.map(reconcileMember));
      for (const result of results) counts[result] += 1;
    }

    lastDoc = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }

  return counts;
}

async function resolveAgencyIds(db) {
  if (singleAgencyId) return [singleAgencyId];
  const snap = await db.collection("agencies").listDocuments();
  return snap.map((ref) => ref.id);
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const projectId = resolveProjectId();
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
  const db = admin.firestore();

  console.log(`Project:  ${admin.app().options.projectId || "(could not resolve — set GOOGLE_CLOUD_PROJECT)"}`);
  console.log(`Scope:    ${singleAgencyId ? `single agency (${singleAgencyId})` : "all agencies"}`);
  console.log(`Mode:     ${isDryRun ? "DRY RUN (no writes)" : "BACKFILL"}`);
  console.log("");

  const agencyIds = await resolveAgencyIds(db);
  if (agencyIds.length === 0) {
    console.log("No agencies found — nothing to do.");
    process.exit(0);
  }

  const summary = []; // { agencyId, ok, fixed, "would-fix", "missing-auth-user", error }

  for (const agencyId of agencyIds) {
    console.log(`Checking agency ${agencyId}...`);
    const counts = await reconcileAgency(agencyId, db);
    summary.push({ agencyId, ...counts });
    console.log("");
  }

  // Final summary table.
  console.log(
    "Agency".padEnd(30) + "OK".padEnd(8) + (isDryRun ? "Would fix" : "Fixed").padEnd(12) + "Missing user".padEnd(15) + "Errors"
  );
  let totalFixed = 0;
  let totalErrors = 0;
  for (const row of summary) {
    const fixedCount = isDryRun ? row["would-fix"] : row.fixed;
    totalFixed += fixedCount;
    totalErrors += row.error;
    console.log(
      row.agencyId.padEnd(30) +
        String(row.ok).padEnd(8) +
        String(fixedCount).padEnd(12) +
        String(row["missing-auth-user"]).padEnd(15) +
        String(row.error)
    );
  }

  console.log("");
  if (isDryRun) {
    console.log(`Dry run complete — ${totalFixed} member(s) would be fixed. Re-run without --dry-run to apply.`);
    process.exit(0);
  }

  console.log(`✓ Backfill complete — ${totalFixed} member(s) fixed.`);
  if (totalErrors > 0) {
    console.log(`⚠ ${totalErrors} member(s) hit an error and were skipped — see the ⚠ lines above. Safe to re-run.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("\nBackfill script failed:", err);
  process.exit(1);
});