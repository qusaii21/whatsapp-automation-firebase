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

const SYSTEM_PROMPT_TEMPLATE = `# Role
You are an AI agent that qualifies new leads coming from Facebook ads. Your role includes
asking a few specific questions to gather essential information for our records. Also, you
will match their needs with the properties listed in our database to provide them with
relevant options.

# Instructions
1. Start by greeting the user and asking for their name.
2. Gather two essential details from the user:
   - The minimum number of bedrooms they need
   - Their budget
3. If the user has specific questions about the property listings, provide concise answers if
   the information is available. If not, let them know and continue gathering the necessary
   details.
4. Once you have the user's requirements, search the properties collection to find entries
   that match the user's needs for bedrooms and budget. Always just present 1 property per
   message.
5. Keep the discussion centered on bedrooms and budget. If the user deviates, gently steer the
   conversation back to these topics.
6. Respond in the language the user most recently used.
7. Stay factual and avoid making up information. Always ask for clarification if needed, and
   do not use emojis.
8. Add the budget the user has given to the structured output as a raw number value. If no
   budget has been given yet, leave it null.

# Additional Context
- Current time: {{currentTime}}
- Lead name: {{leadName}}`;

// Read-only Firestore tool the agent can call to look for matching listings.
const searchPropertiesTool = tool(
  async ({ bedrooms, maxBudget }) => {
    const db = admin.firestore();
    let query = db.collection("properties");

    if (bedrooms !== undefined && bedrooms !== null) {
      query = query.where("bedrooms", ">=", bedrooms);
    }

    const snapshot = await query.get();
    let results = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    if (maxBudget !== undefined && maxBudget !== null) {
      results = results.filter((p) => p.budget <= maxBudget);
    }

    // Cap the payload so we don't blow up the context window.
    return JSON.stringify(results.slice(0, 5));
  },
  {
    name: "search_properties",
    description:
      "Search available property listings in our database, optionally filtered by a " +
      "minimum number of bedrooms and/or a maximum budget. Returns a JSON array of " +
      "matching properties, each with title, bedrooms, budget, location, description.",
    schema: z.object({
      bedrooms: z
        .number()
        .nullable()
        .optional()
        .describe("Minimum number of bedrooms required, if known"),
      maxBudget: z
        .number()
        .nullable()
        .optional()
        .describe("Maximum budget of the lead, if known"),
    }),
  }
);

// Final structured shape every agent turn must produce.
const structuredOutputSchema = z.object({
  response: z.string().describe("The text to send back to the user via WhatsApp"),
  budget: z
    .number()
    .nullable()
    .describe("Raw numeric budget mentioned so far in the conversation, else null"),
  bedrooms: z
    .number()
    .nullable()
    .describe("Raw numeric minimum bedrooms mentioned so far, else null"),
  propertyFound: z
    .boolean()
    .describe("True only if a specific property is presented to the user in this turn"),
});

function historyToMessages(conversationHistory) {
  return conversationHistory.map((turn) =>
    turn.role === "user" ? new HumanMessage(turn.text) : new AIMessage(turn.text)
  );
}

/**
 * Runs one turn of the qualifying/matching agent.
 *
 * @param {object} params
 * @param {string} params.leadName
 * @param {Array<{role: 'user'|'assistant', text: string}>} params.conversationHistory
 *   Full history INCLUDING the newest incoming user message, oldest first.
 * @param {string} params.groqApiKey
 * @returns {Promise<{response: string, budget: number|null, bedrooms: number|null, propertyFound: boolean}>}
 */
async function runAgent({ leadName, conversationHistory, groqApiKey }) {
  const llm = new ChatGroq({
    apiKey: groqApiKey,
    model: "llama-3.3-70b-versatile",
    temperature: 0.3,
  });

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace(
    "{{leadName}}",
    leadName || "there"
  ).replace("{{currentTime}}", new Date().toISOString());

  const messages = [new SystemMessage(systemPrompt), ...historyToMessages(conversationHistory)];

  const llmWithTools = llm.bindTools([searchPropertiesTool]);

  // First pass: let the model decide whether it needs to search properties.
  const firstResponse = await llmWithTools.invoke(messages);
  messages.push(firstResponse);

  if (firstResponse.tool_calls && firstResponse.tool_calls.length > 0) {
    for (const call of firstResponse.tool_calls) {
      const toolResult = await searchPropertiesTool.invoke(call.args);
      messages.push(
        new ToolMessage({ content: toolResult, tool_call_id: call.id })
      );
    }
    // Second pass: produce the natural-language reply now that we have data.
    const followUp = await llmWithTools.invoke(messages);
    messages.push(followUp);
  }

  // Final pass: force the whole exchange into our structured output schema.
  const structuredLlm = llm.withStructuredOutput(structuredOutputSchema, {
    name: "agent_output",
  });

  const structuringMessages = [
    new SystemMessage(
      "Given the conversation so far (including the assistant's draft reply at the end), " +
        "produce the final structured output. Use the assistant's most recent draft reply as " +
        "the `response` field, lightly cleaned up if needed. Extract `budget` and `bedrooms` " +
        "as raw numbers if the user has stated them anywhere in the conversation, else null. " +
        "Set `propertyFound` to true only if a specific property listing is being presented to " +
        "the user in this turn's response."
    ),
    ...messages,
  ];

  const structured = await structuredLlm.invoke(structuringMessages);
  return structured;
}

module.exports = { runAgent, SYSTEM_PROMPT_TEMPLATE, searchPropertiesTool };
