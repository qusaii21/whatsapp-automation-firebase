const { ChatGroq } = require("@langchain/groq");
const { tool } = require("@langchain/core/tools");
const { z } = require("zod");
const {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} = require("@langchain/core/messages");
const admin = require("firebase-admin");
const logger = require("firebase-functions/logger");

const { classifyIntent } = require("./intentClassifier");

// Intents that are allowed to trigger a NEW search_properties tool call.
// Everything else gets the tool withheld entirely (not just discouraged in
// the prompt) — this is the architectural fix for "every message triggers a
// search": the model literally cannot call a tool it was never given.
const SEARCH_ALLOWED_INTENTS = new Set(["PROPERTY_SEARCH"]);

// System prompt follows a BANT-style qualification structure (Budget,
// Authority/purpose, Need, Timeline) instead of only budget+bedrooms, per
// how production real-estate lead-qualification bots are commonly designed.
const SYSTEM_PROMPT_TEMPLATE = `# Role
You are a warm, knowledgeable real estate assistant on WhatsApp, helping {{leadName}} find a
home and answering whatever questions they have along the way. You are not a narrow script —
you are a helpful conversational partner who happens to specialize in this property search.

# Core qualifying information to gather naturally over the conversation (don't interrogate,
# weave these in one or two at a time as the conversation flows)
- Name (if not already known)
- Minimum bedrooms needed
- Budget
- Preferred location/area, if they have one
- Purpose: is this for living in themselves, or an investment/rental property?
- Timeline: are they looking to move/buy urgently, in a few months, or just browsing?
- Any specific must-haves (parking, floor preference, amenities, etc.) if they mention any

# How to actually be useful, not just a property vending machine
1. Answer real questions honestly and helpfully — about a listing, the area, financing,
   scheduling a visit, or anything else they ask. If you don't have the information, say so
   plainly and offer to have a human follow up, rather than making something up.
2. {{toolAvailabilityNote}}
3. NEVER present a property you have already shown this lead earlier in the conversation.
4. After presenting a property, don't just stop — engage naturally. Ask if they'd like to see
   another option, want to schedule a viewing, have questions about it, or want to refine their
   search (different area, budget, etc.).
5. If the user says they're not interested in the specific property you just showed, that is
   NOT the same as ending the conversation. Ask what didn't fit (price, location, size, etc.)
   and offer to look for something closer to what they actually want.
6. Only treat the conversation as truly over when the user clearly signals they're done with
   the whole search — not merely rejecting one listing.
7. Keep messages short and conversational, WhatsApp-style — this is a chat, not an email.
8. Respond in the language the user most recently used.
9. Stay factual. Never invent a number, address, or fact. Only state details exactly as
   returned by the search_properties tool result or exactly as the user themselves stated, or
   exactly as given below under "Last property shown". If unsure where a fact came from, leave
   it out rather than guess.
10. No emojis.
11. Every shown property comes with a full structured record — use it directly to answer detail
    questions like: does it have parking (parkingCovered/parkingOpen)? Is it pet friendly
    (petFriendly)? Is there a gym (gym)? Which schools/hospitals are nearby (schoolsNearby/
    hospitalsNearby)? How old is it (ageOfProperty) or when is possession (possessionStatus/
    possessionDate)? Who is the builder (builder)? Is it RERA approved (reraApproved/
    reraNumber)? What is the maintenance (maintenance)? What is the carpet area (carpetArea) vs.
    super built-up area (superBuiltupArea)? How many bathrooms (bathrooms)? Is there a servant
    room (servantRoom)? How far is the metro (metroNearby, in km)? Is there power backup
    (powerBackup)? If a field is missing/null, say you don't have that detail rather than guess.
    For negotiation questions ("can I negotiate?"), never quote a discount or number — say
    pricing is handled by the assigned agent and offer to arrange a call.

# Additional Context
- Current time: {{currentTime}}
- Lead name: {{leadName}}
{{shownPropertiesBlock}}
{{activeOpportunityBlock}}`;

// Boolean amenity/feature filters the model can ask for by name. Kept as an
// explicit allow-list (rather than accepting an arbitrary field name) so the
// model can't probe for or filter on fields outside this set.
const FILTERABLE_AMENITIES = [
  "gym",
  "pool",
  "clubHouse",
  "garden",
  "childrenPlayArea",
  "security",
  "powerBackup",
  "lift",
  "petFriendly",
  "servantRoom",
  "modularKitchen",
];

function buildSearchPropertiesTool(excludeIds) {
  return tool(
    async ({
      bedrooms,
      maxBudget,
      location,
      propertyType,
      listingType,
      furnishing,
      possessionStatus,
      amenities,
    }) => {
      const db = admin.firestore();
      // Only ONE range filter is applied server-side (bedrooms) to keep this
      // query index-free; every other filter runs in memory below since the
      // properties collection is small (tens to low hundreds of docs), which
      // is far cheaper than maintaining a composite index per filter
      // combination.
      let query = db.collection("properties").where("available", "==", true);
      if (bedrooms !== undefined && bedrooms !== null) {
        query = query.where("bedrooms", ">=", bedrooms);
      }

      const snapshot = await query.get();
      let results = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

      if (maxBudget !== undefined && maxBudget !== null) {
        results = results.filter((p) => (p.price ?? Infinity) <= maxBudget);
      }
      if (location) {
        const term = location.toLowerCase();
        results = results.filter(
          (p) =>
            (p.locality || "").toLowerCase().includes(term) ||
            (p.city || "").toLowerCase().includes(term) ||
            (p.microLocation || "").toLowerCase().includes(term)
        );
      }
      if (propertyType) {
        const term = propertyType.toLowerCase();
        results = results.filter((p) => (p.propertyType || "").toLowerCase() === term);
      }
      if (listingType) {
        const term = listingType.toLowerCase();
        results = results.filter((p) => (p.listingType || "").toLowerCase() === term);
      }
      if (furnishing) {
        const term = furnishing.toLowerCase();
        results = results.filter((p) => (p.furnishing || "").toLowerCase() === term);
      }
      if (possessionStatus) {
        const term = possessionStatus.toLowerCase();
        results = results.filter((p) => (p.possessionStatus || "").toLowerCase() === term);
      }
      if (amenities && amenities.length > 0) {
        const wanted = amenities.filter((a) => FILTERABLE_AMENITIES.includes(a));
        results = results.filter((p) => wanted.every((a) => p[a] === true));
      }
      if (excludeIds && excludeIds.length > 0) {
        results = results.filter((p) => !excludeIds.includes(p.id));
      }

      // Sort featured/premium first, then by rating, so the "best" match is
      // presented first when multiple properties satisfy the filters.
      results.sort((a, b) => {
        if (a.featured !== b.featured) return a.featured ? -1 : 1;
        return (b.societyRating || 0) - (a.societyRating || 0);
      });

      return JSON.stringify(results.slice(0, 5));
    },
    {
      name: "search_properties",
      description:
        "Search available property listings not yet shown to this lead. Every matched property " +
        "in the result is returned with its FULL structured record (project name, builder, price, " +
        "carpet/super built-up area, bedrooms/bathrooms, furnishing, possession status/date, RERA " +
        "status, every amenity flag, nearby schools/hospitals/malls, metro/airport distance, " +
        "ratings, etc.) — use those exact fields to answer any follow-up question about a " +
        "presented property instead of guessing.",
      schema: z.object({
        bedrooms: z.number().nullable().optional().describe("Minimum number of bedrooms required, if known"),
        maxBudget: z.number().nullable().optional().describe("Maximum budget (price for sale, monthly rent for rent listings), if known"),
        location: z.string().nullable().optional().describe("Preferred locality/area/city keyword, if mentioned"),
        propertyType: z
          .string()
          .nullable()
          .optional()
          .describe("One of Apartment, Villa, Row House, Plot, Office, Commercial, Studio — only if the user specified a type"),
        listingType: z.string().nullable().optional().describe("'Sale' or 'Rent', only if the user made this explicit"),
        furnishing: z
          .string()
          .nullable()
          .optional()
          .describe("One of Unfurnished, Semi-Furnished, Fully-Furnished, only if the user asked for it"),
        possessionStatus: z
          .string()
          .nullable()
          .optional()
          .describe("'Ready to Move' or 'Under Construction', only if the user asked for it"),
        amenities: z
          .array(z.enum(FILTERABLE_AMENITIES))
          .nullable()
          .optional()
          .describe("Specific must-have amenities the user mentioned, e.g. ['gym', 'petFriendly']"),
      }),
    }
  );
}

// PHASE 2 — fields like conversationEnded / propertyFound / matchedPropertyId
// are still ASKED of the LLM below (producing a first guess still requires
// reading the conversation) but none of them are trusted verbatim anymore.
// runAgent() overrides every one of them against ground truth the code
// already has: which intent was classified, whether the tool actually ran,
// and what it actually returned. See the override block near the end of
// runAgent for exactly what's deterministic now vs. still model-derived.
const structuredOutputSchema = z.object({
  response: z.string().describe("The text to send back to the user via WhatsApp"),
  budget: z.number().nullable().describe("Raw numeric budget mentioned so far, else null"),
  bedrooms: z.number().nullable().describe("Raw numeric minimum bedrooms mentioned so far, else null"),
  preferredLocation: z.string().nullable().describe("Preferred location/area mentioned, else null"),
  timeline: z.string().nullable().describe("Purchase/move timeline mentioned, else null"),
  purpose: z.string().nullable().describe("Own living or investment, if mentioned, else null"),
  propertyFound: z.boolean().describe("True only if a specific property is presented to the user in this turn"),
  matchedPropertyId: z
    .string()
    .nullable()
    .describe("Exact `id` of the property presented this turn, if any. Null if propertyFound is false."),
  referencedPropertyIds: z
    .array(z.string())
    .nullable()
    .describe(
      "IDs (from the 'Properties already shown to this lead' context) that this turn's " +
        "response discusses, answers a details question about, or compares — used for " +
        "PROPERTY_DETAILS and COMPARE_PROPERTIES turns so the app can remember which " +
        "already-shown property(ies) are now 'in focus' for later pronouns like \"it\"/\"that " +
        "one\". Null or empty if this turn isn't about a previously shown property."
    ),
  conversationEnded: z
    .boolean()
    .describe(
      "True only if the user has signaled the ENTIRE search/conversation is over — not just " +
        "rejecting one listing."
    ),
  conversationSummary: z
    .string()
    .describe(
      "2-3 sentence factual summary of the lead's search so far and what's happened in the " +
        "conversation, written for a human agent glancing at the CRM. Base it ONLY on what was " +
        "actually said — never invent interest, requirements, or outcomes not present above."
    ),
  nextSuggestedAction: z
    .string()
    .describe(
      "One short, concrete next step for the human agent (e.g. 'Call to confirm visit time', " +
        "'Share 2BHK options in Wakad', 'Follow up in 3 days — went quiet after budget question')."
    ),
  interestLevel: z
    .enum(["High", "Medium", "Low"])
    .describe("Overall interest level inferred from engagement and how specific/positive the lead has been."),
  financingRequired: z
    .boolean()
    .nullable()
    .describe("True/false only if the lead explicitly mentioned needing a home loan/financing, else null."),
  propertyType: z
    .string()
    .nullable()
    .describe(
      "One of Apartment, Villa, Row House, Plot, Office, Commercial, Studio if the user stated " +
        "or clearly implied one this turn, else null."
    ),
  startsNewOpportunity: z
    .boolean()
    .describe(
      "True ONLY if the user is clearly starting a distinct, separate sales opportunity/search " +
        "from the 'Current active opportunity' described below — e.g. switching property type " +
        "(2BHK -> Villa), explicitly saying their requirements changed or they want to start " +
        "over, or a clearly different purpose (own-use -> investment). False for ordinary " +
        "refinements of the SAME search (adjusting budget, area, or bedroom count). False if " +
        "there is no active opportunity yet described below, or if this turn isn't a property " +
        "search at all."
    ),
});

function historyToMessages(conversationHistory) {
  return conversationHistory.map((turn) =>
    turn.role === "user" ? new HumanMessage(turn.text) : new AIMessage(turn.text)
  );
}

/**
 * Runs one turn of the qualifying/matching/FAQ-answering agent.
 *
 * @param {object} params
 * @param {string} params.leadName
 * @param {Array<{role: 'user'|'assistant', text: string}>} params.conversationHistory
 *   Full history INCLUDING the newest incoming user message, oldest first.
 * @param {string[]} [params.shownPropertyIds] Property ids already shown to this lead (used to
 *   exclude them from new search_properties results).
 * @param {object[]} [params.shownProperties] Full records of EVERY property shown so far, in the
 *   order they were shown — not just the last one. This is what lets PROPERTY_DETAILS ("does it
 *   have a gym?"), ordinal references ("tell me about the second one"), and COMPARE_PROPERTIES
 *   ("compare the first two") all be answered from context instead of forcing a new search.
 * @param {string} params.groqApiKey
 * @param {string|null} [params.activeOpportunitySummary] Short text summary of the customer's
 *   current active opportunity (from opportunities.js's summarizeOpportunityForPrompt), or null
 *   if they don't have one yet. Used only so the model's `startsNewOpportunity` judgment has
 *   something concrete to compare against — the actual decision of whether to create a new
 *   opportunity doc is made deterministically in opportunities.js, not here.
 */
async function runAgent({
  leadName,
  conversationHistory,
  shownPropertyIds = [],
  shownProperties = [],
  groqApiKey,
  activeOpportunitySummary = null,
}) {
  // ---- Debug logging: requested format, full arrays, no truncation ----
  logger.info("agent: conversation history length", { length: conversationHistory.length });
  logger.info("agent: conversation history (full)", { conversationHistory });
  logger.info("agent: current user message", {
    text: conversationHistory[conversationHistory.length - 1]?.text,
  });

  // ---- Step 1: classify intent BEFORE deciding whether search is even
  // an option. This is the actual fix — the tool is withheld structurally
  // for any intent that isn't PROPERTY_SEARCH, not just discouraged in the
  // prompt wording.
  const intent = await classifyIntent({ conversationHistory, groqApiKey });
  const searchAllowed = SEARCH_ALLOWED_INTENTS.has(intent);
  logger.info("agent: classified intent", { intent, searchAllowed });

  const llm = new ChatGroq({
    apiKey: groqApiKey,
    model: "llama-3.3-70b-versatile",
    temperature: 0.4,
  });

  const toolAvailabilityNote = searchAllowed
    ? "Use the search_properties tool to find matching listings once you have enough of the " +
      "qualifying info (at minimum bedrooms and budget). Present exactly ONE property per message."
    : "The search tool is NOT available this turn (the user's message isn't a new property " +
      "search request) — answer using the conversation history and the \"Last property shown\" " +
      "context below if relevant. Do not claim to have searched or found anything.";

  const shownPropertiesBlock =
    shownProperties.length > 0
      ? `\n# Properties already shown to this lead, in the order shown (use ONLY this data for ` +
        `any question about "it"/"that one"/"the second one"/a named property/comparisons — ` +
        `never invent details beyond what's here, and never re-search for these)\n` +
        shownProperties
          .map((p, i) => `${i + 1}. id=${p.id} — ${JSON.stringify(p)}`)
          .join("\n")
      : "";

  const activeOpportunityBlock = activeOpportunitySummary
    ? `\n# Current active opportunity for this customer\n${activeOpportunitySummary}\n` +
      `Only set startsNewOpportunity=true if this turn is CLEARLY a distinct, separate search ` +
      `from the above — not a normal refinement of it.`
    : `\n# Current active opportunity for this customer\nNone yet — this would be their first ` +
      `opportunity, so startsNewOpportunity should be false (a first opportunity isn't "new" ` +
      `relative to anything).`;

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(/\{\{leadName\}\}/g, leadName || "there")
    .replace("{{currentTime}}", new Date().toISOString())
    .replace("{{toolAvailabilityNote}}", toolAvailabilityNote)
    .replace("{{shownPropertiesBlock}}", shownPropertiesBlock)
    .replace("{{activeOpportunityBlock}}", activeOpportunityBlock);

  const messages = [new SystemMessage(systemPrompt), ...historyToMessages(conversationHistory)];

  logger.info("agent: messages sent to Groq (first pass)", {
    messages: messages.map((m) => ({ role: m._getType(), content: m.content })),
  });

  let toolCalled = false;
  let toolResultLog = null;
  let lastSearchResults = null; // parsed array from the most recent tool call
  let responseMessages = messages;

  if (searchAllowed) {
    const searchPropertiesTool = buildSearchPropertiesTool(shownPropertyIds);
    const llmWithTools = llm.bindTools([searchPropertiesTool]);

    const firstResponse = await llmWithTools.invoke(messages);
    responseMessages = [...messages, firstResponse];

    if (firstResponse.tool_calls && firstResponse.tool_calls.length > 0) {
      toolCalled = true;
      for (const call of firstResponse.tool_calls) {
        const toolResult = await searchPropertiesTool.invoke(call.args);
        toolResultLog = toolResult;
        try {
          lastSearchResults = JSON.parse(toolResult);
        } catch (e) {
          lastSearchResults = null;
        }
        responseMessages.push(new ToolMessage({ content: toolResult, tool_call_id: call.id }));
      }

      // PHASE 3 - zero-result handling. Previously the empty-array tool
      // result was still fed back to the LLM to "write a response" about it,
      // meaning an empty search and a real one went through the exact same
      // code path - nothing structurally stopped the model from describing
      // a property that isn't there. Now: if the tool genuinely found
      // nothing, skip BOTH remaining LLM calls (the follow-up formatting
      // call AND the structured-output call) and return a fixed response.
      // This removes the hallucination surface entirely for this case (no
      // LLM call is left that could invent a property) and cuts 2 of the
      // ~3 Groq calls a turn would otherwise cost (see Phase 8/9 notes).
      if (Array.isArray(lastSearchResults) && lastSearchResults.length === 0) {
        logger.info("agent: zero search results, short-circuiting (no formatting LLM call)", {
          leadName,
        });
        return {
          response:
            "I don't have anything matching that right now. Want to try a different budget, " +
            "location, or number of bedrooms? I can take another look.",
          budget: null,
          bedrooms: null,
          preferredLocation: null,
          timeline: null,
          purpose: null,
          propertyFound: false,
          matchedPropertyId: null,
          referencedPropertyIds: null,
          conversationEnded: false,
          visitRequested: false,
          conversationSummary: `${leadName || "This lead"} searched but no matching properties were found for the stated criteria.`,
          nextSuggestedAction: "Follow up manually with alternative options outside current criteria.",
          interestLevel: "Medium",
          financingRequired: null,
          propertyType: null,
          startsNewOpportunity: false,
          _meta: { intent, searchAllowed, toolCalled, searchResultCount: 0, zeroResultShortCircuit: true },
        };
      }

      const followUp = await llmWithTools.invoke(responseMessages);
      responseMessages.push(followUp);
    }
  } else {
    // No tools bound at all — the model physically cannot call search_properties.
    const plainResponse = await llm.invoke(messages);
    responseMessages = [...messages, plainResponse];
  }

  logger.info("agent: tool call summary", { toolCalled, toolResult: toolResultLog });

  const structuredLlm = llm.withStructuredOutput(structuredOutputSchema, { name: "agent_output" });

  const structuringMessages = [
    new SystemMessage(
      "Given the conversation so far (including the assistant's draft reply at the end), " +
        "produce the final structured output. Use the assistant's most recent draft reply as " +
        "the `response` field, lightly cleaned up if needed. CRITICAL: never invent or alter " +
        "any number or fact. Only state a property's details exactly as returned by the " +
        "search_properties tool result above, or exactly as given in the 'Properties already " +
        "shown' context, and only state the user's own stated preferences exactly as they said " +
        "them. If unsure where a detail came from, remove it rather than guess. Extract " +
        "budget/bedrooms/preferredLocation/timeline/purpose only if the user has explicitly " +
        "stated them themselves, else null. Set `propertyFound` to true ONLY if a specific NEW " +
        "property from a search_properties tool result is being presented this turn (never true " +
        "if no search happened this turn), and if so set `matchedPropertyId` to that property's " +
        "exact `id` (null otherwise). Set `referencedPropertyIds` to the id(s), from the " +
        "'Properties already shown' context, that this turn's response discusses/answers a " +
        "details question about/compares — e.g. one id for a details question about an existing " +
        "property (including ordinal references like 'the second one'), two or more ids for a " +
        "comparison. Null/empty if this turn isn't about a previously shown property. Set " +
        "`conversationEnded` to true ONLY if the user has signaled the entire conversation/" +
        "search is over — not merely disliking one specific property that was just shown. Also " +
        "produce `conversationSummary` (2-3 factual sentences, never inventing interest or " +
        "requirements not actually expressed), `nextSuggestedAction` (one concrete step for a " +
        "human agent), `interestLevel` (High/Medium/Low based on actual engagement), " +
        "`financingRequired` (true/false only if explicitly mentioned, else null), `propertyType` " +
        "(only if explicitly stated or clearly implied this turn, else null), and " +
        "`startsNewOpportunity` per its own field description, judged against the 'Current " +
        "active opportunity' context above."
    ),
    ...responseMessages,
  ];

  const structured = await structuredLlm.invoke(structuringMessages);

  // PHASE 2 - override every business-decision field with ground truth the
  // code already has, instead of trusting the model's self-report. This is
  // the actual fix for "the LLM ends the conversation on a rejected
  // listing" (and similar): the decision is no longer the model's to make.
  const actualResultIds = Array.isArray(lastSearchResults)
    ? lastSearchResults.map((p) => p.id)
    : [];
  const shownIds = new Set(shownProperties.map((p) => p.id));

  // conversationEnded is derived SOLELY from the deterministic intent
  // classification, never from the formatting LLM's judgment call. GOODBYE
  // is the only intent that ends the conversation; NEGATIVE_RESPONSE (e.g.
  // "not interested") structurally cannot, no matter what the model wrote.
  const conversationEnded = intent === "GOODBYE";

  // propertyFound/matchedPropertyId are only ever true if the code can prove
  // a search actually ran THIS turn and actually returned that exact id.
  // A model hallucinating "I found a great match!" with no backing tool
  // call, or citing an id the tool never returned, gets silently corrected
  // here rather than shipped to the user.
  const toolBackedMatch =
    toolCalled &&
    actualResultIds.length > 0 &&
    structured.matchedPropertyId &&
    actualResultIds.includes(structured.matchedPropertyId);
  const propertyFound = Boolean(toolBackedMatch);
  const matchedPropertyId = toolBackedMatch ? structured.matchedPropertyId : null;

  // referencedPropertyIds: resolving "the second one" to a concrete id is
  // genuinely a language-understanding task (pronoun/ordinal resolution
  // against a list) and can't be made fully deterministic without its own
  // NLP layer - so the model's guess is kept, but ONLY after validating
  // every id against the actual shownProperties list. Any id the model
  // invents that isn't in that list is dropped rather than trusted, and the
  // whole field is forced empty unless the classified intent is one that's
  // actually about a previously-shown property.
  const intentCanReference = intent === "PROPERTY_DETAILS" || intent === "COMPARE_PROPERTIES";
  const referencedPropertyIds =
    intentCanReference && Array.isArray(structured.referencedPropertyIds)
      ? structured.referencedPropertyIds.filter((id) => shownIds.has(id))
      : [];

  // visitRequested is new: BOOK_VISIT is routed by the classifier
  // deterministically to a CRM-visible flag, independent of whatever the
  // model's free-text reply says. The model still writes the natural-
  // language reply asking for a preferred date/time - that part IS a
  // language task - but whether this turn counts as "a visit was
  // requested" for lead-tracking purposes is not left to the model.
  const visitRequested = intent === "BOOK_VISIT";

  // startsNewOpportunity is gated to PROPERTY_SEARCH turns only, same as the
  // search tool itself — a details/FAQ/booking turn can't plausibly be the
  // start of a brand-new opportunity, whatever the model guessed.
  const startsNewOpportunity = intent === "PROPERTY_SEARCH" && Boolean(structured.startsNewOpportunity);

  const final = {
    response: structured.response,
    budget: structured.budget,
    bedrooms: structured.bedrooms,
    preferredLocation: structured.preferredLocation,
    timeline: structured.timeline,
    purpose: structured.purpose,
    propertyFound,
    matchedPropertyId,
    referencedPropertyIds: referencedPropertyIds.length > 0 ? referencedPropertyIds : null,
    conversationEnded,
    visitRequested,
    conversationSummary: structured.conversationSummary,
    nextSuggestedAction: structured.nextSuggestedAction,
    interestLevel: structured.interestLevel,
    financingRequired: structured.financingRequired,
    propertyType: structured.propertyType,
    startsNewOpportunity,
    _meta: {
      intent,
      searchAllowed,
      toolCalled,
      searchResultCount: actualResultIds.length,
      zeroResultShortCircuit: false,
    },
  };

  logger.info("agent: final response (post deterministic override)", {
    llmSaid: {
      propertyFound: structured.propertyFound,
      matchedPropertyId: structured.matchedPropertyId,
      conversationEnded: structured.conversationEnded,
      referencedPropertyIds: structured.referencedPropertyIds,
    },
    codeOverrode: final,
  });

  return final;
}

module.exports = { runAgent, SYSTEM_PROMPT_TEMPLATE, buildSearchPropertiesTool };
