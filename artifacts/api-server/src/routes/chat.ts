import { Router, type IRouter } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import {
  db,
  ashleyProfileTable,
  conversationSummariesTable,
  memoriesTable,
  messagesTable,
  type AshleyProfile,
  type ConversationSummary,
  type Memory,
  type Message,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";

import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";
import { MEMORY_DISTILLER_PROMPT, SUMMARIZER_PROMPT } from "../lib/ashleyPrompt";
import { buildSystemPrompt } from "../lib/ashleyCoreSpec";
import { buildSelfiePromptSafetyPrefix } from "../lib/contentPolicy";
import {
  generateImageBase64,
  transcribeAudioBase64,
  transcribeAudioBase64Stream,
} from "../lib/openai";
import {
  saveSelfie,
  saveUserImage,
  userImageExtForMime,
  localSelfieDir,
} from "../lib/storage";
import {
  buildImagePromptAddendum,
  type ImageAnalysisMode as ImageAnalysisModeT,
  type ImageCategory as ImageCategoryT,
} from "../lib/ashleyCoreSpec";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHAT_MODEL = "claude-sonnet-4-6";
const HISTORY_WINDOW = 80;
const SUMMARY_CHUNK_SIZE = 20;
// Trigger summarization at the window boundary so messages get rolled into
// a summary BEFORE they fall off the verbatim history slice.
const SUMMARY_TRIGGER = HISTORY_WINDOW;

const MAX_CONTENT_LEN = 4000;
const MAX_REPLY_PREVIEW_LEN = 280;
const MAX_VIBE_LEN = 4000;

const ReplyToSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(["user", "ashley"]),
  preview: z.string().min(1).max(MAX_REPLY_PREVIEW_LEN),
});

const ChatBodySchema = z.object({
  userMessage: z.object({
    id: z.string().min(8).max(128),
    content: z.string().min(1).max(MAX_CONTENT_LEN),
    replyTo: ReplyToSchema.nullish(),
  }),
  clientNow: z.string().datetime({ offset: true }).optional(),
  clientTimezone: z.string().min(1).max(64).optional(),
});

// ---------------------------------------------------------------------------
// Time-awareness helpers — give Ashley a real sense of when "now" is for the
// user and how long it's been since they last spoke. Without these she has
// no way to answer "what time is it?" or to react naturally to a long gap.
// ---------------------------------------------------------------------------

function humanizeGap(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return "just now (under a minute since their last message)";
  const min = Math.floor(sec / 60);
  if (min < 60) return `about ${min} minute${min === 1 ? "" : "s"} since their last message`;
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    const remMin = min % 60;
    if (remMin >= 15 && hr < 6) {
      return `about ${hr} hour${hr === 1 ? "" : "s"} ${remMin} minute${remMin === 1 ? "" : "s"} since their last message`;
    }
    return `about ${hr} hour${hr === 1 ? "" : "s"} since their last message`;
  }
  const days = Math.floor(hr / 24);
  if (days < 7) return `about ${days} day${days === 1 ? "" : "s"} since their last message`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `about ${weeks} week${weeks === 1 ? "" : "s"} since their last message`;
  const months = Math.floor(days / 30);
  return `about ${months} month${months === 1 ? "" : "s"} since their last message`;
}

function formatLocalNow(
  isoNow: string | undefined,
  tz: string | undefined,
): { display: string; tz: string; iso: string } {
  // Prefer the client-supplied wall clock + tz so the user's timezone is
  // respected even when the server lives in UTC. Fall back to server time.
  const now = isoNow ? new Date(isoNow) : new Date();
  const safeTz = tz && tz.length <= 64 ? tz : "UTC";
  let display: string;
  try {
    display = new Intl.DateTimeFormat("en-GB", {
      timeZone: safeTz,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
  } catch {
    display = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(now);
  }
  return { display, tz: safeTz, iso: now.toISOString() };
}

function partOfDay(isoNow: string | undefined, tz: string | undefined): string {
  const now = isoNow ? new Date(isoNow) : new Date();
  const safeTz = tz && tz.length <= 64 ? tz : "UTC";
  let hour: number;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: safeTz,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value ?? "0";
    hour = Number.parseInt(h, 10);
  } catch {
    hour = now.getUTCHours();
  }
  if (hour < 5) return "the middle of the night";
  if (hour < 9) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  if (hour < 24) return "late evening";
  return "night";
}

function buildTimeContext(
  clientNow: string | undefined,
  clientTimezone: string | undefined,
  previousMessageAt: Date | null,
): string {
  const { display, tz } = formatLocalNow(clientNow, clientTimezone);
  const pod = partOfDay(clientNow, clientTimezone);
  const lines = [
    `## Time context (real-world, refresh every turn)`,
    `Right now for them it is: ${display} (${tz}). Loosely: ${pod}.`,
  ];
  if (previousMessageAt) {
    const nowMs = clientNow ? new Date(clientNow).getTime() : Date.now();
    const gapMs = nowMs - previousMessageAt.getTime();
    lines.push(`Time since their previous message in this chat: ${humanizeGap(gapMs)}.`);
    if (gapMs >= 30 * 60 * 1000) {
      lines.push(
        `There's been a real gap. This is NOT a fresh conversation — it's a continuation. Look back at the most recent messages above. If you asked them something and they never answered, OR if you were in the middle of a thread that got left hanging, gently pick that thread back up rather than acting like a new session is starting. Don't say "new conversation" or reset the vibe. If nothing was left unanswered, just naturally check in on whatever the last topic was, or on them.`,
      );
    }
  } else {
    lines.push(`This is genuinely the first message you have from them in this conversation.`);
  }
  lines.push(
    `Use this to answer "what time is it?" honestly, to greet them in a way that fits the time of day, and to handle gaps as continuations of an ongoing relationship — never as fresh starts. Don't recite the timestamp unless asked — just be aware of it.`,
  );
  return lines.join("\n");
}

// Prompt construction lives in ../lib/ashleyCoreSpec.ts (single source of
// truth for the Ashley Core Behaviour Spec). buildSystemPrompt is imported
// at the top of this file.

const SELFIE_MARKER_RE = /\[selfie:\s*([^\]]+)\]/i;

function publicBaseUrl(): string {
  const domains = (process.env["REPLIT_DOMAINS"] ?? "").split(",");
  const first = domains[0]?.trim();
  if (first) return `https://${first}`;
  return "http://localhost:80";
}

function newId(): string {
  return randomUUID();
}

// ---------------------------------------------------------------------------
// POST /chat — the one chat endpoint
// ---------------------------------------------------------------------------

router.post("/chat", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ChatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id: userId, content, replyTo } = parsed.data.userMessage;
  const { clientNow, clientTimezone } = parsed.data;
  const userContent = content.trim();
  if (!userContent) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  // 1. Persist the user message immediately. Idempotent on id so a retry
  //    of the same client-generated id doesn't double-insert.
  let userRow: Message;
  try {
    const inserted = await db
      .insert(messagesTable)
      .values({
        id: userId,
        deviceId,
        role: "user",
        content: userContent,
        replyToId: replyTo?.id ?? null,
        replyToRole: replyTo?.role ?? null,
        replyToPreview: replyTo?.preview ?? null,
      })
      .onConflictDoNothing({ target: messagesTable.id })
      .returning();
    if (inserted.length > 0) {
      userRow = inserted[0]!;
    } else {
      const existing = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.id, userId),
            eq(messagesTable.deviceId, deviceId),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        res
          .status(409)
          .json({ error: "Message id collides with another device" });
        return;
      }
      userRow = existing[0]!;

      // Idempotency: if we've already generated an Ashley reply for this
      // user message in a previous attempt, return that pair as-is rather
      // than spinning up a second Claude call (which would create an
      // orphan reply in the DB and double-bill us). We identify the
      // reply as the next Ashley message in time, scoped to this device.
      const existingReply = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.deviceId, deviceId),
            eq(messagesTable.role, "ashley"),
            gt(messagesTable.createdAt, userRow.createdAt),
          ),
        )
        .orderBy(asc(messagesTable.createdAt))
        .limit(1);
      if (existingReply.length > 0) {
        res.json({ userMessage: userRow, ashleyMessage: existingReply[0]! });
        return;
      }
    }
  } catch (err) {
    req.log.error({ err }, "Failed to persist user message");
    res.status(500).json({ error: "Could not save your message" });
    return;
  }

  // 2. Load context from DB.
  let profile: AshleyProfile;
  let memories: Memory[];
  let summaries: ConversationSummary[];
  let history: Message[];
  try {
    profile = await getOrCreateProfileFor(deviceId);
    [memories, summaries, history] = await Promise.all([
      db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.deviceId, deviceId)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId)),
      // Pull the most recent HISTORY_WINDOW messages (incl. the just-saved
      // user one) and reverse so prompt is chronological.
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.deviceId, deviceId))
        .orderBy(desc(messagesTable.createdAt))
        .limit(HISTORY_WINDOW),
    ]);
    history.reverse();
  } catch (err) {
    req.log.error({ err }, "Failed to load chat context from DB");
    res.status(500).json({ error: "Could not load conversation" });
    return;
  }

  // 3. Build the prompt. The just-saved user message is included as the
  //    final user turn so we don't need to append it separately. We DO
  //    rewrite that turn to include the swipe-to-reply quote when present.
  // The previous message is the one immediately before the just-saved user
  // turn — we use its createdAt to tell Ashley how long the gap was.
  let previousMessageAt: Date | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.id !== userRow.id) {
      previousMessageAt = m.createdAt;
      break;
    }
  }
  const timeContext = buildTimeContext(
    clientNow,
    clientTimezone,
    previousMessageAt,
  );
  const systemPrompt = `${timeContext}\n\n${buildSystemPrompt(profile, memories, summaries)}`;
  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> =
    [];
  for (const m of history) {
    const role: "user" | "assistant" =
      m.role === "user" ? "user" : "assistant";
    let text = (m.content ?? "").trim();
    if (m.id === userRow.id && replyTo) {
      const previewClean = replyTo.preview.replace(/\s+/g, " ").trim();
      if (previewClean) {
        const refersTo =
          replyTo.role === "ashley"
            ? "your earlier message"
            : "my earlier message";
        text = `> Replying to ${refersTo}: "${previewClean}"\n\n${text}`;
      }
    }
    if (!text) continue;
    claudeMessages.push({ role, content: text });
  }
  while (claudeMessages.length > 0 && claudeMessages[0]!.role !== "user") {
    claudeMessages.shift();
  }
  if (claudeMessages.length === 0) {
    claudeMessages.push({ role: "user", content: userContent });
  }

  // 4. Call Claude.
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
    req.log.error({ err }, "Claude call failed");
    res
      .status(502)
      .json({ error: "Could not reach the language model right now." });
    return;
  }

  // 5. Strip selfie marker (first one only) and remember the vibe.
  let selfieVibe: string | null = null;
  const match = assistantText.match(SELFIE_MARKER_RE);
  if (match) {
    const vibe = match[1]!.trim();
    if (vibe.length > 0) selfieVibe = vibe;
    const before = assistantText.slice(0, match.index).trim();
    const after = assistantText
      .slice(match.index! + match[0].length)
      .replace(/\[selfie:\s*[^\]]+\]/gi, "")
      .trim();
    const joined = [before, after].filter((s) => s.length > 0).join("\n\n");
    assistantText = joined;
    if (!assistantText) {
      assistantText = selfieVibe
        ? "*holds up the camera* one sec…"
        : "*tries to take a selfie but fumbles the camera* one sec — try again?";
    }
  }

  // 6. Persist Ashley's reply.
  let ashleyRow: Message;
  try {
    const [inserted] = await db
      .insert(messagesTable)
      .values({
        id: newId(),
        deviceId,
        role: "ashley",
        content: assistantText,
        selfieVibe,
      })
      .returning();
    ashleyRow = inserted!;
  } catch (err) {
    req.log.error({ err }, "Failed to persist Ashley reply");
    res.status(500).json({ error: "Could not save Ashley's reply" });
    return;
  }

  // 7. Fire-and-forget: distill memories + maybe roll up older messages.
  void distillMemories(deviceId, userContent, assistantText);
  void maybeRollUpOlderMessages(deviceId);

  res.json({ userMessage: userRow, ashleyMessage: ashleyRow });
});

// ---------------------------------------------------------------------------
// Selfie endpoints (kept as poll-based, scoped per device + per message)
// ---------------------------------------------------------------------------

const ChatSelfieBodySchema = z.object({
  messageId: z.string().min(8).max(128),
  vibe: z.string().min(1).max(MAX_VIBE_LEN),
});

type SelfieJob =
  | {
      status: "pending";
      vibe: string;
      deviceId: string;
      messageId: string;
      createdAt: number;
    }
  | {
      status: "ready";
      imageUrl: string;
      deviceId: string;
      messageId: string;
      createdAt: number;
    }
  | {
      status: "failed";
      error: string;
      deviceId: string;
      messageId: string;
      createdAt: number;
    };

const SELFIE_JOB_TTL_MS = 30 * 60 * 1000;
const selfieJobs = new Map<string, SelfieJob>();

const SELFIE_JOBS_FILE = path.join(
  path.dirname(localSelfieDir),
  "selfie-jobs.json",
);

function persistSelfieJobs(): void {
  try {
    const obj: Record<string, SelfieJob> = {};
    for (const [id, job] of selfieJobs) obj[id] = job;
    const tmp = `${SELFIE_JOBS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, SELFIE_JOBS_FILE);
  } catch (err) {
    logger.warn({ err }, "Failed to persist selfie jobs to disk");
  }
}

function loadSelfieJobs(): void {
  try {
    if (!fs.existsSync(SELFIE_JOBS_FILE)) return;
    const raw = fs.readFileSync(SELFIE_JOBS_FILE, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Record<string, SelfieJob>;
    const cutoff = Date.now() - SELFIE_JOB_TTL_MS;
    for (const [id, job] of Object.entries(parsed)) {
      if (
        job &&
        typeof job.createdAt === "number" &&
        job.createdAt >= cutoff &&
        typeof job.deviceId === "string" &&
        typeof job.messageId === "string"
      ) {
        selfieJobs.set(id, job);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted selfie jobs");
  }
}

function setSelfieJob(jobId: string, job: SelfieJob): void {
  selfieJobs.set(jobId, job);
  persistSelfieJobs();
}

function pruneSelfieJobs(): void {
  const cutoff = Date.now() - SELFIE_JOB_TTL_MS;
  let pruned = false;
  for (const [id, job] of selfieJobs) {
    if (job.createdAt < cutoff) {
      selfieJobs.delete(id);
      pruned = true;
    }
  }
  if (pruned) persistSelfieJobs();
}

async function generateAshleySelfie(
  vibe: string,
  profile: AshleyProfile,
): Promise<string | null> {
  const appearance = (profile.appearance ?? "").trim();
  const ashleyName = (profile.name ?? "Ashley").trim() || "Ashley";
  const fullPrompt = [
    // Provider Floor for the IMAGE generator. Always first, never overridden
    // by mode/intimacy — see lib/contentPolicy.ts. The downstream image
    // provider has its own safety filter; this prefix keeps requests well
    // inside it so we degrade by Ashley saying "couldn't get the shot —
    // try a different vibe" rather than by hitting a hard provider error.
    buildSelfiePromptSafetyPrefix(),
    `Photograph (selfie) of ${ashleyName}, a young woman.`,
    appearance ? `Appearance: ${appearance}` : "",
    `Style: warm intimate phone-camera selfie, natural lighting, slightly soft focus, no text or watermarks.`,
    `Vibe / scene: ${vibe}`,
    `Single subject, full or half-body framing, soft and flattering. Avoid uncanny faces.`,
  ]
    .filter(Boolean)
    .join("\n");

  let b64: string;
  try {
    b64 = await generateImageBase64(fullPrompt, "1024x1024");
  } catch (err) {
    logger.warn({ err }, "Selfie image generation failed");
    return null;
  }

  const id = randomUUID();
  try {
    const relUrl = await saveSelfie(id, Buffer.from(b64, "base64"));
    return `${publicBaseUrl()}${relUrl}`;
  } catch (err) {
    logger.warn({ err }, "Failed to persist selfie");
    return null;
  }
}

function startSelfieGeneration(
  jobId: string,
  vibe: string,
  deviceId: string,
  messageId: string,
): void {
  void (async () => {
    try {
      const profile = await getOrCreateProfileFor(deviceId);
      const imageUrl = await generateAshleySelfie(vibe, profile);
      if (imageUrl) {
        // Patch the assistant message row so the next /state hydration
        // reflects the photo even if the client misses the poll.
        try {
          await db
            .update(messagesTable)
            .set({ imageUrl, selfieVibe: null })
            .where(
              and(
                eq(messagesTable.id, messageId),
                eq(messagesTable.deviceId, deviceId),
              ),
            );
        } catch (err) {
          logger.warn(
            { err, messageId, deviceId },
            "Failed to patch message row with selfie image",
          );
        }
        setSelfieJob(jobId, {
          status: "ready",
          imageUrl,
          deviceId,
          messageId,
          createdAt: Date.now(),
        });
      } else {
        setSelfieJob(jobId, {
          status: "failed",
          error: "Couldn't take that selfie — try again?",
          deviceId,
          messageId,
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      logger.warn({ err, jobId }, "Background selfie generation crashed");
      setSelfieJob(jobId, {
        status: "failed",
        error:
          err instanceof Error && err.message
            ? err.message
            : "Selfie generation crashed.",
        deviceId,
        messageId,
        createdAt: Date.now(),
      });
    }
  })();
}

// Boot recovery: re-issue any pending jobs after a server restart.
loadSelfieJobs();
for (const [id, job] of selfieJobs) {
  if (job.status === "pending") {
    logger.info({ jobId: id }, "Resuming selfie job after server restart");
    startSelfieGeneration(id, job.vibe, job.deviceId, job.messageId);
  }
}

router.post("/chat/selfie", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ChatSelfieBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { messageId, vibe } = parsed.data;

  // Confirm the message belongs to this device — prevents using another
  // device's id with our own deviceId via header.
  const owns = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.id, messageId),
        eq(messagesTable.deviceId, deviceId),
      ),
    )
    .limit(1);
  if (owns.length === 0) {
    res.status(404).json({ error: "Message not found" });
    return;
  }

  pruneSelfieJobs();
  const jobId = randomUUID();
  setSelfieJob(jobId, {
    status: "pending",
    vibe: vibe.trim(),
    deviceId,
    messageId,
    createdAt: Date.now(),
  });
  startSelfieGeneration(jobId, vibe.trim(), deviceId, messageId);
  res.status(202).json({ jobId });
});

router.get("/chat/selfie/:jobId", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const jobId = (req.params["jobId"] ?? "").toString();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  pruneSelfieJobs();
  const job = selfieJobs.get(jobId);
  if (!job || job.deviceId !== deviceId) {
    res.status(404).json({ error: "Selfie job not found or expired." });
    return;
  }
  if (job.status === "ready") {
    res.json({
      status: "ready",
      imageUrl: job.imageUrl,
      messageId: job.messageId,
    });
    return;
  }
  if (job.status === "failed") {
    res.json({ status: "failed", error: job.error });
    return;
  }
  res.json({ status: "pending" });
});

// ---------------------------------------------------------------------------
// Background helpers — memory distillation + summarization
// ---------------------------------------------------------------------------

async function distillMemories(
  deviceId: string,
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
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
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
        id: randomUUID(),
        deviceId,
        content: m.content.trim().slice(0, 500),
        tag: typeof m.tag === "string" ? m.tag : "general",
        importance:
          typeof m.importance === "number"
            ? Math.max(1, Math.min(5, Math.round(m.importance)))
            : 3,
      }));

    if (memories.length === 0) return;
    await db.insert(memoriesTable).values(memories);
    logger.info(
      { count: memories.length, deviceId },
      "Distilled new memories",
    );
  } catch (err) {
    logger.error({ err }, "Memory distillation failed");
  }
}

// One-at-a-time guard so back-to-back chat turns don't fire overlapping
// summarization runs against the same device.
const summarizationInFlight = new Set<string>();

async function maybeRollUpOlderMessages(deviceId: string): Promise<void> {
  if (summarizationInFlight.has(deviceId)) return;
  summarizationInFlight.add(deviceId);
  try {
    const [allMessages, summaries] = await Promise.all([
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.deviceId, deviceId))
        .orderBy(asc(messagesTable.createdAt)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId))
        .orderBy(asc(conversationSummariesTable.coveredThroughCreatedAt)),
    ]);

    const latest = summaries[summaries.length - 1] ?? null;
    const cursorMs = latest ? latest.coveredThroughCreatedAt.getTime() : -Infinity;

    const unsummarized = allMessages.filter(
      (m) => m.createdAt.getTime() > cursorMs,
    );
    if (unsummarized.length < SUMMARY_TRIGGER) return;

    const chunk = unsummarized.slice(0, SUMMARY_CHUNK_SIZE);
    const last = chunk[chunk.length - 1];
    if (!last) return;

    const transcript = chunk
      .map((m) => {
        const speaker = m.role === "user" ? "USER" : "ASHLEY";
        return `${speaker}: ${(m.content ?? "").trim()}`;
      })
      .filter((line) => !line.endsWith(": "))
      .join("\n");

    const userBlock =
      latest && latest.summary
        ? `Earlier summary (for context, do not repeat verbatim):\n${latest.summary.trim()}\n\n---\n\nNew chunk to summarize:\n${transcript}`
        : `Chunk to summarize:\n${transcript}`;

    const result = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: SUMMARIZER_PROMPT,
      messages: [{ role: "user", content: userBlock }],
    });
    const block = result.content[0];
    const summaryText =
      block && block.type === "text" ? block.text.trim() : "";
    if (!summaryText) return;

    await db.insert(conversationSummariesTable).values({
      id: randomUUID(),
      deviceId,
      summary: summaryText,
      messageCount: chunk.length,
      coveredThroughCreatedAt: last.createdAt,
    });
    logger.info(
      { chunkSize: chunk.length, deviceId },
      "Rolled older messages into a summary",
    );
  } catch (err) {
    logger.error({ err }, "Summarization run failed");
  } finally {
    summarizationInFlight.delete(deviceId);
  }
  // reference unused import to avoid lint issues if drizzle helpers change
  void ashleyProfileTable;
}

// ---------------------------------------------------------------------------
// POST /chat/transcribe — Stage 1 of the staged voice plan.
//
// Push-to-talk audio arrives as base64 in JSON. We forward to OpenAI
// Whisper and return the transcript text. The transcript is NOT
// auto-sent — the mobile client drops it into the chat draft for the
// user to review and send manually via the regular /chat path. This
// keeps voice as a strict input modality on top of the existing text
// chokepoint, with no new prompt-bypass paths.
//
// Future stages: switch to streaming chunks, add inputMode="voice"
// flag on the eventual /chat send so buildSystemPrompt can append the
// voice-presence safety floor (see contentPolicy.ts).
// ---------------------------------------------------------------------------

const TranscribeBodySchema = z.object({
  audioBase64: z.string().min(100, "Recording too short"),
  mimeType: z
    .string()
    .min(3)
    .max(64)
    .regex(/^audio\//, "mimeType must start with audio/"),
  durationMs: z.number().int().nonnegative().optional(),
});

function audioFilenameFor(mimeType: string): string {
  const m = mimeType.toLowerCase();
  if (m.includes("wav")) return "speech.wav";
  if (m.includes("webm")) return "speech.webm";
  if (m.includes("ogg")) return "speech.ogg";
  if (m.includes("mpeg") || m.includes("mp3")) return "speech.mp3";
  if (m.includes("caf")) return "speech.caf";
  return "speech.m4a";
}

router.post("/chat/transcribe", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ error: "X-Device-Id header is required" });
    return;
  }
  const parsed = TranscribeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ?? "Invalid /chat/transcribe payload",
    });
    return;
  }
  const { audioBase64, mimeType } = parsed.data;
  try {
    const transcript = await transcribeAudioBase64(
      audioBase64,
      audioFilenameFor(mimeType),
      mimeType,
    );
    res.json({ transcript });
  } catch (err) {
    req.log.error({ err }, "Whisper transcription failed");
    res.status(502).json({
      error: "Couldn't transcribe that — try again or just type it.",
    });
  }
});

// ---------------------------------------------------------------------------
// POST /chat/transcribe/stream — Stage 2 of the staged voice plan.
//
// Same request shape as /chat/transcribe; the response is an SSE stream
// so the client can show partial transcripts while the model is still
// producing text. Push-to-talk semantics unchanged — the audio still
// arrives as a single base64 blob; only the response is streamed.
//
// Wire format (one message per chunk, per SSE convention):
//   event: delta
//   data: {"text":"…incremental chunk…"}
//
//   event: done
//   data: {"transcript":"…final full text…"}
//
//   event: error
//   data: {"error":"…user-facing message…"}
//
// The client (lib/aiClient.ts → transcribeAudioStream) accumulates the
// deltas for a live banner preview and uses the `done` event's transcript
// as the authoritative final string to append to the chat draft. If the
// stream fails mid-flight, the client falls back to the non-streaming
// /chat/transcribe endpoint so the user always gets a transcript.
// ---------------------------------------------------------------------------

router.post("/chat/transcribe/stream", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ error: "X-Device-Id header is required" });
    return;
  }
  const parsed = TranscribeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ??
        "Invalid /chat/transcribe/stream payload",
    });
    return;
  }
  const { audioBase64, mimeType } = parsed.data;

  // Set up SSE headers. X-Accel-Buffering: no asks proxies (nginx, the
  // Replit proxy) not to buffer the response; without it events would
  // pile up until the connection closes and the "live" feel is lost.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const writeEvent = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  try {
    let finalTranscript = "";
    for await (const ev of transcribeAudioBase64Stream(
      audioBase64,
      audioFilenameFor(mimeType),
      mimeType,
    )) {
      if (aborted) return;
      if (ev.kind === "delta") {
        writeEvent("delta", { text: ev.text });
      } else {
        finalTranscript = ev.text;
        writeEvent("done", { transcript: ev.text });
      }
    }
    // Defensive — if the upstream loop exited without emitting "done"
    // (the SDK should always close with one, but belt-and-braces) push
    // a done with whatever we accumulated so the client commits a
    // transcript instead of timing out.
    if (!aborted && !res.writableEnded) {
      writeEvent("done", { transcript: finalTranscript });
    }
  } catch (err) {
    req.log.error({ err }, "Whisper streaming transcription failed");
    if (!aborted && !res.writableEnded) {
      writeEvent("error", {
        error: "Couldn't transcribe that — try again or just type it.",
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});

export default router;

// ---------------------------------------------------------------------------
// POST /chat/image — paperclip upload + Claude vision analysis
// ---------------------------------------------------------------------------

const ALLOWED_IMAGE_MIME = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;
const CLAUDE_IMAGE_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
type ClaudeImageMime = (typeof CLAUDE_IMAGE_MIME)[number];

const IMAGE_CATEGORY_VALUES = [
  "art_progress",
  "ashley_identity",
  "app_screenshot",
  "medical",
  "clothing_design",
  "other",
] as const;

const IMAGE_MODE_VALUES = [
  "quick",
  "critique",
  "stepbystep",
  "debug",
  "extract",
  "compare",
] as const;

// Approximate cap: 5 MB raw → ~6.7 MB base64. We accept up to 7 MB of
// base64 string length so a clean 5 MB photo from the picker fits.
const MAX_IMAGE_BASE64_LEN = 7 * 1024 * 1024;

const ChatImageBodySchema = z.object({
  userMessage: z.object({
    id: z.string().min(8).max(128),
    content: z.string().max(MAX_CONTENT_LEN).optional().default(""),
    replyTo: ReplyToSchema.nullish(),
  }),
  image: z.object({
    base64: z.string().min(64).max(MAX_IMAGE_BASE64_LEN),
    mimeType: z.string().min(3).max(64),
  }),
  category: z.enum(IMAGE_CATEGORY_VALUES),
  mode: z.enum(IMAGE_MODE_VALUES),
  clientNow: z.string().datetime({ offset: true }).optional(),
  clientTimezone: z.string().min(1).max(64).optional(),
});

router.post("/chat/image", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ChatImageBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { userMessage, image, category, mode, clientNow, clientTimezone } =
    parsed.data;
  const { id: userId, replyTo } = userMessage;
  const caption = (userMessage.content ?? "").trim();

  const mime = image.mimeType.toLowerCase();
  if (!ALLOWED_IMAGE_MIME.includes(mime as (typeof ALLOWED_IMAGE_MIME)[number])) {
    res.status(415).json({ error: `Unsupported image type: ${mime}` });
    return;
  }
  // HEIC isn't supported by Claude vision — clients should re-encode before
  // upload, but reject here too for safety.
  const claudeMime: ClaudeImageMime = mime === "image/jpg" ? "image/jpeg" : (mime as ClaudeImageMime);
  if (!CLAUDE_IMAGE_MIME.includes(claudeMime)) {
    res.status(415).json({ error: `Image type ${mime} can't be analysed` });
    return;
  }

  // 1. Persist the image to object storage / disk.
  let imageUrl: string;
  try {
    const ext = userImageExtForMime(mime);
    const filename = `${userId}.${ext}`;
    const buf = Buffer.from(image.base64, "base64");
    const relUrl = await saveUserImage(filename, buf, mime);
    imageUrl = `${publicBaseUrl()}${relUrl}`;
  } catch (err) {
    req.log.error({ err }, "Failed to save uploaded image");
    res.status(500).json({ error: "Could not save your image" });
    return;
  }

  // 2. Persist the user message (idempotent on id).
  let userRow: Message;
  try {
    const inserted = await db
      .insert(messagesTable)
      .values({
        id: userId,
        deviceId,
        role: "user",
        content: caption,
        imageUrl,
        imageMimeType: mime,
        imageCategory: category,
        imageCaption: caption,
        imageAnalysisMode: mode,
        replyToId: replyTo?.id ?? null,
        replyToRole: replyTo?.role ?? null,
        replyToPreview: replyTo?.preview ?? null,
      })
      .onConflictDoNothing({ target: messagesTable.id })
      .returning();
    if (inserted.length > 0) {
      userRow = inserted[0]!;
    } else {
      const existing = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.id, userId),
            eq(messagesTable.deviceId, deviceId),
          ),
        )
        .limit(1);
      if (existing.length === 0) {
        res
          .status(409)
          .json({ error: "Message id collides with another device" });
        return;
      }
      userRow = existing[0]!;
      // Idempotency: if Ashley already replied to this image, return the pair.
      const existingReply = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.deviceId, deviceId),
            eq(messagesTable.role, "ashley"),
            gt(messagesTable.createdAt, userRow.createdAt),
          ),
        )
        .orderBy(asc(messagesTable.createdAt))
        .limit(1);
      if (existingReply.length > 0) {
        res.json({ userMessage: userRow, ashleyMessage: existingReply[0]! });
        return;
      }
    }
  } catch (err) {
    req.log.error({ err }, "Failed to persist user image message");
    res.status(500).json({ error: "Could not save your message" });
    return;
  }

  // 3. Load context from DB (same shape as /chat).
  let profile: AshleyProfile;
  let memories: Memory[];
  let summaries: ConversationSummary[];
  let history: Message[];
  try {
    profile = await getOrCreateProfileFor(deviceId);
    [memories, summaries, history] = await Promise.all([
      db.select().from(memoriesTable).where(eq(memoriesTable.deviceId, deviceId)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId)),
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.deviceId, deviceId))
        .orderBy(desc(messagesTable.createdAt))
        .limit(HISTORY_WINDOW),
    ]);
    history.reverse();
  } catch (err) {
    req.log.error({ err }, "Failed to load chat context for image turn");
    res.status(500).json({ error: "Could not load conversation" });
    return;
  }

  // 4. Build prompt: time context + core spec + image addendum.
  let previousMessageAt: Date | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.id !== userRow.id) {
      previousMessageAt = m.createdAt;
      break;
    }
  }
  const timeContext = buildTimeContext(
    clientNow,
    clientTimezone,
    previousMessageAt,
  );
  const userRef = (profile.refersToUserAs ?? "you").trim() || "you";
  const imageAddendum = buildImagePromptAddendum({
    category: category as ImageCategoryT,
    mode: mode as ImageAnalysisModeT,
    caption,
    userRef,
  });
  const systemPrompt = `${timeContext}\n\n${buildSystemPrompt(profile, memories, summaries)}\n\n${imageAddendum}`;

  // 5. Build Claude messages: history as text-only (older images become a
  //    "[user shared a photo]" placeholder so we don't blow context).
  type TextBlock = { type: "text"; text: string };
  type ImageBlock = {
    type: "image";
    source: { type: "base64"; media_type: ClaudeImageMime; data: string };
  };
  type ContentBlock = TextBlock | ImageBlock;
  const claudeMessages: Array<{
    role: "user" | "assistant";
    content: string | ContentBlock[];
  }> = [];
  for (const m of history) {
    if (m.id === userRow.id) continue; // appended last with image content
    const role: "user" | "assistant" =
      m.role === "user" ? "user" : "assistant";
    let text = (m.content ?? "").trim();
    if (m.imageUrl && m.role === "user") {
      const cat = m.imageCategory ? ` (${m.imageCategory})` : "";
      const cap = text ? `: "${text}"` : "";
      text = `[shared a photo${cat}${cap}]`;
    }
    if (m.imageUrl && m.role === "ashley" && !text) {
      text = "[sent a selfie]";
    }
    if (!text) continue;
    claudeMessages.push({ role, content: text });
  }
  // Final turn: the image itself + caption + mode hint as a tiny nudge.
  const captionForModel = caption.length > 0 ? caption : "(no caption)";
  const modelHint = `[Photo attached. Category: ${category}. Mode: ${mode}. Caption: ${captionForModel}]`;
  const finalContent: ContentBlock[] = [
    {
      type: "image",
      source: { type: "base64", media_type: claudeMime, data: image.base64 },
    },
    { type: "text", text: modelHint },
  ];
  claudeMessages.push({ role: "user", content: finalContent });

  while (claudeMessages.length > 0 && claudeMessages[0]!.role !== "user") {
    claudeMessages.shift();
  }

  // 6. Call Claude vision.
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
        : "*looks at the photo, then back at you* sorry — i lost my words for a second. tell me again what you wanted me to see?";
  } catch (err) {
    req.log.error({ err }, "Claude vision call failed");
    res
      .status(502)
      .json({ error: "Could not reach the language model right now." });
    return;
  }
  // Strip any rogue [selfie: ...] tag — she shouldn't be sending one in
  // response to a photo, but if she does we just drop it.
  assistantText = assistantText.replace(/\[selfie:\s*[^\]]+\]/gi, "").trim();
  if (!assistantText) {
    assistantText = "*looks at the photo* one sec — let me try that again?";
  }

  // 7. Persist Ashley's reply.
  let ashleyRow: Message;
  try {
    const [inserted] = await db
      .insert(messagesTable)
      .values({
        id: newId(),
        deviceId,
        role: "ashley",
        content: assistantText,
      })
      .returning();
    ashleyRow = inserted!;
  } catch (err) {
    req.log.error({ err }, "Failed to persist Ashley reply for image turn");
    res.status(500).json({ error: "Could not save Ashley's reply" });
    return;
  }

  // 8. Fire-and-forget: distill memories + maybe summarize.
  const userTextForDistill = caption
    ? `[shared a ${category} photo] ${caption}`
    : `[shared a ${category} photo, mode=${mode}]`;
  void distillMemories(deviceId, userTextForDistill, assistantText);
  void maybeRollUpOlderMessages(deviceId);

  res.json({ userMessage: userRow, ashleyMessage: ashleyRow });
});

// ---------------------------------------------------------------------------
// POST /messages/:id/remember — user's decision on the "should I remember
// this image?" card. Sets messages.image_remembered and, when the user
// chose to remember, inserts a memory row tied to the image.
// ---------------------------------------------------------------------------

const RememberBodySchema = z.object({
  decision: z.enum(["remember", "visual", "dismiss"]),
});

router.post("/messages/:id/remember", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const messageId = req.params.id;
  const parsed = RememberBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const decision = parsed.data.decision;

  // Confirm the message belongs to this device and IS an image message.
  const owns = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.id, messageId),
        eq(messagesTable.deviceId, deviceId),
      ),
    )
    .limit(1);
  if (owns.length === 0) {
    res.status(404).json({ error: "Message not found" });
    return;
  }
  const msg = owns[0]!;
  if (!msg.imageUrl) {
    res.status(400).json({ error: "Message has no image to remember" });
    return;
  }

  const newValue = decision === "dismiss" ? false : true;
  let updatedMsg: Message;
  try {
    const [row] = await db
      .update(messagesTable)
      .set({ imageRemembered: newValue })
      .where(
        and(
          eq(messagesTable.id, messageId),
          eq(messagesTable.deviceId, deviceId),
        ),
      )
      .returning();
    updatedMsg = row!;
  } catch (err) {
    req.log.error({ err }, "Failed to update image-remembered flag");
    res.status(500).json({ error: "Could not save your choice" });
    return;
  }

  // For "remember" / "visual" decisions, drop a memory row so Ashley can
  // weave the image into future turns. Find the Ashley reply that
  // immediately follows this user image so we can include her summary.
  if (decision !== "dismiss") {
    try {
      const followups = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.deviceId, deviceId),
            eq(messagesTable.role, "ashley"),
            gt(messagesTable.createdAt, updatedMsg.createdAt),
          ),
        )
        .orderBy(asc(messagesTable.createdAt))
        .limit(1);
      const ashleyReply = followups[0]?.content ?? "";
      const cap = (updatedMsg.imageCaption ?? "").trim();
      const cat = updatedMsg.imageCategory ?? "other";
      const head = decision === "visual"
        ? `Visual reference (${cat})`
        : `Image moment (${cat})`;
      const detail =
        cap.length > 0 ? `Their note: "${cap}".` : "No caption.";
      const ashleyBit =
        ashleyReply.length > 0
          ? ` My reaction at the time: "${ashleyReply.slice(0, 320).trim()}${ashleyReply.length > 320 ? "…" : ""}"`
          : "";
      const memoryContent = `${head}. ${detail}${ashleyBit}`.slice(0, 500);
      await db.insert(memoriesTable).values({
        id: randomUUID(),
        deviceId,
        content: memoryContent,
        tag: cat === "medical" ? "event" : cat === "ashley_identity" ? "relationship" : "general",
        importance: decision === "remember" ? 4 : 3,
      });
    } catch (err) {
      req.log.warn(
        { err, messageId },
        "Failed to insert image memory row (decision still saved)",
      );
    }
  }

  res.json({ message: updatedMsg });
});
