import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getGemini } from "./gemini";

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

export async function generateChatText(opts: GenerateOpts): Promise<string> {
  if (activeChatProvider() === "gemini") {
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
  if (activeChatProvider() === "gemini") {
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
