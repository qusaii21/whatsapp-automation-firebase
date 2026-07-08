const { ChatGroq } = require("@langchain/groq");
const { z } = require("zod");
const { HumanMessage, AIMessage, SystemMessage } = require("@langchain/core/messages");
const logger = require("firebase-functions/logger");

// The full set of intents this bot needs to distinguish. Only PROPERTY_SEARCH
// is allowed to trigger a new search_properties tool call — everything else
// must be answered from conversation history / existing shown-property
// context, with NO tool available to the model for that turn.
//
// NEGATIVE_RESPONSE is deliberately separate from GOODBYE: "not interested"
// right after one listing means "that property specifically," not "end the
// conversation" — collapsing these into one intent was the source of the
// earlier GOODBYE-vs-CONVERSATION ambiguity hack. Splitting them lets the
// classifier be decisive instead of guessing.
const INTENTS = [
  "GREETING",
  "PROPERTY_SEARCH",
  "PROPERTY_DETAILS",
  "COMPARE_PROPERTIES",
  "BOOK_VISIT",
  "GENERAL_FAQ",
  "SMALL_TALK",
  "GOODBYE",
  "NEGATIVE_RESPONSE",
  "OTHER",
];

const intentSchema = z.object({
  intent: z.enum(INTENTS).describe("The single best-fitting intent for the user's latest message"),
  reasoning: z.string().describe("One short sentence explaining why this intent was chosen"),
});

function historyToMessages(conversationHistory) {
  return conversationHistory.map((turn) =>
    turn.role === "user" ? new HumanMessage(turn.text) : new AIMessage(turn.text)
  );
}

const CLASSIFIER_PROMPT = `You classify the LATEST user message in a real-estate WhatsApp conversation into
exactly one intent. Use the full conversation history for context (e.g. to know that "Details?"
refers to a property named two turns ago, or that "not interested" follows a specific listing
that was just shown), but you are classifying only the most recent user message.

Intents:
- GREETING: hi, hey, hello, good morning, etc. — no request yet.
- PROPERTY_SEARCH: the user is stating or changing search criteria (budget, bedrooms, location,
  property type) or explicitly asking to see NEW/OTHER/MORE options ("show me something else",
  "any other options", "show me villas instead", "what else do you have").
- PROPERTY_DETAILS: asking for more info about a property ALREADY shown/discussed in this
  conversation (e.g. "details?", "does it have a gym?", "tell me more", "what floor is it on",
  "tell me about the second one", "tell me about Green Valley" when Green Valley was already
  shown). This is NOT a new search — the answer must come from what was already shown.
- COMPARE_PROPERTIES: asking to compare two or more properties already shown/discussed (e.g.
  "compare the first two", "which is better, Green Valley or Sky Heights").
- BOOK_VISIT: asking to schedule/reschedule/cancel a site visit or call.
- GENERAL_FAQ: office timings, RERA, financing, loans, resale, legal, ROI, area info, builder
  reputation, or anything else answerable without a NEW property search.
- GREETING and SMALL_TALK are separate: SMALL_TALK is anything conversational that isn't a
  greeting and isn't covered elsewhere ("how are you", "haha ok", generic chit-chat).
- GOODBYE: the user is ending the ENTIRE conversation/search ("no thanks that's all", "bye",
  "thank you I'm all set", "stop messaging me", "thanks" said as a closing remark with nothing
  left to discuss).
- NEGATIVE_RESPONSE: the user is rejecting/declining the SPECIFIC property or option just
  presented — "not interested", "no", "not for me" — WITHOUT signaling the whole conversation is
  over. This is different from GOODBYE. If a property was just shown and the user says something
  short and negative right after, prefer NEGATIVE_RESPONSE over GOODBYE.
- OTHER: anything genuinely uncategorizable (spam, gibberish, off-topic, feedback/complaints
  about the service itself).

CRITICAL RULES:
- Never choose PROPERTY_SEARCH just because you don't know what else to do — only choose it when
  the user is asking to find or meaningfully refine/replace a property search.
- If the user references a property that was already shown earlier in this conversation ("it",
  "that one", "Green Valley", "the second one"), that is PROPERTY_DETAILS or COMPARE_PROPERTIES,
  never PROPERTY_SEARCH — the information needed to answer already exists in the conversation.
- When genuinely ambiguous between NEGATIVE_RESPONSE and GOODBYE, prefer NEGATIVE_RESPONSE — it's
  safer to ask a clarifying question ("want to see other options?") than to either end the chat
  or silently start an unrequested new search.`;

/**
 * Classifies the intent of the latest user turn using a small, fast
 * structured-output call — separate from the main agent call so the result
 * can gate whether the search tool is even offered to the model, rather than
 * relying on the main system prompt to "remember" not to search.
 */
async function classifyIntent({ conversationHistory, groqApiKey }) {
  const llm = new ChatGroq({
    apiKey: groqApiKey,
    // Smaller/faster model is enough for a 10-way classification and keeps
    // the extra round trip cheap; swap for the main model if accuracy needs
    // to improve.
    model: "llama-3.1-8b-instant",
    temperature: 0,
  }).withStructuredOutput(intentSchema, { name: "classify_intent" });

  const messages = [new SystemMessage(CLASSIFIER_PROMPT), ...historyToMessages(conversationHistory)];

  const result = await llm.invoke(messages);

  logger.info("intentClassifier: classified", {
    intent: result.intent,
    reasoning: result.reasoning,
    lastUserMessage: conversationHistory[conversationHistory.length - 1]?.text,
  });

  return result.intent;
}

module.exports = { classifyIntent, INTENTS };
