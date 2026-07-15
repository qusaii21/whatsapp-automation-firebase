const { ChatGroq } = require("@langchain/groq");
const { z } = require("zod");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const logger = require("firebase-functions/logger");
const { extractUsage } = require("./llmUsage");

const EXTRACTOR_MODEL = "llama-3.1-8b-instant";

/**
 * CURRENT REQUIREMENT EXTRACTION
 * ---------------------------------------------------------------------------
 * ROOT CAUSE this exists to fix: the main agent call (agent.js) extracts
 * propertyType/listingType/purpose from a structured-output LLM call that
 * sees the ENTIRE conversation history plus a system-prompt block describing
 * the customer's current active opportunity (e.g. "Property type:
 * Apartment"). That combination anchors the model: asked to extract "this
 * turn's" property type, it tends to either echo back the already-known
 * active-opportunity value or return null, even when the latest message
 * clearly states something different ("I need an office now"). Since
 * opportunities.js/resolveActiveOpportunity only creates a new opportunity
 * when it sees a genuinely different value, an anchored/null extraction
 * means the boundary is silently missed and the existing opportunity gets
 * updated instead of a new one being created.
 *
 * This module is the fix: a small, separate, fast extraction call that is
 * deliberately NOT shown the full conversation history and NOT shown the
 * active opportunity block — only the immediately preceding assistant
 * message (so short direct replies like "Office" or "Investment" can still
 * be resolved against the question that prompted them) and the customer's
 * latest message. With no anchor to lean on, the only thing the model can
 * extract from is what the customer actually just said.
 *
 * Called only for PROPERTY_SEARCH-classified turns (same gate as the search
 * tool itself in agent.js) — a details/FAQ/booking turn can't plausibly
 * restate a property requirement, so there's no reason to spend a call on it
 * or risk it returning a stray value.
 */

const currentRequirementSchema = z.object({
  propertyType: z
    .string()
    .nullable()
    .describe(
      "One of Apartment, Villa, Row House, Plot, Office, Commercial, Studio — ONLY if the " +
        "customer's latest message itself states or clearly implies one. Otherwise null."
    ),
  listingType: z
    .string()
    .nullable()
    .describe(
      "'Sale' or 'Rent' — ONLY if the customer's latest message itself makes this explicit " +
        "(e.g. 'looking to buy' -> Sale, 'looking to rent' -> Rent). Otherwise null."
    ),
  purpose: z
    .string()
    .nullable()
    .describe(
      "Own use / Investment / Rental income — ONLY if the customer's latest message itself " +
        "states this. Otherwise null."
    ),
});

const CURRENT_REQUIREMENT_PROMPT = `You extract what the customer's LATEST WhatsApp message says about what they
currently want to search for: property type, listing type (buy/rent), and purpose.

CRITICAL RULES — read carefully, these are the whole point of this task:
- Base your answer STRICTLY on the customer's latest message below. You are NOT being shown the
  rest of the conversation and must NOT assume, guess, or carry forward a property type, listing
  type, or purpose from anywhere else. If the latest message doesn't itself state or clearly
  imply a field, return null for it — this is the CORRECT and EXPECTED answer most of the time,
  not a failure.
- The one exception: if the "previous assistant message" below asked a direct question (e.g. "Is
  this for you to live in or an investment?", "Are you looking to buy or rent?", "What type of
  property are you looking for?"), interpret a short direct-answer reply ("investment", "rent",
  "office", "villa") as answering THAT specific question.
- Do NOT reason about whether this matches or differs from any prior requirement — you have no
  visibility into prior requirements and must not try to infer or preserve one. Extract only what
  is in front of you.
- Never leave a field non-null "just in case" — when genuinely unstated in the latest message (and
  not a direct answer to the previous question), null is correct.`;

/**
 * @param {object} params
 * @param {string|null} params.previousAssistantMessage The assistant's message immediately
 *   preceding the customer's latest one, if any — used only to resolve short direct-answer
 *   replies, never as a source of prior requirement values.
 * @param {string} params.latestUserMessage The customer's newest incoming message this turn.
 * @param {string} params.groqApiKey
 * @returns {Promise<{propertyType: string|null, listingType: string|null, purpose: string|null}>}
 */
async function extractCurrentRequirement({ previousAssistantMessage, latestUserMessage, groqApiKey }) {
  const llm = new ChatGroq({
    apiKey: groqApiKey,
    // Small/fast model is enough for this narrow extraction, same choice as
    // the intent classifier — keeps the extra round trip cheap.
    model: EXTRACTOR_MODEL,
    temperature: 0,
    // includeRaw: true — see intentClassifier.js's comment on the same
    // option; needed here for the same reason (METRICS ENGINE token usage).
  }).withStructuredOutput(currentRequirementSchema, {
    name: "extract_current_requirement",
    includeRaw: true,
  });

  const messages = [
    new SystemMessage(CURRENT_REQUIREMENT_PROMPT),
    ...(previousAssistantMessage
      ? [new AIMessage(`(previous assistant message) ${previousAssistantMessage}`)]
      : []),
    new HumanMessage(latestUserMessage || ""),
  ];

  const { raw, parsed } = await llm.invoke(messages);

  logger.info("currentRequirementExtractor: extracted", {
    propertyType: parsed.propertyType,
    listingType: parsed.listingType,
    purpose: parsed.purpose,
    latestUserMessage,
    hadPreviousAssistantMessage: Boolean(previousAssistantMessage),
  });

  // METRICS: see intentClassifier.js's identical comment.
  const usage = { model: EXTRACTOR_MODEL, ...extractUsage(raw) };

  return {
    propertyType: parsed.propertyType || null,
    listingType: parsed.listingType || null,
    purpose: parsed.purpose || null,
    usage,
  };
}

module.exports = { extractCurrentRequirement };
