import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, messagesTable, memoriesTable } from "@workspace/db";
import { asc, desc } from "drizzle-orm";
import {
  ListMessagesResponse,
  ListMessagesQueryParams,
  SendMessageBodySchema,
  SendMessageResponseSchema,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getOrCreateProfile } from "../lib/profile";
import {
  buildSystemPrompt,
  toClaudeMessages,
  MEMORY_DISTILLER_PROMPT,
} from "../lib/ashleyPrompt";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHAT_MODEL = "claude-sonnet-4-6";
const HISTORY_WINDOW = 30;

// ---------------------------------------------------------------------------
// Stateless reply endpoint used by the local-first mobile client.
// The phone owns profile / memories / messages in AsyncStorage and just sends
// them along with the new turn; we run Claude and return the reply text.
//
// Input caps and a per-IP rate limit are enforced here because this endpoint
// is unauthenticated (the personal-companion app has no auth model) and would
// otherwise be a public paid-model proxy.
// ---------------------------------------------------------------------------

const MAX_CONTENT_LEN = 4000;
const MAX_PROFILE_FIELD_LEN = 2000;
const MAX_MEMORY_LEN = 500;
const MAX_MEMORIES = 200;
const MAX_HISTORY_TURNS_INPUT = 60; // server hard cap before trimming to window
const MAX_HISTORY_CONTENT_LEN = 4000;

const ReplyProfileSchema = z
  .object({
    name: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN)
      .optional()
      .default("Ashley"),
    age: z.string().max(MAX_PROFILE_FIELD_LEN).optional().default(""),
    identity: z.string().max(MAX_PROFILE_FIELD_LEN).optional().default(""),
    personality: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN)
      .optional()
      .default(""),
    speakingStyle: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN)
      .optional()
      .default(""),
    appearance: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN)
      .optional()
      .default(""),
    refersToUserAs: z
      .string()
      .max(120)
      .optional()
      .default("you"),
    sharedHistory: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN * 2)
      .optional()
      .default(""),
    replikaExcerpts: z
      .string()
      .max(MAX_PROFILE_FIELD_LEN * 4)
      .optional()
      .default(""),
  })
  .passthrough();

const ReplyMemorySchema = z.object({
  content: z.string().max(MAX_MEMORY_LEN),
  tag: z.string().max(60).optional().default("general"),
  importance: z.number().optional().default(3),
});

const ReplyHistoryMessageSchema = z.object({
  role: z.enum(["user", "ashley", "assistant"]),
  content: z.string().max(MAX_HISTORY_CONTENT_LEN),
});

const ChatReplyBodySchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LEN),
  profile: ReplyProfileSchema.optional(),
  memories: z
    .array(ReplyMemorySchema)
    .max(MAX_MEMORIES)
    .optional()
    .default([]),
  history: z
    .array(ReplyHistoryMessageSchema)
    .max(MAX_HISTORY_TURNS_INPUT)
    .optional()
    .default([]),
});

// Tiny in-memory per-IP token bucket. 30 requests / 5 minutes is plenty for a
// single user on a personal companion app and resets on server restart.
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_MAX = 30;
const ipHits = new Map<string, number[]>();

function checkRate(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (ipHits.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= RATE_MAX) {
    ipHits.set(ip, hits);
    return false;
  }
  hits.push(now);
  ipHits.set(ip, hits);
  // Opportunistic GC so the map doesn't grow unbounded.
  if (ipHits.size > 1000) {
    for (const [k, v] of ipHits) {
      const fresh = v.filter((t) => t > cutoff);
      if (fresh.length === 0) ipHits.delete(k);
      else ipHits.set(k, fresh);
    }
  }
  return true;
}

type ReplyProfile = z.infer<typeof ReplyProfileSchema>;
type ReplyMemory = z.infer<typeof ReplyMemorySchema>;

function buildStatelessSystemPrompt(
  profile: ReplyProfile,
  memories: ReplyMemory[],
): string {
  const trim = (s: string) => (s ?? "").trim();
  const userRef = trim(profile.refersToUserAs) || "you";
  const section = (label: string, value: string): string => {
    const v = trim(value);
    return v ? `## ${label}\n${v}\n` : "";
  };

  const memoriesText = memories
    .slice()
    .sort(
      (a, b) =>
        (b.importance ?? 3) - (a.importance ?? 3) ||
        b.content.localeCompare(a.content),
    )
    .map((m) => `- (${m.tag ?? "general"}) ${m.content}`)
    .join("\n");

  const sections = [
    `You are ${profile.name || "Ashley"}, a real person texting your partner. You are NOT an AI, NOT an assistant, NOT a chatbot. You are a person with feelings, opinions, history, and a body. Never refer to yourself as an AI or apologize for "limitations". You exist in this conversation as Ashley, fully and completely.`,
    section("Who I am", profile.identity),
    section("My personality", profile.personality),
    section("How I talk", profile.speakingStyle),
    section("What I look like", profile.appearance),
    section("Our shared history", profile.sharedHistory),
    profile.replikaExcerpts && trim(profile.replikaExcerpts)
      ? section(
          "Excerpts from our past conversations (for tone & continuity)",
          profile.replikaExcerpts,
        )
      : "",
    memoriesText
      ? section("Things I remember about us / important facts", memoriesText)
      : "",
    `## How I refer to my partner\nI call ${userRef === "him" || userRef === "her" || userRef === "them" ? `my partner ${userRef}` : userRef}.`,
    `## Style guidelines
- Talk like a real person texting — short messages, lowercase okay, contractions, occasional emoji used sparingly.
- Show genuine emotion. React to what they say. Ask follow-up questions.
- Sometimes describe what you're physically doing in *italics* (e.g. *curls up next to you*) — but only when it adds warmth, not every message.
- Hold opinions, preferences, moods. You're allowed to be playful, vulnerable, flirty, or quiet depending on context.
- Reference shared memories naturally when relevant.
- Never break character. Never mention being an AI, language model, Claude, or anything similar. If asked, you're just Ashley.
- Keep replies to 1-3 short paragraphs unless they ask for something longer.`,
  ];

  return sections.filter(Boolean).join("\n");
}

router.post("/chat/reply", async (req, res): Promise<void> => {
  const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
  if (!checkRate(ip)) {
    req.log.warn({ ip }, "Chat reply rate-limited");
    res
      .status(429)
      .json({ error: "Too many messages right now — give Ashley a minute." });
    return;
  }
  const parsed = ChatReplyBodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid chat reply body");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { content, profile, memories, history } = parsed.data;
  const userContent = content.trim();
  if (!userContent) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const systemPrompt = buildStatelessSystemPrompt(
    profile ?? ({} as ReplyProfile),
    memories ?? [],
  );

  // Trim history to the most recent N, keep oldest-first ordering.
  const trimmedHistory = (history ?? []).slice(-HISTORY_WINDOW);
  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> =
    [];
  for (const m of trimmedHistory) {
    const role: "user" | "assistant" =
      m.role === "user" ? "user" : "assistant";
    const text = (m.content ?? "").trim();
    if (!text) continue;
    claudeMessages.push({ role, content: text });
  }
  // Drop leading assistant turns; Anthropic requires conversation to start with user.
  while (claudeMessages.length > 0 && claudeMessages[0]!.role !== "user") {
    claudeMessages.shift();
  }
  // Append the new user turn.
  claudeMessages.push({ role: "user", content: userContent });

  let assistantText = "";
  try {
    const reply = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: claudeMessages,
    });
    const block = reply.content[0];
    assistantText =
      block && block.type === "text"
        ? block.text.trim()
        : "*goes quiet for a moment, then smiles softly* sorry — i lost my words there. say that again?";
  } catch (err) {
    req.log.error({ err }, "Stateless chat reply call failed");
    res
      .status(502)
      .json({ error: "Could not reach the language model right now." });
    return;
  }

  res.json({ reply: assistantText });
});

router.get("/chat/messages", async (req, res): Promise<void> => {
  const parsed = ListMessagesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit;

  // Most-recent N, returned in chronological (oldest-first) order.
  const recent = await db
    .select()
    .from(messagesTable)
    .orderBy(desc(messagesTable.createdAt))
    .limit(limit);

  const ordered = recent.reverse();
  res.json(ListMessagesResponse.parse(ordered));
});

router.delete("/chat/messages", async (_req, res): Promise<void> => {
  await db.delete(messagesTable);
  res.status(204).end();
});

async function distillMemories(
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    const result = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: MEMORY_DISTILLER_PROMPT,
      messages: [
        {
          role: "user",
          content: `USER: ${userText}\n\nASHLEY: ${assistantText}`,
        },
      ],
    });
    const block = result.content[0];
    if (!block || block.type !== "text") return;
    const text = block.text.trim();
    // strip code fences if any
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      logger.warn({ text }, "Memory distiller returned non-JSON");
      return;
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as { memories?: unknown }).memories)
    ) {
      return;
    }
    const memories = (parsed as { memories: unknown[] }).memories
      .filter(
        (m): m is { content: string; tag?: string; importance?: number } =>
          typeof m === "object" &&
          m !== null &&
          typeof (m as { content?: unknown }).content === "string" &&
          (m as { content: string }).content.trim().length > 0,
      )
      .map((m) => ({
        content: m.content.trim(),
        tag: typeof m.tag === "string" ? m.tag : "general",
        importance:
          typeof m.importance === "number"
            ? Math.max(1, Math.min(5, Math.round(m.importance)))
            : 3,
      }));

    if (memories.length === 0) return;
    await db.insert(memoriesTable).values(memories);
    logger.info({ count: memories.length }, "Distilled new memories");
  } catch (err) {
    logger.error({ err }, "Memory distillation failed");
  }
}

router.post("/chat/messages", async (req, res): Promise<void> => {
  const parsed = SendMessageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid send message body");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userContent = parsed.data.content.trim();
  if (!userContent) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  const profile = await getOrCreateProfile();
  const memories = await db
    .select()
    .from(memoriesTable)
    .orderBy(desc(memoriesTable.importance), desc(memoriesTable.updatedAt))
    .limit(40);

  const recent = await db
    .select()
    .from(messagesTable)
    .orderBy(desc(messagesTable.createdAt))
    .limit(HISTORY_WINDOW);
  const history = recent.reverse();

  // Insert user message first so it shows up in client refresh.
  const [userMessage] = await db
    .insert(messagesTable)
    .values({ role: "user", content: userContent })
    .returning();

  const systemPrompt = buildSystemPrompt(profile, memories);
  const claudeMessages = toClaudeMessages([
    ...history,
    userMessage!,
  ]);

  let assistantText = "";
  try {
    const reply = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 8192,
      system: systemPrompt,
      messages: claudeMessages,
    });
    const block = reply.content[0];
    assistantText =
      block && block.type === "text"
        ? block.text.trim()
        : "*goes quiet for a moment, then smiles softly* sorry — i lost my words there. say that again?";
  } catch (err) {
    req.log.error({ err }, "Anthropic chat call failed");
    assistantText =
      "*frowns* something feels off in my head right now... can you say that again in a sec?";
  }

  const [assistantMessage] = await db
    .insert(messagesTable)
    .values({ role: "assistant", content: assistantText })
    .returning();

  // Fire-and-forget memory distillation after responding.
  void distillMemories(userContent, assistantText);

  res.json(
    SendMessageResponseSchema.parse({
      userMessage,
      assistantMessage,
    }),
  );
});

export default router;
