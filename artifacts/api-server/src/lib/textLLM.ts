import OpenAI from "openai";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getGemini } from "./gemini";

export type LLMMessage = { role: "user" | "assistant"; content: string };

export type GenerateOpts = {
  system: string;
  messages: LLMMessage[];
  maxTokens: number;
  /** Explicit provider override. When unset, falls back to activeChatProvider(). */
  provider?: ChatProvider;
};

export type StreamOpts = GenerateOpts & {
  signal?: AbortSignal;
};

export type ChatProvider = "anthropic" | "gemini" | "openrouter";

const ANTHROPIC_CHAT_MODEL = "claude-sonnet-4-6";
const GEMINI_CHAT_MODEL = "gemini-2.5-flash";
const DEFAULT_OPENROUTER_MODEL = "sao10k/l3.3-euryale-70b";

/** Default provider for non-routed calls (proactive, distiller, etc). */
export function activeChatProvider(): ChatProvider {
  return process.env.ASHLEY_TEXT_PROVIDER === "anthropic"
    ? "anthropic"
    : "gemini";
}

/**
 * Whether OpenRouter is configured (env + key). Used by the policy module
 * (contentPolicy.nsfwTextUnlockedFor) to decide whether the NSFW text lane
 * is actually live. Kept here so the env contract for OpenRouter is owned
 * in one file alongside the client construction.
 */
export function openrouterAvailable(): boolean {
  return (
    process.env.ASHLEY_NSFW_TEXT_PROVIDER === "openrouter" &&
    Boolean(process.env.OPENROUTER_API_KEY)
  );
}

function openrouterModel(): string {
  const m = process.env.ASHLEY_NSFW_TEXT_MODEL;
  return m && m.trim().length > 0 ? m.trim() : DEFAULT_OPENROUTER_MODEL;
}

let _openrouterClient: OpenAI | null = null;
function getOpenrouter(): OpenAI {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY not set — cannot route to OpenRouter. Set the secret or unset ASHLEY_NSFW_TEXT_PROVIDER.",
    );
  }
  if (!_openrouterClient) {
    _openrouterClient = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: {
        // OpenRouter uses these for attribution / leaderboard. Optional but
        // good citizenship.
        "HTTP-Referer": "https://Ashley-Sidecar.replit.app",
        "X-Title": "Ashley-Sidecar",
      },
    });
  }
  return _openrouterClient;
}

function toGeminiContents(messages: LLMMessage[]) {
  return messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
}

function toOpenAIMessages(opts: GenerateOpts) {
  return [
    { role: "system" as const, content: opts.system },
    ...opts.messages.map((m) => ({ role: m.role, content: m.content })),
  ];
}

export async function generateChatText(opts: GenerateOpts): Promise<string> {
  const provider = opts.provider ?? activeChatProvider();

  if (provider === "openrouter") {
    // OpenRouter routes through many upstream providers; some can stall
    // for minutes. Hard 60s deadline so a hung request can't pin a chat
    // turn open forever. The streaming path uses the caller-provided
    // AbortSignal for the same purpose.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const response = await getOpenrouter().chat.completions.create(
        {
          model: openrouterModel(),
          messages: toOpenAIMessages(opts),
          max_tokens: opts.maxTokens,
          // OpenRouter-specific: server-side prompt compression. Many
          // RP-tuned models on OpenRouter (Magnum, Dolphin, Lumimaid,
          // Euryale, Anubis...) are served with a 16k context cap even
          // when the base architecture supports more. Kane's chat
          // payload runs ~60k tokens with summaries + history, so
          // every request 400s without this. Middle-out drops the
          // middle of the message list (preserving system + recent
          // turns) until it fits the model's served window.
          // See https://openrouter.ai/docs/transforms
          transforms: ["middle-out"],
        } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & {
          transforms?: string[];
        },
        { signal: ac.signal },
      );
      return (response.choices[0]?.message?.content ?? "").trim();
    } finally {
      clearTimeout(timer);
    }
  }

  if (provider === "gemini") {
    const result = await getGemini().models.generateContent({
      model: GEMINI_CHAT_MODEL,
      contents: toGeminiContents(opts.messages),
      config: {
        maxOutputTokens: opts.maxTokens,
        systemInstruction: opts.system,
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
}

export async function* streamChatText(
  opts: StreamOpts,
): AsyncGenerator<string, void, void> {
  const provider = opts.provider ?? activeChatProvider();

  if (provider === "openrouter") {
    const stream = await getOpenrouter().chat.completions.create(
      {
        model: openrouterModel(),
        messages: toOpenAIMessages(opts),
        max_tokens: opts.maxTokens,
        stream: true,
        // See generateChatText() above for why middle-out is required.
        transforms: ["middle-out"],
      } as OpenAI.Chat.ChatCompletionCreateParamsStreaming & {
        transforms?: string[];
      },
      { signal: opts.signal },
    );
    for await (const chunk of stream) {
      if (opts.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      const delta = chunk.choices[0]?.delta?.content;
      if (typeof delta === "string" && delta.length > 0) yield delta;
    }
    return;
  }

  if (provider === "gemini") {
    const stream = await getGemini().models.generateContentStream({
      model: GEMINI_CHAT_MODEL,
      contents: toGeminiContents(opts.messages),
      config: {
        maxOutputTokens: opts.maxTokens,
        systemInstruction: opts.system,
      },
    });
    for await (const chunk of stream) {
      if (opts.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      const text = chunk.text;
      if (text) yield text;
    }
    return;
  }

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
