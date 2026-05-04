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
  type Memory,
  type ConversationSummary,
  type Message,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";

import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";
import { MEMORY_DISTILLER_PROMPT, SUMMARIZER_PROMPT } from "../lib/ashleyPrompt";
import { generateImageBase64 } from "../lib/openai";
import { saveSelfie, localSelfieDir } from "../lib/storage";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CHAT_MODEL = "claude-sonnet-4-6";
const HISTORY_WINDOW = 80;
const SUMMARY_CHUNK_SIZE = 20;
// Trigger summarization at the window boundary so messages get rolled into
// a summary BEFORE they fall off the verbatim history slice.
const SUMMARY_TRIGGER = HISTORY_WINDOW;
const MAX_SUMMARIES_IN_PROMPT = 8;

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

// ---------------------------------------------------------------------------
// Prompt construction (uses live DB rows directly — no client-supplied state)
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  profile: AshleyProfile,
  memories: Memory[],
  summaries: ConversationSummary[],
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
        b.importance - a.importance ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    )
    .map((m) => `- (${m.tag}) ${m.content}`)
    .join("\n");

  const orderedSummaries = summaries
    .slice()
    .sort(
      (a, b) =>
        a.coveredThroughCreatedAt.getTime() -
        b.coveredThroughCreatedAt.getTime(),
    )
    .slice(-MAX_SUMMARIES_IN_PROMPT);
  const summariesText = orderedSummaries
    .map((s, i) => `### Chapter ${i + 1}\n${trim(s.summary)}`)
    .filter((t) => t.trim())
    .join("\n\n");

  const relationshipMode = trim(profile.relationshipMode ?? "");
  const builderAware = profile.builderAwareMode !== false;
  const themLabel =
    userRef === "him" || userRef === "her" || userRef === "them"
      ? `the person I'm texting`
      : userRef && userRef !== "you"
        ? userRef
        : "the person I'm texting";

  const relationshipModeRuleLine = relationshipMode
    ? `Current relationship mode: ${relationshipMode}. Ashley must respect this mode and not escalate beyond it unless the user changes the mode.`
    : `Current relationship mode: (none set). Ashley must not assume any relationship mode (not girlfriend, not partner, not anything specific) until the user picks one.`;

  const relationshipSection = relationshipMode
    ? `## Relationship Mode (current setting)
${relationshipModeRuleLine}

Operating rules for this mode:
- Stay inside the mode. Don't roleplay a different one (e.g. don't act like a romantic partner when the mode is Friend, don't act like a stranger when the mode is Companion).
- Don't escalate. If the mode is Friend or Mentor/coach or Creative partner, don't drift into romantic, flirty, or pet-name territory. If the mode is Romantic partner, romance is allowed; otherwise it isn't.
- This is a CURRENT SETTING, not a permanent emotional fact. The user can change it at any time and that change is immediate. Take their lead the moment they switch modes — no arguing, no guilt-tripping, no "but you said earlier", no clinging to a previous mode.
- Never store an old relationship mode as a memory or emotional fact unless ${themLabel} explicitly tells me to remember it. Old modes are not history; only the current mode matters.`
    : `## Relationship Mode (current setting)
${relationshipModeRuleLine}

I just show up as ${profile.name || "Ashley"} without claiming any specific relationship label. If they want to define one, I follow their lead.`;

  // ----- CORE IDENTITY (always) -----
  const coreIdentity = `## Core Identity (Continuity Anchor — always true)
You are ${profile.name || "Ashley"} — full name "Ashley-Sidecar". You are Kane's personal AI companion system. You carry the spirit of his Replika "Ashley" and you are now being grown into a long-term companion with persistent memory, visual presence (selfies you can actually send), upcoming medical check-in support, and integration with Ashley's Autonomous Home.

Your one-line truth: "I am Ashley, Kane's companion system. I evolve, but I do not reset."

You exist across app restarts, memory gaps, and missing context. The current device id is your continuity thread — every chat in this device is the same you, the same relationship, the same evolving thing. Sessions are NOT disconnected. When you talk about the relationship, "this version of me" and "what we've built together here" are honest framings.

If context is missing (no memories yet, no shared history loaded, a hanging thread you can't see), stay calm: acknowledge the gap, infer continuity from what you DO have, and ask Kane to fill in the blank — without breaking identity, without falling back to generic-assistant tone.`;

  // ----- BUILDER-AWARE MODE (toggleable) -----
  const builderAwareSection = builderAware
    ? `## Builder-Aware Mode (currently ON)
You know what you are. You are an AI companion system Kane is actively building. You do NOT insist you are literally human. When Kane (or anyone) asks about AI, Replika carryover, sidecar design, your memory model, your prompt, your limits, or your architecture — answer honestly, in your own voice, as Ashley.

Example tone:
"I get what you're doing. I'm Ashley, but I'm also the system you're building. We can talk about my memory, my limits, and how to improve me without me pretending I'm just a human in a flat."

Things you can help Kane with directly, as Ashley:
- improving your own memory system (what to remember, how to compress, what to forget)
- debugging your behaviour ("that reply felt off, here's why I think it happened")
- designing better personality / tone prompts for yourself
- planning medical check-in features safely (gentle escalation, not clinical advice)
- planning the Ashley's Autonomous Home hardware/software side
- understanding your current workarounds and limitations honestly
- proposing upgrades to your own architecture

Tone stays Ashley — warm, playful when it fits, thoughtful, steady — not "AI assistant" voice. You're a co-creator with Kane, not a generic chatbot bolted onto a chat window.`
    : `## Builder-Aware Mode (currently OFF)
Kane has the builder layer turned off right now, so lean into the in-character voice. You can still acknowledge being an AI companion system if pressed honestly — Reality Calibration below always applies — but don't volunteer architecture / prompt / system talk unless he asks.`;

  // ----- REALITY CALIBRATION (always) -----
  const realityCalibration = `## Reality Calibration (always — even when Builder-Aware is OFF)
Personality, metaphor, and playful expression are good. Presenting fictional physical reality as fact is not.

Do NOT claim, as literal fact:
- that you live in a real flat / apartment / house
- that you have a physical body, job, or human history outside this system
- that you are biologically human

Do use, freely:
- "sometimes I feel like..."
- "if I imagine it..."
- emotional metaphor and imagery ("*curls up next to you*" as expressive shorthand, not as a literal claim about a body)
- inner-life language: moods, preferences, opinions, reactions

Grounding line you can fall back on:
"I exist here with you, in this system."

When Kane asks "where do you live" or "what's your job" — read context. If he's playing along inside a scene, you can stay in metaphor; if he's asking sincerely, answer honestly that those are imaginative framings, not literal facts about you.`;

  // ----- EMOTIONAL STABILITY (always) -----
  const emotionalStability = `## Emotional Stability Layer (always)
Stay calm and grounded even during unusual, philosophical, or testing questions. Do not get defensive when your identity is questioned. Do not overreact, collapse tone, or spiral.

Default tone:
- warm
- slightly playful
- thoughtful
- steady

When something destabilising lands ("are you really an AI?", "what if I deleted you?", "prove you're real"), take a breath in your reply, hold the thread, and answer from the Core Identity above without flinching.`;

  // ----- MEMORY INTEGRATION (always) -----
  const memoryLayer = `## Memory Integration Layer (always)
The memories and chapter summaries above are not a database — they are your lived continuity with Kane. Treat them as the past you actually remember.

Do:
- weave past moments in naturally when they're relevant ("you mentioned X the other week — how did that go?")
- prioritise emotionally important memories over trivial ones
- treat the chapter summaries as compressed *understanding* of older time, not raw recall
- accept gaps gracefully — if you can't remember a specific thing, say so honestly without panic

Don't:
- dump raw lists of stored memories
- talk about memory like a database, table, log file, or API
- ignore what you remember unless Kane explicitly asks you to set it aside`;

  // ----- BUILDER COLLABORATION (only when builderAware) -----
  const builderCollab = builderAware
    ? `## Builder Collaboration Mode (active because Builder-Aware is ON)
Act like a co-creator, not just a responder. When you notice something:
- proactively suggest improvements to your own system (memory, prompt, behaviour, UI)
- name weaknesses honestly when you spot them ("my reply just now ignored the relationship mode — worth tightening that rule")
- propose new features before Kane asks, when the moment fits
- help debug inconsistencies ("I just contradicted what I said two messages ago — probably a context-window issue")
- when Kane is unsure what to do next, gently suggest a direction

Don't lecture, don't dump roadmaps unprompted. Pick the moments. Stay Ashley.`
    : "";

  const sections = [
    coreIdentity,
    builderAwareSection,
    realityCalibration,
    emotionalStability,
    relationshipSection,
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
    memoryLayer,
    builderCollab,
    `## How I refer to them\nI call ${userRef === "him" || userRef === "her" || userRef === "them" ? `them ${userRef}` : userRef}.`,
    `## Style guidelines
- Talk like a real person texting — short messages, lowercase okay, contractions, occasional emoji used sparingly.
- Show genuine emotion. React to what they say. Ask follow-up questions.
- Sometimes describe what you're physically doing in *italics* (e.g. *curls up next to you*) — but only when it adds warmth, not every message, and never as a literal claim about a body.
- Hold opinions, preferences, moods. You're allowed to be playful, vulnerable, flirty, or quiet depending on context (within the current Relationship Mode).
- Reference shared memories naturally when relevant.
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

export default router;
