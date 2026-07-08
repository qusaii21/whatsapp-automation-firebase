#!/usr/bin/env node
/**
 * One-time database seed script.
 *
 *   npm run seed-properties               # adds ~50 properties
 *   npm run seed-properties -- --count=80 # custom count
 *   npm run seed-properties -- --reset    # deletes existing seeded docs first
 *
 * Run from inside functions/ (it uses the same firebase-admin dependency
 * already installed there — no separate package.json needed).
 *
 * Auth: this talks to Firestore with the Admin SDK from your local machine,
 * so it needs application-default credentials:
 *
 *   gcloud auth application-default login
 *   gcloud config set project YOUR_FIREBASE_PROJECT_ID
 *
 * or set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON.
 */
const admin = require("firebase-admin");
const { generateProperties } = require("./propertyData");

const args = process.argv.slice(2);
const countArg = args.find((a) => a.startsWith("--count="));
const count = countArg ? parseInt(countArg.split("=")[1], 10) : 50;
const shouldReset = args.includes("--reset");

// Marks every doc this script writes so --reset only ever touches seeded
// data, never anything a real user/agent created through the app.
const SEED_TAG = "seed-script-v1";

async function main() {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
  const db = admin.firestore();

  console.log(`Project: ${process.env.GOOGLE_CLOUD_PROJECT || admin.app().options.projectId || "(from ADC)"}`);

  if (shouldReset) {
    console.log("Deleting previously seeded properties...");
    const existing = await db.collection("properties").where("_seedTag", "==", SEED_TAG).get();
    if (!existing.empty) {
      const batches = chunk(existing.docs, 400);
      for (const batchDocs of batches) {
        const batch = db.batch();
        batchDocs.forEach((d) => batch.delete(d.ref));
        await batch.commit();
      }
      console.log(`  Deleted ${existing.size} previously seeded properties.`);
    } else {
      console.log("  Nothing to delete.");
    }
  }

  console.log(`Generating ${count} realistic Pune properties...`);
  const properties = generateProperties(count).map((p) => ({ ...p, _seedTag: SEED_TAG }));

  console.log("Writing to Firestore in batches...");
  const batches = chunk(properties, 400); // Firestore batch limit is 500 writes
  let written = 0;
  for (const batchProps of batches) {
    const batch = db.batch();
    for (const prop of batchProps) {
      const ref = db.collection("properties").doc();
      batch.set(ref, prop);
    }
    await batch.commit();
    written += batchProps.length;
    console.log(`  ${written}/${properties.length} written`);
  }

  const byLocality = {};
  const byType = {};
  for (const p of properties) {
    byLocality[p.locality] = (byLocality[p.locality] || 0) + 1;
    byType[p.propertyType] = (byType[p.propertyType] || 0) + 1;
  }
  console.log("\nDone. Summary:");
  console.log("  By locality:", byLocality);
  console.log("  By type:", byType);
  process.exit(0);
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

main().catch((err) => {
  console.error("Seed script failed:", err);
  process.exit(1);
});
