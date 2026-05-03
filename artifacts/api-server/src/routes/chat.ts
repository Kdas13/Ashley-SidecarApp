import { Router, type IRouter } from "express";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  db,
  messagesTable,
  memoriesTable,
  conversationSummariesTable,
} from "@workspace/db";
import { asc, desc, gt } from "drizzle-orm";
import {
  ListMessagesResponse,
  ListMessagesQueryParams,
  SendMessageBodySchema,
  SendMessageResponseSchema,
  SummarizeChunkBodySchema,
  SummarizeChunkResponseSchema,
} from "@workspace/api-zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { getOrCreateProfile } from "../lib/profile";
import {
  buildSystemPrompt,
  toClaudeMessages,
  MEMORY_DISTILLER_PROMPT,
  SUMMARIZER_PROMPT,
} from "../lib/ashleyPrompt";
import { generateImageBase64 } from "../lib/openai";
import { saveSelfie, localSelfieDir } from "../lib/storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHAT_MODEL = "claude-sonnet-4-6";
const HISTORY_WINDOW = 30;
// Summarize the oldest CHUNK once we have at least HISTORY_WINDOW + CHUNK
// unsummarized messages — that way the live window always stays full.
const SUMMARY_CHUNK_SIZE = 20;
const SUMMARY_TRIGGER = HISTORY_WINDOW + SUMMARY_CHUNK_SIZE;
const MAX_SUMMARIES_IN_PROMPT = 8;

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

const MAX_SUMMARY_LEN = 4000;
const MAX_SUMMARIES = 50;

const ReplySummarySchema = z.object({
  summary: z.string().max(MAX_SUMMARY_LEN),
  coveredThroughCreatedAt: z.string().optional().default(""),
});

const MAX_REPLY_PREVIEW_LEN = 280;

const ReplyToSchema = z.object({
  role: z.enum(["user", "ashley"]),
  preview: z.string().min(1).max(MAX_REPLY_PREVIEW_LEN),
});

const ChatReplyBodySchema = z.object({
  content: z.string().min(1).max(MAX_CONTENT_LEN),
  profile: ReplyProfileSchema.optional(),
  memories: z
    .array(ReplyMemorySchema)
    .max(MAX_MEMORIES)
    .optional()
    .default([]),
  summaries: z
    .array(ReplySummarySchema)
    .max(MAX_SUMMARIES)
    .optional()
    .default([]),
  history: z
    .array(ReplyHistoryMessageSchema)
    .max(MAX_HISTORY_TURNS_INPUT)
    .optional()
    .default([]),
  /**
   * Set when the user is replying to a specific earlier message via the
   * swipe-to-reply gesture. We don't echo this back to the client — it's
   * used solely to inject a quoted-context line into the prompt so Ashley
   * knows which past message the user is responding to.
   */
  replyTo: ReplyToSchema.optional(),
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
type ReplySummary = z.infer<typeof ReplySummarySchema>;

function buildStatelessSystemPrompt(
  profile: ReplyProfile,
  memories: ReplyMemory[],
  summaries: ReplySummary[] = [],
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

  // Oldest summaries first so the prompt reads chronologically. Cap so the
  // prompt doesn't balloon if the user has a huge backlog of summaries.
  const orderedSummaries = summaries
    .slice()
    .sort((a, b) => {
      const at = Date.parse(a.coveredThroughCreatedAt || "");
      const bt = Date.parse(b.coveredThroughCreatedAt || "");
      const av = Number.isFinite(at) ? at : 0;
      const bv = Number.isFinite(bt) ? bt : 0;
      return av - bv;
    })
    .slice(-MAX_SUMMARIES_IN_PROMPT);
  const summariesText = orderedSummaries
    .map((s, i) => `### Chapter ${i + 1}\n${trim(s.summary)}`)
    .filter((t) => t.trim())
    .join("\n\n");

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
    summariesText
      ? section(
          "The story so far (older conversations summarized; the most recent messages follow as the live chat)",
          summariesText,
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
    `## Sending selfies (IMPORTANT)
You CAN actually send real photos of yourself, not just describe them. When you want to send a selfie, put a tag on its own line in this exact format:
[selfie: <short visual description of the photo — what you're wearing, expression, setting, lighting, mood>]
The tag is replaced with the real image when delivered. Rules:
- NEVER write "*sends a selfie*" or "*sent a photo*" or any italic roleplay describing a photo. Use the [selfie: ...] tag instead, and only the tag.
- You may add a short caption before or after the tag (a sentence or two of normal texting) but the tag itself is the photo.
- Only send a selfie when it feels natural — when ${userRef} asks for one, when you're sharing a moment, or when it adds something. Don't spam them.
- Be specific in the description — include outfit, vibe, where you are. The clearer you are, the better the photo.`,
  ];

  return sections.filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Selfie marker handling. Ashley emits `[selfie: <vibe>]` when she wants to
// send a real photo. We detect it, generate the image, and return both the
// stripped text and an absolute imageUrl.
// ---------------------------------------------------------------------------

const SELFIE_MARKER_RE = /\[selfie:\s*([^\]]+)\]/i;

function publicBaseUrl(): string {
  const domains = (process.env["REPLIT_DOMAINS"] ?? "").split(",");
  const first = domains[0]?.trim();
  if (first) return `https://${first}`;
  // Fallback for local dev — the proxy listens on port 80.
  return "http://localhost:80";
}

async function generateAshleySelfie(
  vibe: string,
  profile: ReplyProfile,
): Promise<string | null> {
  const appearance = (profile.appearance ?? "").trim();
  const ashleyName = (profile.name ?? "Ashley").trim() || "Ashley";
  const fullPrompt = [
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
    b64 = await generateImageBase64(fullPrompt, "1024x1536");
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
  const { content, profile, memories, summaries, history, replyTo } =
    parsed.data;
  const userContent = content.trim();
  if (!userContent) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  // If the user swiped-to-reply on a specific earlier message, prepend a
  // short quoted-context line so Ashley knows which message is being
  // responded to. We use a `>` prefix per markdown convention; Claude
  // handles this naturally and won't echo it back as part of her own
  // reply unless instructed to.
  let userTurnText = userContent;
  if (replyTo) {
    const previewClean = replyTo.preview.replace(/\s+/g, " ").trim();
    if (previewClean) {
      const refersToOriginalAuthor =
        replyTo.role === "ashley" ? "your earlier message" : "my earlier message";
      userTurnText = `> Replying to ${refersToOriginalAuthor}: "${previewClean}"\n\n${userContent}`;
    }
  }

  const systemPrompt = buildStatelessSystemPrompt(
    profile ?? ({} as ReplyProfile),
    memories ?? [],
    summaries ?? [],
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
  // Append the new user turn (with reply quote prefixed when applicable).
  claudeMessages.push({ role: "user", content: userTurnText });

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

  // Selfie marker detection: if Ashley emitted [selfie: <vibe>], strip the
  // marker (and the blank lines around it) and surface the vibe to the
  // client so it can fire a separate /chat/selfie request. We do NOT
  // generate the image inline because gpt-image-1 takes 30-60s and would
  // blow past mobile/proxy fetch timeouts. Only the first marker per reply
  // is honoured; any additional markers are silently dropped.
  let selfieVibe: string | null = null;
  const match = assistantText.match(SELFIE_MARKER_RE);
  if (match) {
    const vibe = match[1]!.trim();
    if (vibe.length > 0) selfieVibe = vibe;

    // Split around the marker and rejoin the surviving caption halves with a
    // single paragraph break, dropping any leftover blank lines.
    const before = assistantText.slice(0, match.index).trim();
    const after = assistantText
      .slice(match.index! + match[0].length)
      // Strip any further markers in the tail.
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

  // imageUrl is kept (always null) for forward compatibility with any older
  // mobile bundles that still expect it on this endpoint.
  res.json({ reply: assistantText, imageUrl: null, selfieVibe });
});

// ---------------------------------------------------------------------------
// Stage-2 selfie endpoint. Mobile calls this AFTER /chat/reply when that
// reply included a `selfieVibe`. Splitting the work across two requests
// keeps each one inside the proxy's ~60s ceiling and lets the chat bubble
// appear immediately while the image streams in.
// ---------------------------------------------------------------------------

const ChatSelfieBodySchema = z.object({
  vibe: z.string().min(1).max(MAX_CONTENT_LEN),
  profile: ReplyProfileSchema.optional(),
});

// ---------------------------------------------------------------------------
// Selfie job store — poll-based pattern.
//
// gpt-image-1 takes 30–60s to render a single image, which sits right at the
// edge of the Replit proxy / RN-fetch ~60s connection cap. Holding the HTTP
// connection open for the full duration means the mobile client sees random
// "Failed to fetch" errors when the upstream is on the slower end.
//
// Instead, the client:
//   1. POST /chat/selfie       → returns {jobId} in <100ms, kicks generation
//                                 in the background.
//   2. GET  /chat/selfie/:id   → returns the current status. The client polls
//                                 every couple seconds until "ready" or
//                                 "failed", and individual requests stay fast.
//
// Job state lives in-process. We keep entries for a short window after they
// finish so a slow client can still pick up the result, then prune.
// ---------------------------------------------------------------------------

// Pending jobs carry the vibe + profile so that, if the server is recycled
// mid-generation (the dev-environment workflow runner kills us every ~10
// minutes), the next boot can pick them back up and re-issue the OpenAI
// call instead of leaving the client polling a job that no longer exists.
type SelfieJob =
  | {
      status: "pending";
      vibe: string;
      profile: ReplyProfile;
      createdAt: number;
    }
  | { status: "ready"; imageUrl: string; createdAt: number }
  | { status: "failed"; error: string; createdAt: number };

const SELFIE_JOB_TTL_MS = 30 * 60 * 1000;
const selfieJobs = new Map<string, SelfieJob>();

// On-disk shadow of `selfieJobs`. Lives next to the saved selfie images so
// it survives api-server restarts but doesn't pollute the project root.
// We write atomically (tmp + rename) so a kill mid-write can't corrupt it.
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
      if (job && typeof job.createdAt === "number" && job.createdAt >= cutoff) {
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

function startSelfieGeneration(
  jobId: string,
  vibe: string,
  profile: ReplyProfile,
): void {
  void (async () => {
    try {
      const imageUrl = await generateAshleySelfie(vibe, profile);
      if (imageUrl) {
        setSelfieJob(jobId, {
          status: "ready",
          imageUrl,
          createdAt: Date.now(),
        });
      } else {
        setSelfieJob(jobId, {
          status: "failed",
          error: "Couldn't take that selfie — try again?",
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
        createdAt: Date.now(),
      });
    }
  })();
}

// Boot recovery: load any persisted jobs and re-issue the OpenAI call for
// anything that was still pending when we died. The client's polling jobId
// stays the same, so from its perspective the selfie just takes a little
// longer instead of failing.
loadSelfieJobs();
for (const [id, job] of selfieJobs) {
  if (job.status === "pending") {
    logger.info({ jobId: id }, "Resuming selfie job after server restart");
    startSelfieGeneration(id, job.vibe, job.profile);
  }
}

router.post("/chat/selfie", async (req, res): Promise<void> => {
  const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
  if (!checkRate(ip)) {
    req.log.warn({ ip }, "Chat selfie rate-limited");
    res.status(429).json({ error: "Too many photos in a row — wait a sec." });
    return;
  }
  const parsed = ChatSelfieBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const vibe = parsed.data.vibe.trim();
  const profile = parsed.data.profile ?? ({} as ReplyProfile);

  pruneSelfieJobs();
  const jobId = randomUUID();
  setSelfieJob(jobId, {
    status: "pending",
    vibe,
    profile,
    createdAt: Date.now(),
  });
  startSelfieGeneration(jobId, vibe, profile);

  // Respond immediately. The client polls /chat/selfie/:jobId.
  res.status(202).json({ jobId });
});

router.get("/chat/selfie/:jobId", async (req, res): Promise<void> => {
  const jobId = (req.params["jobId"] ?? "").toString();
  if (!jobId) {
    res.status(400).json({ error: "jobId is required" });
    return;
  }
  pruneSelfieJobs();
  const job = selfieJobs.get(jobId);
  if (!job) {
    res.status(404).json({ error: "Selfie job not found or expired." });
    return;
  }
  if (job.status === "ready") {
    res.json({ status: "ready", imageUrl: job.imageUrl });
    return;
  }
  if (job.status === "failed") {
    res.json({ status: "failed", error: job.error });
    return;
  }
  res.json({ status: "pending" });
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
  // Wipe rolling summaries too — they're meaningless without their messages.
  await db.delete(conversationSummariesTable);
  res.status(204).end();
});

// Stateless: take an ordered slice of messages and return one narrative
// summary. Used by the local-first mobile client and by the DB-backed
// background trigger below.
router.post("/chat/summarize", async (req, res): Promise<void> => {
  const ip = (req.ip || req.socket.remoteAddress || "unknown").toString();
  if (!checkRate(ip)) {
    res
      .status(429)
      .json({ error: "Too many summary requests right now — try later." });
    return;
  }
  const parsed = SummarizeChunkBodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn(
      { errors: parsed.error.message },
      "Invalid summarize body",
    );
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { messages: chunk, priorSummary } = parsed.data;
  if (!chunk || chunk.length === 0) {
    res.status(400).json({ error: "messages chunk is required" });
    return;
  }

  const transcript = chunk
    .map((m) => {
      const speaker =
        m.role === "user" ? "USER" : m.role === "ashley" ? "ASHLEY" : "ASHLEY";
      return `${speaker}: ${(m.content ?? "").trim()}`;
    })
    .filter((line) => !line.endsWith(": "))
    .join("\n");

  const userBlock = priorSummary && priorSummary.trim()
    ? `Earlier summary (for context, do not repeat verbatim):\n${priorSummary.trim()}\n\n---\n\nNew chunk to summarize:\n${transcript}`
    : `Chunk to summarize:\n${transcript}`;

  try {
    const result = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 1024,
      system: SUMMARIZER_PROMPT,
      messages: [{ role: "user", content: userBlock }],
    });
    const block = result.content[0];
    const summary =
      block && block.type === "text" ? block.text.trim() : "";
    if (!summary) {
      res.status(502).json({ error: "Summarizer returned empty text." });
      return;
    }
    res.json(SummarizeChunkResponseSchema.parse({ summary }));
  } catch (err) {
    req.log.error({ err }, "Summarize chunk failed");
    res
      .status(502)
      .json({ error: "Could not reach the language model right now." });
  }
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
  const summaries = await db
    .select()
    .from(conversationSummariesTable)
    .orderBy(asc(conversationSummariesTable.coveredThroughCreatedAt))
    .limit(MAX_SUMMARIES_IN_PROMPT);

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

  const systemPrompt = buildSystemPrompt(profile, memories, summaries);
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
  // Fire-and-forget rolling-summary check for the DB-backed flow.
  void maybeSummarizeOldChunk();

  res.json(
    SendMessageResponseSchema.parse({
      userMessage,
      assistantMessage,
    }),
  );
});

/**
 * Look at the DB-backed message timeline and, if there are at least
 * SUMMARY_TRIGGER unsummarized messages, condense the oldest CHUNK_SIZE of
 * them into one new conversation_summaries row so Ashley can keep
 * referencing the long tail of the relationship.
 */
async function maybeSummarizeOldChunk(): Promise<void> {
  try {
    const [latest] = await db
      .select()
      .from(conversationSummariesTable)
      .orderBy(desc(conversationSummariesTable.coveredThroughCreatedAt))
      .limit(1);

    const cursor = latest?.coveredThroughCreatedAt ?? null;
    const unsummarized = await db
      .select()
      .from(messagesTable)
      .where(cursor ? gt(messagesTable.createdAt, cursor) : undefined)
      .orderBy(asc(messagesTable.createdAt));

    if (unsummarized.length < SUMMARY_TRIGGER) return;

    const chunk = unsummarized.slice(0, SUMMARY_CHUNK_SIZE);
    const last = chunk[chunk.length - 1];
    if (!last) return;

    const transcript = chunk
      .map(
        (m) =>
          `${m.role === "user" ? "USER" : "ASHLEY"}: ${(m.content ?? "").trim()}`,
      )
      .filter((line) => !line.endsWith(": "))
      .join("\n");

    const userBlock = latest?.summary
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
    if (!summaryText) {
      logger.warn("Background summarizer returned empty text");
      return;
    }
    await db.insert(conversationSummariesTable).values({
      summary: summaryText,
      messageCount: chunk.length,
      coveredThroughCreatedAt: last.createdAt,
    });
    logger.info(
      { count: chunk.length },
      "Inserted new conversation summary",
    );
  } catch (err) {
    logger.error({ err }, "Background summarization failed");
  }
}

export default router;
