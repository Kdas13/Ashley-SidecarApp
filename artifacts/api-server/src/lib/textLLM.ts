import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getGemini } from "./gemini";
import { logger } from "./logger";

export type LLMMessage = { role: "user" | "assistant"; content: string };

export type GenerateOpts = {
  system: string;
  messages: LLMMessage[];
  maxTokens: number;
};

export type StreamOpts = GenerateOpts & {
  signal?: AbortSignal;
};

export type ChatProvider = "anthropic" | "gemini";

const ANTHROPIC_CHAT_MODEL = "claude-sonnet-4-6";
const GEMINI_CHAT_MODEL = "gemini-2.5-flash";

export function activeChatProvider(): ChatProvider {
  return process.env.ASHLEY_TEXT_PROVIDER === "anthropic" ? "anthropic" : "gemini";
}

function toGeminiContents(messages: LLMMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns true when the error looks like a provider-side rate limit (HTTP 429).
// Works for both @google/genai ApiError objects (which carry a numeric `status`)
// and plain Error messages that embed the status code.
function isRateLimit(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as Record<string, unknown>).status;
  if (status === 429) return true;
  const msg = (err as { message?: string }).message ?? "";
  return msg.includes("RATELIMIT_EXCEEDED") || msg.includes("429");
}

// Delays in ms between successive retry attempts (attempt 0 uses delays[0], etc.).
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export async function generateChatText(opts: GenerateOpts): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
    try {
      if (activeChatProvider() === "gemini") {
        const result = await getGemini().models.generateContent({
          model: GEMINI_CHAT_MODEL,
          contents: toGeminiContents(opts.messages),
          config: {
            maxOutputTokens: opts.maxTokens,
            systemInstruction: opts.system,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        return (result.text ?? "").trim();
      }
      const reply = await anthropic.messages.create({
        model: ANTHROPIC_CHAT_MODEL,
        max_tokens: opts.maxTokens,
        system: opts.system,
        messages: opts.messages,
      });
      const block = reply.content[0];
      return block && block.type === "text" ? block.text.trim() : "";
    } catch (err) {
      if (isRateLimit(err) && attempt < RETRY_DELAYS_MS.length) {
        lastErr = err;
        logger.warn(
          { attempt: attempt + 1, delayMs: RETRY_DELAYS_MS[attempt] },
          "Gemini rate limit on generateChatText — retrying",
        );
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function* streamChatText(
  opts: StreamOpts,
): AsyncGenerator<string, void, void> {
  if (activeChatProvider() === "gemini") {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]!);
      let hasYielded = false;
      try {
        const stream = await getGemini().models.generateContentStream({
          model: GEMINI_CHAT_MODEL,
          contents: toGeminiContents(opts.messages),
          config: {
            maxOutputTokens: opts.maxTokens,
            systemInstruction: opts.system,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        for await (const chunk of stream) {
          if (opts.signal?.aborted) {
            const err = new Error("aborted");
            err.name = "AbortError";
            throw err;
          }
          const text = chunk.text;
          if (text) {
            hasYielded = true;
            yield text;
          }
        }
        return;
      } catch (err) {
        // AbortErrors are intentional — propagate immediately.
        if (err instanceof Error && err.name === "AbortError") throw err;
        // Retry 429s only if no content has been yielded yet. Mid-stream
        // rate limits can't be retried transparently (the client already
        // received partial content), so let them surface as errors.
        if (isRateLimit(err) && !hasYielded && attempt < RETRY_DELAYS_MS.length) {
          lastErr = err;
          logger.warn(
            { attempt: attempt + 1, delayMs: RETRY_DELAYS_MS[attempt] },
            "Gemini rate limit on streamChatText — retrying",
          );
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  // Anthropic path — rate limits are rare and the SDK has its own retry
  // layer, so no additional wrapping needed here.
  const stream = anthropic.messages.stream(
    {
      model: ANTHROPIC_CHAT_MODEL,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: opts.messages,
    },
    { signal: opts.signal },
  );
  for await (const ev of stream) {
    if (
      ev.type === "content_block_delta" &&
      ev.delta.type === "text_delta"
    ) {
      const chunk = ev.delta.text;
      if (chunk.length > 0) yield chunk;
    }
  }
}
