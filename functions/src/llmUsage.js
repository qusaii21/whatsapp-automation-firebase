/**
 * LLM TOKEN USAGE EXTRACTION
 * ---------------------------------------------------------------------------
 * Every LLM call site in this codebase (agent.js, intentClassifier.js,
 * currentRequirementExtractor.js) goes through LangChain's ChatGroq wrapper.
 * `llm.invoke(...)` returns the AIMessage directly; `llm.withStructuredOutput
 * (schema, { includeRaw: true })` returns `{ raw: AIMessage, parsed }`. Either
 * way, the token counts live on that AIMessage — this module is the one place
 * that knows how to pull them out, so a LangChain/Groq version bump only ever
 * needs a fix here, not at every call site.
 *
 * Tries LangChain's standardized `usage_metadata` field first (input_tokens/
 * output_tokens/total_tokens — the cross-provider shape @langchain/core has
 * settled on), then falls back to Groq's own `response_metadata.tokenUsage`
 * (promptTokens/completionTokens/totalTokens) for older/edge-case responses.
 * Never throws — a shape it doesn't recognize just reports zero usage rather
 * than breaking the conversation turn that's riding alongside it (same
 * FAILURE ISOLATION posture as metrics.js itself).
 */

function extractUsage(aiMessage) {
  try {
    const std = aiMessage?.usage_metadata;
    if (std && (std.input_tokens || std.output_tokens || std.total_tokens)) {
      const inputTokens = std.input_tokens || 0;
      const outputTokens = std.output_tokens || 0;
      return {
        inputTokens,
        outputTokens,
        totalTokens: std.total_tokens || inputTokens + outputTokens,
      };
    }

    const meta =
      aiMessage?.response_metadata?.tokenUsage || aiMessage?.response_metadata?.token_usage;
    if (meta) {
      const inputTokens = meta.promptTokens || meta.prompt_tokens || 0;
      const outputTokens = meta.completionTokens || meta.completion_tokens || 0;
      return {
        inputTokens,
        outputTokens,
        totalTokens: meta.totalTokens || meta.total_tokens || inputTokens + outputTokens,
      };
    }
  } catch (err) {
    // Fall through to the zero-usage default below — see file header.
  }
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

/**
 * Collects { model, inputTokens, outputTokens } entries across however many
 * Groq calls happen within one logical unit of work (e.g. one runAgent()
 * turn = intent classifier + requirement extractor + 1-3 main agent calls),
 * so the caller records ONE metrics write per turn instead of one per Groq
 * call. See metrics.js's recordLlmUsage.
 */
class UsageAccumulator {
  constructor() {
    this.entries = [];
  }

  /** @param {string} model @param {import("@langchain/core/messages").AIMessage} aiMessage */
  add(model, aiMessage) {
    const usage = extractUsage(aiMessage);
    if (usage.inputTokens || usage.outputTokens) {
      this.entries.push({ model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
    }
  }

  /** Merge another accumulator's (or plain array's) entries into this one. */
  merge(entriesOrAccumulator) {
    const entries = Array.isArray(entriesOrAccumulator)
      ? entriesOrAccumulator
      : entriesOrAccumulator?.entries || [];
    this.entries.push(...entries);
  }

  toArray() {
    return this.entries;
  }
}

module.exports = { extractUsage, UsageAccumulator };
