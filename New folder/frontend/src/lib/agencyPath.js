import { collection, doc, collectionGroup } from "firebase/firestore";
import { db } from "../firebase.js";

/**
 * AGENCY-SCOPED FIRESTORE PATHS
 * ---------------------------------------------------------------------------
 * The client-side mirror of functions/src/tenancy.js. Every collection that
 * used to live at the Firestore root (leads, campaigns, properties,
 * whatsappTemplates, metrics, metricsDaily/Weekly/Monthly, ...) now lives
 * under `agencies/{agencyId}/...` — this is the ONE place in the frontend
 * that builds that path, so nothing else constructs or duplicates it.
 *
 * `agencyId` is always passed in by the caller (from `useAuth()` — see
 * contexts/AuthContext.jsx) rather than looked up here, so this stays a
 * pure, dependency-free path builder that every page/component/hook can
 * import without also depending on React context.
 *
 * agencies/{agencyId}
 *   leads/{phone}
 *     opportunities/{opportunityId}
 *   campaigns/{campaignId}
 *     recipients/{recipientId}
 *   properties/{propertyId}
 *   whatsappTemplates/{templateId}
 *   metrics/dashboard
 *   metricsDaily/{yyyy-mm-dd} · metricsWeekly/{yyyy-Www} · metricsMonthly/{yyyy-mm}
 *   members/{uid}
 *
 * (leads/inbox, leads/deadLetters, dispatcherLocks, campaignDispatchLocks,
 * processedMessages, processedLeadgenEvents, agencyRouting, invites are
 * internal Cloud Functions machinery the frontend never reads — see
 * firestore.rules, which denies client access to all of them.)
 */

/** `agencies/{agencyId}` */
export function agencyDocRef(agencyId) {
  if (!agencyId || typeof agencyId !== "string") {
    throw new Error("agencyPath: a valid agencyId is required (got: " + JSON.stringify(agencyId) + ").");
  }
  return doc(db, "agencies", agencyId);
}

/** `agencies/{agencyId}/{collectionName}` — the one place every tenant-scoped collection path is built. */
export function agencyCollection(agencyId, collectionName) {
  return collection(agencyDocRef(agencyId), collectionName);
}

/** `agencies/{agencyId}/{collectionName}/{docId}` */
export function agencyDoc(agencyId, collectionName, docId) {
  return doc(agencyCollection(agencyId, collectionName), docId);
}

/** `agencies/{agencyId}/{collectionName}/{parentId}/{subcollectionName}` */
export function agencySubcollection(agencyId, collectionName, parentId, subcollectionName) {
  return collection(agencyDoc(agencyId, collectionName, parentId), subcollectionName);
}

/** `agencies/{agencyId}/{collectionName}/{parentId}/{subcollectionName}/{docId}` */
export function agencySubDoc(agencyId, collectionName, parentId, subcollectionName, docId) {
  return doc(agencySubcollection(agencyId, collectionName, parentId, subcollectionName), docId);
}

// ── Named shortcuts for the collections every page actually touches ────────
// Thin wrappers over the generic helpers above, purely so call sites read
// as `leadsCollection(agencyId)` rather than `agencyCollection(agencyId,
// "leads")` everywhere — still funnels through the same single path builder.

export const leadsCollection = (agencyId) => agencyCollection(agencyId, "leads");
export const leadDoc = (agencyId, phone) => agencyDoc(agencyId, "leads", phone);
export const opportunitiesCollection = (agencyId, phone) =>
  agencySubcollection(agencyId, "leads", phone, "opportunities");

export const campaignsCollection = (agencyId) => agencyCollection(agencyId, "campaigns");
export const campaignDoc = (agencyId, campaignId) => agencyDoc(agencyId, "campaigns", campaignId);
export const campaignRecipientsCollection = (agencyId, campaignId) =>
  agencySubcollection(agencyId, "campaigns", campaignId, "recipients");
/** Every agency's `recipients` subcollections at once (still filtered to the caller's own agency by firestore.rules — see its collectionGroup note). */
export const recipientsCollectionGroup = () => collectionGroup(db, "recipients");

export const propertiesCollection = (agencyId) => agencyCollection(agencyId, "properties");
export const propertyDoc = (agencyId, propertyId) => agencyDoc(agencyId, "properties", propertyId);

export const templatesCollection = (agencyId) => agencyCollection(agencyId, "whatsappTemplates");
export const templateDoc = (agencyId, templateId) => agencyDoc(agencyId, "whatsappTemplates", templateId);

export const metricsDashboardDoc = (agencyId) => agencyDoc(agencyId, "metrics", "dashboard");
export const metricsDailyDoc = (agencyId, dayKey) => agencyDoc(agencyId, "metricsDaily", dayKey);
export const metricsWeeklyDoc = (agencyId, weekKey) => agencyDoc(agencyId, "metricsWeekly", weekKey);
export const metricsMonthlyDoc = (agencyId, monthKey) => agencyDoc(agencyId, "metricsMonthly", monthKey);

export const membersCollection = (agencyId) => agencyCollection(agencyId, "members");
export const memberDoc = (agencyId, uid) => agencyDoc(agencyId, "members", uid);
