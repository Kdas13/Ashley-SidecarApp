import { Router, type IRouter } from "express";
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
