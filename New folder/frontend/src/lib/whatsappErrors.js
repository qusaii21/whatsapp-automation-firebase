/**
 * WHATSAPP INTEGRATION — ERROR MESSAGE MAPPING
 * ---------------------------------------------------------------------------
 * Maps the error shapes that connectWhatsApp / getIntegrationStatus /
 * disconnectWhatsApp / checkWhatsAppHealth / syncTemplates / refreshTemplate
 * can actually produce (see functions/src/whatsappIntegration.js and
 * whatsappTemplates.js) into a friendly, specific message for the Settings
 * UI — without inventing failure modes the backend doesn't have.
 *
 * `callFunction` (below) is the one place that turns a fetch() Response (or
 * a thrown network error) into a normalised `WhatsAppApiError` with a
 * `.status` and `.code`, so every call site in the WhatsApp settings page
 * can just `catch` and pass the error straight to `friendlyWhatsAppError`.
 */

export class WhatsAppApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "WhatsAppApiError";
    this.status = status ?? null;
    this.code = code ?? null;
  }
}

/**
 * Runs an authedFetch call, parses the JSON body, and throws a normalised
 * WhatsAppApiError on any non-2xx response or network failure — so callers
 * never have to repeat the res.ok / res.json().catch() dance.
 */
export async function callFunction(authedFetch, path, options) {
  let res;
  try {
    res = await authedFetch(path, options);
  } catch (err) {
    // fetch() itself throws (TypeError: Failed to fetch) on DNS/offline/CORS
    // failures — there is no Response to read a status from.
    throw new WhatsAppApiError(err.message || "Network request failed.", { code: "network_error" });
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new WhatsAppApiError(body.error || `Request failed (${res.status}).`, {
      status: res.status,
      code: body.code || null,
    });
  }
  return body;
}

/**
 * Turns a WhatsAppApiError (or any other thrown error) into copy the
 * Settings page can show directly. Covers exactly the failure modes the
 * backend actually produces: 400 (caller-fixable / missing fields), 401/403
 * (auth — including "permission denied", i.e. non-owner), 409 (not
 * connected), 422 (Meta rejected the credentials — invalid/expired token),
 * 502 (upstream Meta API failure), network errors, and an unknown-error
 * fallback for anything else.
 */
export function friendlyWhatsAppError(err) {
  if (!err) return "Something went wrong. Please try again.";

  if (err.code === "network_error") {
    return "Couldn't reach the server. Check your connection and try again.";
  }

  const status = err.status;
  const raw = err.message || "";

  if (status === 422) {
    // Meta rejected the credentials — the backend's own message already
    // names the specific problem (bad token, wrong phone number id, etc.).
    return raw || "Meta rejected these credentials. Double-check the Access Token and Phone Number ID.";
  }
  if (status === 401) {
    return "Your session has expired. Please sign in again.";
  }
  if (status === 403) {
    // requireAuthContext() (functions/src/auth.js) throws 403 for THREE
    // distinct reasons — no_agency, member_disabled, forbidden — and only
    // the last of those is actually "you're not the Owner". Collapsing all
    // three into the Owner-only copy hides which one actually fired, so we
    // key off the AuthError's `code` and otherwise fall back to the
    // backend's own message rather than inventing a cause.
    if (err.code === "no_agency") {
      return raw || "This account isn't linked to an agency yet. Create an agency or accept an invite first.";
    }
    if (err.code === "member_disabled") {
      return raw || "This member account has been disabled.";
    }
    return raw || "Only the agency Owner can manage the WhatsApp integration.";
  }
  if (status === 409) {
    return "No WhatsApp Business Account is connected yet.";
  }
  if (status === 502) {
    return raw || "WhatsApp's servers didn't respond. Try again in a moment.";
  }
  if (status === 400) {
    return raw || "That request couldn't be completed — check the values and try again.";
  }
  if (status && status >= 500) {
    return "Something went wrong on our end. Please try again.";
  }

  return raw || "Something went wrong. Please try again.";
}

/**
 * Best-effort classification used only to pick an icon/tone in the UI
 * (e.g. the connect form shows a "reconnect" hint specifically for token
 * problems) — never used to change what's actually sent to the backend.
 */
export function classifyWhatsAppError(err) {
  if (!err) return "unknown";
  if (err.code === "network_error") return "network";
  if (err.status === 422) return "invalid_credentials";
  if (err.status === 401 || err.status === 403) return "permission";
  if (err.status === 502) return "meta_api";
  if (err.status && err.status >= 500) return "server";
  return "unknown";
}
