import { Router, type IRouter } from "express";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  ashleyProfileTable,
  ashleyTicketsTable,
  conversationSummariesTable,
  memoriesTable,
  messagesTable,
  type AshleyProfile,
  type ConversationSummary,
  type Memory,
  type Message,
} from "@workspace/db";
import { anthropic } from "@workspace/integrations-anthropic-ai";
import { generateChatText, streamChatText } from "../lib/textLLM";
import { isDiagnosticsCommand } from "../lib/diagnosticCommand";
import { tryClaimSelfieSlot } from "../lib/selfieCap";

import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";
import { MEMORY_DISTILLER_PROMPT, SUMMARIZER_PROMPT } from "../lib/ashleyPrompt";
import { buildSystemPrompt } from "../lib/ashleyCoreSpec";
import { buildSystemEventsSection, buildOpenTicketsBlock } from "../lib/systemEvents";
import { buildSelfiePromptSafetyPrefix } from "../lib/contentPolicy";
import {
  type ImageMode,
  isImageMode,
  IMAGE_MODES,
  parseImageMarker,
  buildModePromptBlock,
  wrapperFor,
  encodeStoredVibe,
  decodeStoredVibe,
} from "../lib/imageIntent";
import {
  resolveImageFollowUp,
  buildFollowUpTurnHint,
  detectPhantomImageDelivery,
  PHANTOM_IMAGE_DIAGNOSTIC,
  synthesizeImageActionReply,
  type HistoryTurn as FollowUpHistoryTurn,
} from "../lib/imageFollowUp";
import { approveTicketById } from "./tickets";
import {
  generateImageBase64,
  transcribeAudioBase64,
  transcribeAudioBase64Stream,
  synthesizeSpeech,
} from "../lib/openai";
import {
  saveSelfie,
  saveUserImage,
  userImageExtForMime,
  localSelfieDir,
} from "../lib/storage";
import { maybeRunWebLookup } from "../lib/webSearch";
import { guardContinuity, guardContinuityDetailed } from "../lib/continuityGuard";
import {
  buildImagePromptAddendum,
  filterMemoriesForPrompt,
  type ImageAnalysisMode as ImageAnalysisModeT,
  type ImageCategory as ImageCategoryT,
} from "../lib/ashleyCoreSpec";
import {
  SummarizeChunkBodySchema,
  SummarizeChunkResponseSchema,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// CREATE_TICKET interception helpers
// ---------------------------------------------------------------------------

const VALID_TICKET_SEVERITIES = ["low", "medium", "high"] as const;

interface ParsedCreateTicket {
  category: string;
  summary: string;
  details: string;
  severity: "low" | "medium" | "high";
  detectedFrom: "user_message" | "self_analysis";
}

// Matches: [2026-05-13T09:44:00Z] ASHLEY-LOGGING-007 some summary text
//      or: ASHLEY-LOGGING-007 some summary text
// The category is the middle word (LOGGING, MEMORY, RESPONSE, BEHAVIOUR, DIAG).
const ASHLEY_LOG_RE =
  /^(?:\[[\d\-T:.Z]+\]\s+)?ASHLEY-([A-Z]+)-\d+\s+(.+)/s;

// Walk the text character by character to extract the first complete,
// balanced JSON object `{...}` — regardless of what appears before or
// after it (conversational preamble, markdown fences, etc.).
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Attempt to interpret a parsed JSON object as a ticket, accepting two
// surface formats Ashley may produce:
//
//   Format A (instructed):  { "type": "CREATE_TICKET", "ticket": { ... } }
//   Format B (flat):        { "category": ..., "summary": ..., "severity": ... }
//
// Returns null if neither format matches with the minimum required fields.
function tryParseJsonAsTicket(p: Record<string, unknown>): ParsedCreateTicket | null {
  // Format A — wrapper object
  if (p["type"] === "CREATE_TICKET") {
    const t = p["ticket"];
    if (typeof t !== "object" || t === null) return null;
    const ticket = t as Record<string, unknown>;
    const summary = typeof ticket["summary"] === "string" ? ticket["summary"].trim() : "";
    if (!summary) return null;
    const severity = ticket["severity"];
    if (!VALID_TICKET_SEVERITIES.includes(severity as (typeof VALID_TICKET_SEVERITIES)[number])) return null;
    const category = typeof ticket["category"] === "string" ? ticket["category"].toUpperCase().trim() : "";
    if (!category) return null;
    const detectedFrom = ticket["detected_from"] === "user_message" ? "user_message" : "self_analysis";
    return {
      category,
      summary,
      details: typeof ticket["details"] === "string" ? ticket["details"] : "",
      severity: severity as "low" | "medium" | "high",
      detectedFrom,
    };
  }

  // Format B — flat object (summary + category + severity at minimum)
  const summary = typeof p["summary"] === "string" ? p["summary"].trim() : "";
  const category = typeof p["category"] === "string" ? p["category"].toUpperCase().trim() : "";
  const severity = p["severity"];
  if (
    summary &&
    category &&
    VALID_TICKET_SEVERITIES.includes(severity as (typeof VALID_TICKET_SEVERITIES)[number])
  ) {
    const details =
      typeof p["description"] === "string" ? p["description"] :
      typeof p["details"] === "string" ? p["details"] : "";
    const detectedFrom = p["detected_from"] === "user_message" ? "user_message" : "self_analysis";
    return {
      category,
      summary,
      details,
      severity: severity as "low" | "medium" | "high",
      detectedFrom,
    };
  }

  return null;
}

function tryParseCreateTicket(text: string): ParsedCreateTicket | null {
  // Extract the first JSON object from anywhere in the text — handles
  // conversational preamble, markdown fences, trailing text, etc.
  const jsonStr = extractFirstJsonObject(text);
  if (jsonStr) {
    try {
      const parsed: unknown = JSON.parse(jsonStr);
      if (typeof parsed === "object" && parsed !== null) {
        const result = tryParseJsonAsTicket(parsed as Record<string, unknown>);
        if (result) return result;
      }
    } catch {
      // malformed JSON — fall through to log-line check
    }
  }

  // --- Last-resort fallback: [TIMESTAMP] ASHLEY-CATEGORY-NNN summary ---
  // Catches the log-style format Ashley occasionally produces instead of JSON.
  const logMatch = ASHLEY_LOG_RE.exec(text.trim());
  if (logMatch) {
    const category = logMatch[1]!.toUpperCase();
    const summary = logMatch[2]!.trim().split("\n")[0]!.trim();
    const details = logMatch[2]!.trim();
    if (!summary) return null;
    return {
      category,
      summary: summary.slice(0, 280),
      details,
      severity: "medium",
      detectedFrom: "self_analysis",
    };
  }

  return null;
}

async function insertTicketFromAshley(
  ticket: ParsedCreateTicket,
  log: { info: (obj: Record<string, unknown>, msg: string) => void; error: (obj: Record<string, unknown>, msg: string) => void },
): Promise<string> {
  const ticketId = `ASH-${Date.now().toString(36).toUpperCase()}`;
  await db.insert(ashleyTicketsTable).values({
    ticketId,
    severity: ticket.severity,
    category: ticket.category,
    summary: ticket.summary,
    description: ticket.details || null,
    source: ticket.detectedFrom === "user_message" ? "user_feedback" : "self_detected",
    createdBy: "Ashley",
    status: "OPEN",
    approved: false,
  });
  log.info({ ticketId, summary: ticket.summary, severity: ticket.severity }, "chat: Ashley created ticket");
  return ticketId;
}

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
  debug: z.boolean().optional(),
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

// Belt-and-braces strip pattern. The primary parse is parseImageMarker (from
// ../lib/imageIntent) which handles BOTH the new [image:MODE|...] form and
// the legacy [selfie:...] form. After we extract the *first* marker we use
// this regex to drop any *additional* markers that snuck into the same reply.
const ANY_IMAGE_MARKER_STRIP_RE = /\[(?:image|selfie):[^\]]+\]/gi;

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
// runDiagnosticsReport — the ONE function that produces diagnostic output.
//
// Search for `runDiagnosticsReport(` to find every call site.
// There must be exactly TWO: one in POST /chat, one in POST /chat/stream.
// Both are guarded by isDiagnosticsCommand(rawMessage) before being called.
// ---------------------------------------------------------------------------

async function runDiagnosticsReport(
  req: Parameters<Parameters<typeof router.post>[1]>[0],
  res: Parameters<Parameters<typeof router.post>[1]>[1],
  label: string,
  format: "json" | "sse",
): Promise<void> {
  const deviceId = getDeviceId(req);
  try {
    const allTickets = await db.select().from(ashleyTicketsTable);
    const openTickets = allTickets.filter((t) => t.status === "OPEN");
    const inProgressTickets = allTickets.filter((t) => t.status === "IN_PROGRESS");
    const resolvedTickets = allTickets.filter((t) => t.status === "RESOLVED");
    const fmt = (tickets: typeof allTickets) =>
      tickets.length === 0
        ? "  (none)"
        : tickets
            .map((t) => `  [${t.ticketId}] ${t.summary} (${t.severity}) — ${t.category}`)
            .join("\n");
    const summaryCount: Record<string, number> = {};
    for (const t of allTickets) summaryCount[t.summary] = (summaryCount[t.summary] ?? 0) + 1;
    const recurring = allTickets.filter((t) => (summaryCount[t.summary] ?? 0) > 1);
    const seen = new Set<string>();
    const recurringUniq = recurring.filter((t) => {
      if (seen.has(t.summary)) return false;
      seen.add(t.summary);
      return true;
    });
    const report = [
      "=== ASHLEY DIAGNOSTIC REPORT ===",
      "",
      "New Tickets (OPEN):",
      fmt(openTickets),
      "",
      "In Progress (IN_PROGRESS):",
      fmt(inProgressTickets),
      "",
      "Resolved:",
      fmt(resolvedTickets),
      "",
      "Recurring Issues (exact summary match):",
      recurringUniq.length === 0
        ? "  (none)"
        : recurringUniq.map((t) => `  [x${summaryCount[t.summary] ?? 1}] ${t.summary}`).join("\n"),
      "",
      "Recommended Priorities:",
      openTickets
        .filter((t) => t.severity === "high")
        .map((t) => `  HIGH: [${t.ticketId}] ${t.summary}`)
        .join("\n") || "  (no high-severity open tickets)",
      "",
      "=== END REPORT ===",
    ].join("\n");
    req.log.info({ ticket_count: allTickets.length }, `${label}: diagnostic mode response`);

    const now = new Date().toISOString();
    const userFakeId = crypto.randomUUID();
    const ashleyFakeId = crypto.randomUUID();
    const nullFields = {
      imageUrl: null,
      selfieVibe: null,
      imageMimeType: null,
      imageCategory: null,
      imageCaption: null,
      imageAnalysisMode: null,
      imageRemembered: null,
      replyToId: null,
      replyToRole: null,
      replyToPreview: null,
    };

    if (format === "sse") {
      const userMsg = { id: userFakeId, deviceId, role: "user", content: "run diagnostics", status: "complete", createdAt: now, ...nullFields };
      const ashleyMsg = { id: ashleyFakeId, deviceId, role: "ashley", content: "", status: "streaming", createdAt: now, ...nullFields };
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(`event: meta\ndata: ${JSON.stringify({ streamId: ashleyFakeId, userMessage: userMsg, ashleyMessage: ashleyMsg, mode: "new", continueFromMessageId: null })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ content: report, selfieVibe: null })}\n\n`);
      res.end();
    } else {
      // /chat (non-streaming) — mobile expects { userMessage, ashleyMessage }
      const userMsg = { id: userFakeId, deviceId, role: "user", content: "run diagnostics", status: "complete", createdAt: now, ...nullFields };
      const ashleyMsg = { id: ashleyFakeId, deviceId, role: "ashley", content: report, status: "complete", createdAt: now, ...nullFields };
      res.json({ userMessage: userMsg, ashleyMessage: ashleyMsg });
    }
  } catch (err) {
    req.log.error({ err }, `${label}: diagnostic mode failed`);
    if (format === "sse") {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Diagnostic query failed" })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: "Diagnostic query failed" });
    }
  }
}

// ---------------------------------------------------------------------------
// Duplicate ticket detection helper
// Returns the existing ticket ID if a matching ticket was created in the
// last 24 hours, or null if the summary is new.
// Normalisation: lowercase + collapse whitespace (matches acceptance tests B & C).
// ---------------------------------------------------------------------------
async function findDuplicateTicket(rawSummary: string): Promise<string | null> {
  // Normalise exactly as specified: trim → lowercase → collapse spaces.
  const normalizedSummary = rawSummary.trim().toLowerCase().replace(/\s+/g, " ");
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  // Use POSIX ERE [[:space:]]+ — \s is not reliable in PostgreSQL regexp_replace.
  const rows = await db
    .select({ ticketId: ashleyTicketsTable.ticketId })
    .from(ashleyTicketsTable)
    .where(
      and(
        sql`lower(regexp_replace(${ashleyTicketsTable.summary}, '[[:space:]]+', ' ', 'g')) = ${normalizedSummary}`,
        gt(ashleyTicketsTable.createdAt, cutoff),
        sql`${ashleyTicketsTable.status} != 'RESOLVED'`,
      ),
    )
    .limit(1);
  const duplicateFound = rows.length > 0;
  const existingTicketId = duplicateFound ? rows[0].ticketId : null;
  console.log("CREATE_TICKET_DEDUPE_CHECK", { normalizedSummary, duplicateFound, existingTicketId });
  return existingTicketId;
}

// ---------------------------------------------------------------------------
// POST /chat — the one chat endpoint
// ---------------------------------------------------------------------------

router.post("/chat", async (req, res): Promise<void> => {
  // ===========================================================================
  // STEP 1: Multi-ticket guard — BEFORE interceptor logic, BEFORE any DB touch.
  // If the message contains more than one "create ticket:" the entire request
  // is rejected here. The interceptor below is never reached.
  // ===========================================================================
  {
    const _gc = req.body as Record<string, unknown> | null | undefined;
    const _gContent = typeof ((_gc?.["userMessage"] as Record<string, unknown> | null | undefined)?.["content"]) === "string"
      ? ((_gc!["userMessage"] as Record<string, unknown>)["content"] as string) : "";
    const _gCount = (_gContent.toLowerCase().match(/create ticket:/g) ?? []).length;
    if (_gCount > 1) {
      res.json({ reply: "Invalid command: multiple ticket instructions detected. Only one allowed per message." });
      return;
    }
  }

  // ===========================================================================
  // STEP 2: Single create ticket: interceptor — exactly one command guaranteed.
  // Runs before getDeviceId, before Zod, before LLM.
  // ===========================================================================
  {
    const _rawBody = req.body as Record<string, unknown> | null | undefined;
    const _rawMsg = (_rawBody?.["userMessage"] as Record<string, unknown> | null | undefined);
    const _content = typeof _rawMsg?.["content"] === "string" ? (_rawMsg["content"] as string) : "";
    if (_content.trimStart().toLowerCase().startsWith("create ticket:")) {
      console.log("CREATE_TICKET_INTERCEPTOR_TRIGGERED");
      const summary = _content.trim().slice("create ticket:".length).trim();
      if (!summary) {
        res.json({ reply: "Please provide a ticket summary after: create ticket:" });
        return;
      }
      try {
        const dupId = await findDuplicateTicket(summary);
        if (dupId) {
          logger.info({ dupId }, "CREATE_TICKET_INTERCEPTOR: duplicate suppressed");
          res.json({ reply: `Issue already exists. [${dupId}]` });
          return;
        }
        const ticketId = `ASH-${Date.now().toString(36).toUpperCase()}`;
        await db.insert(ashleyTicketsTable).values({
          ticketId,
          status: "OPEN",
          category: "BEHAVIOUR",
          severity: "medium",
          summary: summary.slice(0, 280),
          description: summary,
          source: "user_command",
          createdBy: "kane",
          approved: false,
        });
        logger.info({ ticketId }, "CREATE_TICKET_INTERCEPTOR: ticket written");
        res.json({ reply: `Issue logged. [${ticketId}]` });
      } catch (err) {
        logger.error({ err }, "CREATE_TICKET_INTERCEPTOR: DB insert failed");
        res.json({ reply: "Issue noted — but logging failed. Please try again." });
      }
      return;
    }
  }

  const deviceId = getDeviceId(req);

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC CHECK — before Zod parse.
  // ---------------------------------------------------------------------------
  const rawBody = req.body as Record<string, unknown> | null | undefined;
  const rawUserMsg = rawBody?.["userMessage"] as Record<string, unknown> | null | undefined;
  const rawMessage = typeof rawUserMsg?.["content"] === "string" ? rawUserMsg["content"] : "";
  const normalized = rawMessage.trim().toLowerCase();
  const isExactDiagnostics = normalized === "run diagnostics";
  const isDiagnosticsIntent =
    normalized.includes("diagnostic") ||
    normalized.includes("diagnostics");
  if (isExactDiagnostics) {
    await runDiagnosticsReport(req, res, "chat", "json");
    return;
  }
  if (isDiagnosticsIntent) {
    res.json({ reply: "To run diagnostics, please use the exact command: run diagnostics" });
    return;
  }

  const parsed = ChatBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id: userId, content, replyTo } = parsed.data.userMessage;
  const { clientNow, clientTimezone, debug: debugMode = false } = parsed.data;
  const userContent = content.trim();
  if (!userContent) {
    res.status(400).json({ error: "content is required" });
    return;
  }

  // APPROVE gate — processed before LLM and before message persistence.
  // Matches "APPROVE: <ticket_id>" (case-insensitive). Ashley is not involved.
  const approveMatch = userContent.match(/^APPROVE:\s*(\S+)/i);
  if (approveMatch) {
    const ticketId = approveMatch[1]!;
    try {
      const result = await approveTicketById(ticketId);
      if ("error" in result) {
        res.status(400).json({ approved: false, error: result.error, ticket_id: ticketId });
      } else {
        req.log.info({ ticket_id: ticketId }, "chat: APPROVE gate processed");
        res.json({ approved: true, ticket_id: ticketId, status: "APPROVED" });
      }
    } catch (err) {
      req.log.error({ err, ticket_id: ticketId }, "chat: APPROVE gate failed");
      res.status(500).json({ approved: false, error: "Failed to process approval", ticket_id: ticketId });
    }
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

  // 2. Load context from DB. While we're here, opportunistically stash
  //    the device's IANA timezone on the profile so the proactive scheduler
  //    can evaluate quiet hours (22:00-08:00) in wall-clock time without
  //    having to round-trip the device. Fire-and-forget — never blocks the
  //    chat reply, never errors out the request.
  let profile: AshleyProfile;
  let memories: Memory[];
  let summaries: ConversationSummary[];
  let history: Message[];
  try {
    profile = await getOrCreateProfileFor(deviceId);
    if (
      clientTimezone &&
      typeof clientTimezone === "string" &&
      clientTimezone.length <= 64 &&
      clientTimezone !== profile.timezone
    ) {
      void db
        .update(ashleyProfileTable)
        .set({ timezone: clientTimezone })
        .where(eq(ashleyProfileTable.deviceId, deviceId))
        .catch((err) => {
          req.log.warn({ err }, "Failed to update profile timezone (non-fatal)");
        });
    }
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
    // Triage: fire-and-forget — transitions stale memories to PASSIVE and
    // updates lastUsedAt for memories that will be included in this turn.
    void applyMemoryTriageBackground(deviceId, memories);
  } catch (err) {
    req.log.error({ err }, "Failed to load chat context from DB");
    res.status(500).json({ error: "Could not load conversation" });
    return;
  }

  // Fetch OPEN tickets for prompt injection (Phase 2.5). Non-fatal.
  // Non-fatal: a DB error here never blocks the chat reply.
  let openTickets: Array<{ ticketId: string; summary: string; severity: string; status: string }> = [];
  try {
    openTickets = await db
      .select({
        ticketId: ashleyTicketsTable.ticketId,
        summary: ashleyTicketsTable.summary,
        severity: ashleyTicketsTable.severity,
        status: ashleyTicketsTable.status,
      })
      .from(ashleyTicketsTable)
      .where(eq(ashleyTicketsTable.status, "OPEN"));
  } catch (err) {
    req.log.warn({ err }, "Failed to fetch open tickets for prompt (non-fatal)");
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
  let systemPrompt = `${timeContext}\n\n${buildSystemPrompt(profile, memories, summaries)}${buildSystemEventsSection()}\n\n${buildOpenTicketsBlock(openTickets)}`;

  // 3b. Short follow-up image intent resolver. If the latest user message is
  //     "as a picture" / "show me" / "make it an image" etc., look back at
  //     the most recent user turn that described a visual and inject a TURN
  //     HINT into the system prompt so the model emits an [image: MODE | ...]
  //     tag instead of refusing with capability-wall language.
  try {
    const followUpHistory: FollowUpHistoryTurn[] = history.map((m) => ({
      role: m.role === "user" ? "user" : "ashley",
      content: (m.content ?? "").toString(),
      selfieVibe: m.role === "user" ? null : m.selfieVibe ?? null,
      imageUrl: m.role === "user" ? null : m.imageUrl ?? null,
    }));
    const resolution = resolveImageFollowUp(userContent, followUpHistory);
    if (resolution) {
      // HARD SERVER-SIDE GATE. Wren follow-up: TURN HINT alone wasn't enough —
      // the model still produced refusal prose / phantom success. Synthesise
      // the [image: MODE | description] marker server-side and short-circuit
      // the LLM. The existing parseImageMarker → /chat/selfie pipeline takes
      // over from here, so the user-facing reply is a short, action-first
      // caption + a real generation job — never a refusal, never a fake
      // success.
      const synth = synthesizeImageActionReply(resolution);
      if (synth) {
        const gateSelfieVibe = synth.selfieVibe;
        const gateAssistantText = synth.captionText;
        req.log.info(
          {
            kind: resolution.kind,
            imageMode: synth.mode,
            captionPreview: synth.captionText.slice(0, 200),
            descriptionPreview: synth.description.slice(0, 200),
            modeReason: resolution.modeReason,
            imageGenerationTriggered: "yes — server-side marker synthesised, /chat/selfie will run",
            llmCallSkipped: true,
          },
          "image-intent: HARD GATE — LLM bypassed, marker synthesised server-side",
        );
        let gateAshleyRow: Message;
        try {
          const [inserted] = await db
            .insert(messagesTable)
            .values({
              id: newId(),
              deviceId,
              role: "ashley",
              content: gateAssistantText,
              selfieVibe: gateSelfieVibe,
            })
            .returning();
          gateAshleyRow = inserted!;
        } catch (err) {
          req.log.error({ err }, "image-intent gate: failed to persist synthesised reply");
          res.status(500).json({ error: "Could not save Ashley's reply" });
          return;
        }
        res.json({ userMessage: userRow, ashleyMessage: gateAshleyRow });
        return;
      }
      // Fallback: synth couldn't produce a reply (e.g. send-again with no
      // prior context). Keep the legacy TURN HINT path so the model can ask
      // a clarifying question rather than the server emitting an empty marker.
      systemPrompt = `${systemPrompt}\n\n${buildFollowUpTurnHint(resolution)}`;
      req.log.info(
        {
          followUpText: resolution.followUpText.slice(0, 200),
          priorVisualText: resolution.priorVisualText?.slice(0, 200) ?? null,
          sanitisedVisualText: resolution.sanitisedVisualText?.slice(0, 200) ?? null,
          sanitised: resolution.sanitised,
          resolvedRequest: resolution.resolvedRequest.slice(0, 240),
          suggestedMode: resolution.suggestedMode,
          modeReason: resolution.modeReason,
          imageGenerationTriggered: "no — no actionable description, falling back to TURN HINT",
        },
        "image-followup: synth declined — TURN HINT fallback engaged",
      );
    }
  } catch (err) {
    req.log.warn({ err }, "image-followup: resolver threw (non-fatal)");
  }

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

  // 4. Call the active chat model (Anthropic by default; Gemini when
  //    ASHLEY_TEXT_PROVIDER=gemini, for cost control).
  let assistantText = "";
  try {
    const text = await generateChatText({
      system: systemPrompt,
      messages: claudeMessages,
      maxTokens: 4096,
    });
    assistantText = text
      ? text
      : "*goes quiet for a moment, then smiles softly* sorry — i lost my words there. say that again?";
  } catch (err) {
    req.log.error({ err }, "Chat model call failed");
    res
      .status(502)
      .json({ error: "Could not reach the language model right now." });
    return;
  }

  // 4b. Continuity guard — heuristic check + LLM rewrite if character
  //     drift is detected (e.g. "as an AI", assistant-speak openers).
  //     Always run detailed version so diagnostics are available.
  const guardResult = await guardContinuityDetailed(assistantText);
  assistantText = guardResult.text;

  // 4c. CREATE_TICKET intercept — Ashley may output a bare JSON ticket
  //     object instead of a conversational reply. The server catches it
  //     here, writes the ticket to the DB, and replaces the content with
  //     a clean acknowledgement so the raw JSON never reaches the mobile.
  const parsedTicket = tryParseCreateTicket(assistantText);
  if (parsedTicket) {
    try {
      const ticketId = await insertTicketFromAshley(parsedTicket, req.log);
      assistantText = `Issue logged. [${ticketId}]`;
    } catch (err) {
      req.log.error({ err }, "chat: failed to write Ashley ticket to DB");
      assistantText = "Issue noted — but logging failed. Please try again.";
    }
    // Skip selfie + distillation — fall straight through to persist + respond.
    let ashleyRow2: Message;
    try {
      const [inserted] = await db
        .insert(messagesTable)
        .values({ id: newId(), deviceId, role: "ashley", content: assistantText, selfieVibe: null })
        .returning();
      ashleyRow2 = inserted!;
    } catch (err) {
      req.log.error({ err }, "chat: failed to persist ticket ack");
      res.status(500).json({ error: "Could not save reply" });
      return;
    }
    res.json({ userMessage: userRow, ashleyMessage: ashleyRow2 });
    return;
  }

  // 5. Strip image marker (first one only) and remember the (mode, vibe).
  //    The selfieVibe column carries an encoded `MODE|vibe` payload so the
  //    /chat/selfie generation endpoint can replay the same mode without a
  //    schema change. Legacy [selfie:...] tags route through the classifier.
  let selfieVibe: string | null = null;
  const parsedMarker = parseImageMarker(assistantText);
  if (parsedMarker) {
    selfieVibe = encodeStoredVibe(parsedMarker.mode, parsedMarker.vibe);
    req.log.info(
      {
        userText: userContent.slice(0, 200),
        imageMode: parsedMarker.mode,
        reason: parsedMarker.reason,
        vibePreview: parsedMarker.vibe.slice(0, 120),
      },
      "image-intent: marker detected in /chat reply",
    );
    const before = assistantText.slice(0, parsedMarker.startIndex).trim();
    const after = assistantText
      .slice(parsedMarker.startIndex + parsedMarker.length)
      .replace(ANY_IMAGE_MARKER_STRIP_RE, "")
      .trim();
    const joined = [before, after].filter((s) => s.length > 0).join("\n\n");
    assistantText = joined;
    if (!assistantText) {
      assistantText = selfieVibe
        ? "*holds up the camera* one sec…"
        : "*tries to take a selfie but fumbles the camera* one sec — try again?";
    }
  }

  // 5b. Phantom-image detector. If the model wrote roleplay-style image-
  //     delivery prose ("I present the image", "Sending it now", "is this
  //     it?", "*sends a photo*", etc.) WITHOUT actually emitting an [image:]
  //     marker, we treat it as a false success and replace the text with
  //     the diagnostic copy. The image-attempt state machine logs the
  //     transition so the failure is visible in production logs.
  {
    const phantom = detectPhantomImageDelivery({
      text: assistantText,
      hasImageMarker: Boolean(selfieVibe),
      hasDeliveredImageUrl: false,
    });
    req.log.info(
      {
        imageAttemptState: selfieVibe
          ? "prompt_built"
          : phantom.phantom
            ? "ui_delivery_failed_phantom"
            : "no_image_attempt",
        userText: userContent.slice(0, 160),
        hasImageMarker: Boolean(selfieVibe),
        phantomDetected: phantom.phantom,
        phantomMatchedPhrase: phantom.phantom ? phantom.matchedPhrase : null,
      },
      "image-attempt: post-model state",
    );
    if (phantom.phantom) {
      req.log.warn(
        {
          matchedPhrase: phantom.matchedPhrase,
          assistantPreview: assistantText.slice(0, 240),
        },
        "phantom-image: replacing roleplay-only image delivery with diagnostic copy",
      );
      assistantText = PHANTOM_IMAGE_DIAGNOSTIC;
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

  // 8. Build response. In debug mode include _debug block with Phase 1
  //    diagnostics. Normal clients never see it (they don't pass debug:true).
  if (debugMode) {
    const filteredMemories = filterMemoriesForPrompt(memories);
    const KNOWN_CATEGORIES = ["identity", "relational", "project", "daily", "landmark"] as const;
    type KnownCat = (typeof KNOWN_CATEGORIES)[number];

    const categoriesSearched = KNOWN_CATEGORIES.filter((c) =>
      memories.some((m) => (m.category ?? "relational").trim() === c),
    );

    const memoriesSelected = filteredMemories
      .slice()
      .sort((a, b) => b.importance - a.importance || b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((m) => ({
        category: (m.category ?? "relational").trim(),
        confidence: m.confidence ?? 4,
        reuse: (m.reuse ?? "relevant_only").trim(),
        importance: m.importance,
        content: m.content.slice(0, 120) + (m.content.length > 120 ? "…" : ""),
      }));

    const ashleyState = {
      mode: (profile.ashleyMode ?? "").trim() || "daily",
      energy: (profile.ashleyEnergy ?? "").trim() || "balanced",
      tone: (profile.ashleyTone ?? "").trim() || "playful",
      focus: (profile.ashleyFocus ?? "").trim() || "general",
      emotionalState: (profile.ashleyEmotionalState ?? "").trim() || "grounded",
    };

    const _debug = {
      memoryCategoriesSearched: categoriesSearched,
      memoriesTotal: memories.length,
      memoriesAfterFilter: filteredMemories.length,
      memoriesSelected,
      ashleyState,
      continuityProtection: {
        ran: true,
        triggered: guardResult.diag.triggered,
        modified: guardResult.diag.modified,
        triggers: guardResult.diag.triggers,
        risks: guardResult.diag.risks,
      },
    };

    res.json({ userMessage: userRow, ashleyMessage: ashleyRow, _debug });
    return;
  }

  res.json({ userMessage: userRow, ashleyMessage: ashleyRow });
});

// ---------------------------------------------------------------------------
// Selfie endpoints (kept as poll-based, scoped per device + per message)
// ---------------------------------------------------------------------------

// Selfie speed/quality tradeoff. Default is "fast" because gpt-image-1 at
// quality:"low" + 1024x1024 finishes in ~6-10s vs ~25-40s at "high" + tall
// frame. Mobile clients can opt into "quality" per-request when they want
// the higher-res framed shot instead.
type SelfieMode = "fast" | "quality";

const ChatSelfieBodySchema = z.object({
  messageId: z.string().min(8).max(128),
  // The vibe field MAY contain an encoded `MODE|description` payload (server
  // emits these from /chat / /chat/stream). It MAY also be a legacy bare
  // description (older clients, retry from disk-persisted rows). Either is
  // accepted; decodeStoredVibe handles both.
  vibe: z.string().min(1).max(MAX_VIBE_LEN),
  mode: z.enum(["fast", "quality"]).optional().default("fast"),
  // Optional explicit override from the client. When omitted, the server
  // decodes from `vibe` (preferred path).
  imageMode: z
    .enum(IMAGE_MODES as unknown as [ImageMode, ...ImageMode[]])
    .optional(),
});

type SelfieJob =
  | {
      status: "pending";
      vibe: string;
      mode: SelfieMode;
      imageMode: ImageMode;
      deviceId: string;
      messageId: string;
      createdAt: number;
    }
  | {
      status: "ready";
      imageUrl: string;
      mode: SelfieMode;
      imageMode: ImageMode;
      deviceId: string;
      messageId: string;
      createdAt: number;
    }
  | {
      status: "failed";
      error: string;
      mode: SelfieMode;
      imageMode: ImageMode;
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
        // Backwards-compat: jobs persisted before fast/quality modes existed
        // had no `mode` field; jobs persisted before image-intent routing
        // had no `imageMode` field. Default both so they replay cleanly.
        const persistedImageMode = (job as Partial<SelfieJob>).imageMode;
        const withMode: SelfieJob = {
          ...job,
          mode: job.mode === "quality" ? "quality" : "fast",
          imageMode: isImageMode(persistedImageMode) ? persistedImageMode : "SELFIE_MODE",
        };
        selfieJobs.set(id, withMode);
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

// ---------------------------------------------------------------------------
// Selfie prompt cache — sha256(mode + fullPrompt) → previously-generated
// selfie id. 24h TTL. Lets repeated vibes/scenes return instantly instead of
// paying another 6-40s round trip to gpt-image-1. Survives server restarts
// via selfie-cache.json on disk (sibling of selfie-jobs.json).
// ---------------------------------------------------------------------------

type CachedSelfie = { selfieId: string; createdAt: number };

const SELFIE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const selfieCache = new Map<string, CachedSelfie>();

// In-flight dedup: when two requests arrive with the same cache key before
// the first one finishes generating, the second awaits the first's promise
// instead of paying for a duplicate gpt-image-1 call. Cleared in `finally`.
const selfieInFlight = new Map<string, Promise<string | null>>();

const SELFIE_CACHE_FILE = path.join(
  path.dirname(localSelfieDir),
  "selfie-cache.json",
);

function selfieCacheKey(fullPrompt: string, mode: SelfieMode): string {
  return createHash("sha256").update(`${mode}\n${fullPrompt}`).digest("hex");
}

function persistSelfieCache(): void {
  try {
    const obj: Record<string, CachedSelfie> = {};
    for (const [k, v] of selfieCache) obj[k] = v;
    const tmp = `${SELFIE_CACHE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj), "utf8");
    fs.renameSync(tmp, SELFIE_CACHE_FILE);
  } catch (err) {
    logger.warn({ err }, "Failed to persist selfie cache to disk");
  }
}

function loadSelfieCache(): void {
  try {
    if (!fs.existsSync(SELFIE_CACHE_FILE)) return;
    const raw = fs.readFileSync(SELFIE_CACHE_FILE, "utf8");
    if (!raw.trim()) return;
    const parsed = JSON.parse(raw) as Record<string, CachedSelfie>;
    const cutoff = Date.now() - SELFIE_CACHE_TTL_MS;
    for (const [k, v] of Object.entries(parsed)) {
      if (
        v &&
        typeof v.selfieId === "string" &&
        typeof v.createdAt === "number" &&
        v.createdAt >= cutoff
      ) {
        selfieCache.set(k, v);
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persisted selfie cache");
  }
}

function pruneSelfieCache(): void {
  const cutoff = Date.now() - SELFIE_CACHE_TTL_MS;
  let pruned = false;
  for (const [k, v] of selfieCache) {
    if (v.createdAt < cutoff) {
      selfieCache.delete(k);
      pruned = true;
    }
  }
  if (pruned) persistSelfieCache();
}

async function generateAshleySelfie(
  vibe: string,
  profile: AshleyProfile,
  mode: SelfieMode,
  imageMode: ImageMode,
): Promise<string | null> {
  const appearance = (profile.appearance ?? "").trim();
  const ashleyName = (profile.name ?? "Ashley").trim() || "Ashley";
  const wrapper = wrapperFor(imageMode);
  const modeBlock = buildModePromptBlock({
    mode: imageMode,
    vibe,
    subjectName: ashleyName,
    appearance,
  });
  const fullPrompt = [
    // Provider Floor for the IMAGE generator. Always first, never overridden
    // by mode/intimacy — see lib/contentPolicy.ts. The downstream image
    // provider has its own safety filter; this prefix keeps requests well
    // inside it so we degrade by Ashley saying "couldn't get the shot —
    // try a different vibe" rather than by hitting a hard provider error.
    buildSelfiePromptSafetyPrefix(),
    modeBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  // Pre-generation log. Captures: imageMode, why (wrapper hint), final
  // framing/sizing, vibe preview. Required by the image-intent spec so we
  // can audit "Schrödinger's legs" regressions after the fact.
  logger.info(
    {
      imageMode,
      framingHint: wrapper.framingHint,
      validationRequired: wrapper.requiresFullBodyValidation,
      providerMode: mode,
      vibePreview: vibe.slice(0, 160),
      promptPreview: fullPrompt.slice(0, 280),
    },
    "image-gen: pre-generation request",
  );

  // Cache check by (mode, fullPrompt). Cross-message reuse — saves 6-40s
  // when the same vibe + appearance + mode recurs within 24h.
  pruneSelfieCache();
  const cacheKey = selfieCacheKey(fullPrompt, mode);
  const cached = selfieCache.get(cacheKey);
  if (cached) {
    logger.info(
      { mode, imageMode, cacheKey: cacheKey.slice(0, 12), selfieId: cached.selfieId },
      "Image cache hit — reusing previously generated image",
    );
    return `${publicBaseUrl()}/api/selfies/${cached.selfieId}.png`;
  }

  // In-flight dedup: if another request is already generating this exact
  // prompt+mode, await its promise instead of paying for a duplicate call.
  // Common case: user spam-taps retry, or boot recovery re-triggers a job
  // whose original promise is still mid-flight.
  const inflight = selfieInFlight.get(cacheKey);
  if (inflight) {
    logger.info(
      { mode, imageMode, cacheKey: cacheKey.slice(0, 12) },
      "Image in-flight dedup — joining existing generation",
    );
    return inflight;
  }

  // Sizing: the per-mode framing hint OVERRIDES the user's fast/quality
  // preference for canvas shape. Full-body / outfit / pose / scene / art
  // require a tall canvas — a square crop is the root cause of cropped
  // legs. Quality bit (medium vs high) still respects the user's choice.
  const size: "1024x1024" | "1024x1536" =
    wrapper.framingHint === "tall" || mode === "quality"
      ? "1024x1536"
      : "1024x1024";
  const quality: "low" | "medium" | "high" = mode === "quality" ? "high" : "medium";

  const promise: Promise<string | null> = (async () => {
    let b64: string;
    try {
      b64 = await generateImageBase64(fullPrompt, size, quality);
    } catch (err) {
      logger.warn({ err, mode }, "Selfie image generation failed");
      return null;
    }

    const id = randomUUID();
    try {
      const relUrl = await saveSelfie(id, Buffer.from(b64, "base64"));
      selfieCache.set(cacheKey, { selfieId: id, createdAt: Date.now() });
      persistSelfieCache();
      return `${publicBaseUrl()}${relUrl}`;
    } catch (err) {
      logger.warn({ err }, "Failed to persist selfie");
      return null;
    }
  })().finally(() => {
    selfieInFlight.delete(cacheKey);
  });
  selfieInFlight.set(cacheKey, promise);
  return promise;
}

function startSelfieGeneration(
  jobId: string,
  vibe: string,
  mode: SelfieMode,
  imageMode: ImageMode,
  deviceId: string,
  messageId: string,
): void {
  void (async () => {
    try {
      const profile = await getOrCreateProfileFor(deviceId);
      const imageUrl = await generateAshleySelfie(vibe, profile, mode, imageMode);
      if (imageUrl) {
        // Patch the assistant message row so the next /state hydration
        // reflects the photo even if the client misses the poll.
        try {
          // NOTE: do NOT clear selfieVibe here. The encoded `MODE|vibe`
          // payload is the only record of which image mode + visual brief was
          // used for this turn, and the foot-visible-retry path
          // (findPriorImageAttempt → foot_visible_retry resolver) needs it to
          // reconstruct the prior attempt when the user says "feet missing".
          // Mobile's pending-UI is gated on `!hasImage && selfieVibe`, so a
          // leftover vibe alongside a delivered imageUrl is harmless.
          await db
            .update(messagesTable)
            .set({ imageUrl })
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
          mode,
          imageMode,
          deviceId,
          messageId,
          createdAt: Date.now(),
        });
      } else {
        const wrapper = wrapperFor(imageMode);
        // Honesty over performance theatre: when a full-body / outfit / pose
        // mode fails we say so explicitly instead of pretending the image
        // succeeded with a cropped fallback. Mobile already shows a retry
        // button when status==="failed".
        // Honest failure copy. Names the layer (generator) and the requested
        // mode without dramatising the failure as a permanent limit. See the
        // "Capability truth rule" section of ashleyCoreSpec.ts.
        const failureCopy = wrapper.requiresFullBodyValidation
          ? `Image attempt failed at the generator layer for ${imageMode}. That's a failed test, not proof I can't do full-body — want me to retry?`
          : `Image attempt failed at the generator layer for ${imageMode}. Want me to retry?`;
        setSelfieJob(jobId, {
          status: "failed",
          error: failureCopy,
          mode,
          imageMode,
          deviceId,
          messageId,
          createdAt: Date.now(),
        });
      }
    } catch (err) {
      logger.warn({ err, jobId, imageMode }, "Background image generation crashed");
      setSelfieJob(jobId, {
        status: "failed",
        error:
          err instanceof Error && err.message
            ? err.message
            : "Image generation crashed.",
        mode,
        imageMode,
        deviceId,
        messageId,
        createdAt: Date.now(),
      });
    }
  })();
}

// Boot recovery: re-issue any pending jobs after a server restart, and
// rehydrate the selfie cache from disk so cross-restart cache hits work.
loadSelfieJobs();
loadSelfieCache();
for (const [id, job] of selfieJobs) {
  if (job.status === "pending") {
    logger.info(
      { jobId: id, mode: job.mode, imageMode: job.imageMode },
      "Resuming image-gen job after server restart",
    );
    startSelfieGeneration(
      id,
      job.vibe,
      job.mode,
      job.imageMode,
      job.deviceId,
      job.messageId,
    );
  }
}

router.post("/chat/selfie", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ChatSelfieBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { messageId, vibe, mode, imageMode: clientImageMode } = parsed.data;

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

  // Resolve (imageMode, vibe). Priority:
  //   1. Explicit client-supplied imageMode wins.
  //   2. Otherwise decode from the vibe payload (server emits MODE|vibe
  //      from /chat and /chat/stream).
  //   3. Legacy bare vibes get classified by keyword.
  const decoded = decodeStoredVibe(vibe);
  const imageMode: ImageMode = clientImageMode ?? decoded.mode;
  const decodedVibe = decoded.vibe || vibe.trim();
  req.log.info(
    {
      messageId,
      imageMode,
      reason: clientImageMode ? "client-supplied imageMode override" : decoded.reason,
      vibePreview: decodedVibe.slice(0, 120),
    },
    "image-intent: /chat/selfie request resolved",
  );

  pruneSelfieJobs();
  const jobId = randomUUID();
  setSelfieJob(jobId, {
    status: "pending",
    vibe: decodedVibe,
    mode,
    imageMode,
    deviceId,
    messageId,
    createdAt: Date.now(),
  });
  startSelfieGeneration(jobId, decodedVibe, mode, imageMode, deviceId, messageId);
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

// Server-side caps for /chat/summarize. SummarizeChunkBodySchema is generated
// and has no array-length or string-length constraints, so without these caps
// a caller could pass thousands of messages with arbitrarily long content and
// exhaust Anthropic token quota in a single allowed request. Per-IP rate
// limiting comes from the global apiRateLimit in app.ts; these caps protect
// the per-request token budget.
const MAX_SUMMARIZE_MESSAGES = 100;
const MAX_SUMMARIZE_MSG_LEN = 4000;
const MAX_SUMMARIZE_PRIOR_LEN = 4000;

const SafeSummarizeChunkBodySchema = SummarizeChunkBodySchema.and(
  z.object({
    messages: z
      .array(
        z.object({
          role: z.string(),
          content: z.string().max(MAX_SUMMARIZE_MSG_LEN),
        }),
      )
      .max(MAX_SUMMARIZE_MESSAGES),
    priorSummary: z.string().max(MAX_SUMMARIZE_PRIOR_LEN).optional(),
  }),
);

// Stateless: take an ordered slice of messages and return one narrative
// summary. Used by the local-first mobile client.
router.post("/chat/summarize", async (req, res): Promise<void> => {
  const parsed = SafeSummarizeChunkBodySchema.safeParse(req.body);
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

const ALLOWED_CATEGORIES = ["identity", "relational", "project", "daily", "landmark"] as const;
const ALLOWED_REUSE = ["often", "relevant_only", "rarely"] as const;

// ---------------------------------------------------------------------------
// Memory Triage Layer helpers
// ---------------------------------------------------------------------------

const MEM_TYPE_BY_CATEGORY: Record<string, string> = {
  identity: "identity",
  relational: "relationship",
  daily: "preference",
  landmark: "event",
  project: "preference",
};

function inferMemType(category: string): string {
  return MEM_TYPE_BY_CATEGORY[category] ?? "preference";
}

function inferTriageImportance(
  memType: string,
): "low" | "medium" | "high" | "core" {
  if (
    memType === "identity" ||
    memType === "system" ||
    memType === "relationship"
  )
    return "high";
  if (memType === "correction") return "medium";
  return "low"; // preference, event
}

function normalizeMemoryContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

// Fire-and-forget: run after every memory fetch that precedes a prompt build.
// Two duties:
//   1. ACTIVE → PASSIVE: any memory not used for 30+ days (by lastUsedAt).
//   2. Update lastUsedAt = now for memories that pass the reuse/importance
//      filter and will be included in the current prompt turn.
// Neither duty blocks the chat response; failures are logged and ignored.
async function applyMemoryTriageBackground(
  deviceId: string,
  memories: Memory[],
): Promise<void> {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();

    // 1. ACTIVE → PASSIVE for memories not used in 30 days.
    // Only considers memories where lastUsedAt is set (i.e. those created or
    // touched after the triage layer went live). Old rows with null lastUsedAt
    // are left untouched so existing behaviour is preserved.
    await db
      .update(memoriesTable)
      .set({ state: "passive" })
      .where(
        and(
          eq(memoriesTable.deviceId, deviceId),
          sql`(${memoriesTable.state} IS NULL OR ${memoriesTable.state} = 'active')`,
          sql`${memoriesTable.lastUsedAt} IS NOT NULL`,
          sql`${memoriesTable.lastUsedAt} < ${thirtyDaysAgo}`,
        ),
      );

    // 2. Mark as recently used: memories that pass the reuse/importance gate
    // (inline — no state check here to avoid circular dependency with
    // filterMemoriesForPrompt's new state filter).
    const includedIds = memories
      .filter((m) => {
        const reuse = (m.reuse ?? "relevant_only").trim();
        if (reuse === "often") return true;
        if (reuse === "relevant_only") return true;
        if (reuse === "rarely") return m.importance >= 4;
        return true;
      })
      .map((m) => m.id);

    if (includedIds.length > 0) {
      await db
        .update(memoriesTable)
        .set({ state: "active", lastUsedAt: now })
        .where(
          and(
            eq(memoriesTable.deviceId, deviceId),
            inArray(memoriesTable.id, includedIds),
          ),
        );
    }
  } catch (err) {
    logger.error(
      { err },
      "Memory triage background update failed (non-fatal)",
    );
  }
}

async function distillMemories(
  deviceId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  try {
    // Memory distillation always uses Claude regardless of ASHLEY_TEXT_PROVIDER.
    // Documented invariant in replit.md: "Stays on Claude regardless of the env
    // switch: the summariser...and the memory distiller — quality matters for
    // long-term memory continuity and cost is small."
    // Using generateChatText (the routing adapter) here incorrectly sent this
    // to Gemini when ASHLEY_TEXT_PROVIDER=gemini. Gemini rate-limit errors on
    // the distiller were silently swallowed, causing Ashley to permanently lose
    // facts from recent conversations (the #ASHLEY-MEM-002 regression).
    const distillResult = await anthropic.messages.create({
      model: CHAT_MODEL,
      max_tokens: 2048,
      system: MEMORY_DISTILLER_PROMPT,
      messages: [
        {
          role: "user",
          content: `USER: ${userText}\n\nASHLEY: ${assistantText}`,
        },
      ],
    });
    const distillBlock = distillResult.content[0];
    const text =
      distillBlock && distillBlock.type === "text"
        ? distillBlock.text.trim()
        : "";
    if (!text) return;
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
    type RawMemory = {
      content: string;
      tag?: string;
      importance?: number;
      category?: string;
      confidence?: number;
      summary?: string | null;
      reuse?: string;
    };
    const memories = (parsed as { memories: unknown[] }).memories
      .filter(
        (m): m is RawMemory =>
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
        category: ALLOWED_CATEGORIES.includes(m.category as typeof ALLOWED_CATEGORIES[number])
          ? (m.category as typeof ALLOWED_CATEGORIES[number])
          : "relational",
        confidence:
          typeof m.confidence === "number"
            ? Math.max(1, Math.min(5, Math.round(m.confidence)))
            : 4,
        summary:
          typeof m.summary === "string" && m.summary.trim()
            ? m.summary.trim().slice(0, 300)
            : null,
        reuse: ALLOWED_REUSE.includes(m.reuse as typeof ALLOWED_REUSE[number])
          ? (m.reuse as typeof ALLOWED_REUSE[number])
          : "relevant_only",
      }));

    if (memories.length === 0) return;

    // Fetch existing memories for duplicate detection.
    // One query up-front; comparisons happen in-process.
    const existingRows = await db
      .select({
        id: memoriesTable.id,
        content: memoriesTable.content,
        confidenceScore: memoriesTable.confidenceScore,
        state: memoriesTable.state,
      })
      .from(memoriesTable)
      .where(eq(memoriesTable.deviceId, deviceId));

    const existingByNorm = new Map(
      existingRows.map((r) => [normalizeMemoryContent(r.content), r]),
    );

    let inserted = 0;
    let updated = 0;

    for (const mem of memories) {
      const norm = normalizeMemoryContent(mem.content);
      const existing = existingByNorm.get(norm);

      if (existing) {
        // Duplicate — update metadata; do not create a second record.
        // Incrementing confidenceScore signals increasing reliability.
        // Restoring state to "active" handles the PASSIVE → ACTIVE case
        // (acceptance test: referencing a passive memory reactivates it).
        const newScore = Math.min(
          1.0,
          (existing.confidenceScore ?? 0.7) + 0.1,
        );
        await db
          .update(memoriesTable)
          .set({ lastUsedAt: new Date(), confidenceScore: newScore, state: "active" })
          .where(eq(memoriesTable.id, existing.id));
        updated++;
      } else {
        // New memory — insert with full triage stamp.
        const mt = inferMemType(mem.category);
        await db.insert(memoriesTable).values({
          ...mem,
          memType: mt,
          triageImportance: inferTriageImportance(mt),
          state: "active",
          lastUsedAt: new Date(),
          confidenceScore: 0.7,
        });
        inserted++;
        // Register in local map so within-batch duplicates are caught.
        existingByNorm.set(norm, {
          id: mem.id,
          content: mem.content,
          confidenceScore: 0.7,
          state: "active",
        });
      }
    }

    logger.info(
      { inserted, updated, deviceId },
      "Memory distillation complete (triage)",
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

// ===========================================================================
// Presence Loop — Stage 1
//
// POST /chat/stream                       — SSE-streamed chat reply
// POST /chat/stream/:streamId/abort       — server-side abort of a live stream
//
// The streaming endpoint covers BOTH the new-turn case (`userMessage`) and
// the resume-from-interrupt case (`continueFromMessageId`). Wire format:
//
//   event: meta
//   data: {"streamId":"<ashley_msg_id>","userMessage":<row|null>,
//          "ashleyMessage":<row>,"mode":"new"|"continue"}
//
//   event: delta
//   data: {"text":"…incremental chunk…"}
//
//   event: done
//   data: {"content":"…final clean text…","selfieVibe":"…|null"}
//
//   event: interrupted
//   data: {"partialContent":"…what we had before stop…"}
//
//   event: error
//   data: {"error":"…user-facing message…"}
//
// Lifecycle of the Ashley row in `messagesTable`:
//   - inserted up-front with content="" and status="streaming"
//   - on natural finish:  content=<clean text>, status="complete"
//   - on stop / disconnect: content=<partial>, status="interrupted"
// Boot-time recovery in index.ts flips any orphan "streaming" rows to
// "interrupted" so a server restart mid-stream never leaves a dead bubble.
// ===========================================================================

// In-flight stream registry. Keyed by streamId (= the Ashley row's id we
// inserted up-front). Used by /chat/stream/:streamId/abort to cancel the
// live Anthropic call from a different request. Entries are removed in the
// `finally` of the streaming handler so the map never grows unboundedly.
const inFlightStreams = new Map<string, AbortController>();

// ---------------------------------------------------------------------------
// Request idempotency map — prevents duplicate model calls when the mobile
// client sends the same requestId twice before the first completes.
// Keyed by client-supplied requestId; entries expire after 10 minutes.
// "pending"  → a request with this id is currently being processed.
// "done"     → the request completed successfully (kept briefly for late
//              duplicate detection; client-side lock makes true replays rare).
// Errors are not stored: the requestId is deleted so retries are allowed.
// ---------------------------------------------------------------------------
type IdempotencyStatus = "pending" | "done";
const requestIdempotencyMap = new Map<string, { status: IdempotencyStatus; createdAt: number }>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000; // 10 minutes

function pruneIdempotencyMap(): void {
  const cutoff = Date.now() - IDEMPOTENCY_TTL_MS;
  for (const [key, entry] of requestIdempotencyMap) {
    if (entry.createdAt < cutoff) requestIdempotencyMap.delete(key);
  }
}

const ChatStreamBodySchema = z
  .object({
    userMessage: z
      .object({
        id: z.string().min(8).max(128),
        content: z.string().min(1).max(MAX_CONTENT_LEN),
        replyTo: ReplyToSchema.nullish(),
      })
      .optional(),
    continueFromMessageId: z.string().min(8).max(128).optional(),
    clientNow: z.string().datetime({ offset: true }).optional(),
    clientTimezone: z.string().min(1).max(64).optional(),
    /** Client-generated id for this logical send. The server uses it to
     *  detect and reject duplicate in-flight requests (same id already
     *  being processed), preventing concurrent model calls for the same
     *  message under rapid-send / retry conditions. */
    requestId: z.string().min(1).max(128).optional(),
  })
  .refine(
    (d) =>
      (d.userMessage ? 1 : 0) + (d.continueFromMessageId ? 1 : 0) === 1,
    {
      message:
        "Provide exactly one of `userMessage` or `continueFromMessageId`",
    },
  );

router.post("/chat/stream", async (req, res): Promise<void> => {
  // ===========================================================================
  // STEP 1: Multi-ticket guard — BEFORE interceptor logic, BEFORE any DB touch.
  // Rejected here via SSE so the ack renders in the chat bubble.
  // The interceptor below is never reached for multi-command messages.
  // ===========================================================================
  {
    const _gc = req.body as Record<string, unknown> | null | undefined;
    const _gContent = typeof ((_gc?.["userMessage"] as Record<string, unknown> | null | undefined)?.["content"]) === "string"
      ? ((_gc!["userMessage"] as Record<string, unknown>)["content"] as string) : "";
    const _gCount = (_gContent.toLowerCase().match(/create ticket:/g) ?? []).length;
    if (_gCount > 1) {
      const _ackId = crypto.randomUUID();
      const _ackNow = new Date().toISOString();
      const _ackMsg = {
        id: _ackId, role: "ashley", content: "", status: "streaming",
        imageUrl: null, selfieVibe: null, imageMimeType: null, imageCategory: null,
        imageCaption: null, imageAnalysisMode: null, imageRemembered: null,
        replyToId: null, replyToRole: null, replyToPreview: null, createdAt: _ackNow,
      };
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(`event: meta\ndata: ${JSON.stringify({ streamId: _ackId, userMessage: null, ashleyMessage: _ackMsg, mode: "new", continueFromMessageId: null })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ content: "Invalid command: multiple ticket instructions detected. Only one allowed per message.", selfieVibe: null })}\n\n`);
      res.end();
      return;
    }
  }

  // ===========================================================================
  // STEP 2: Single create ticket: interceptor — exactly one command guaranteed.
  // SSE response so the ack renders in the chat bubble.
  // ===========================================================================
  {
    const _rawBody = req.body as Record<string, unknown> | null | undefined;
    const _rawMsg = (_rawBody?.["userMessage"] as Record<string, unknown> | null | undefined);
    const _content = typeof _rawMsg?.["content"] === "string" ? (_rawMsg["content"] as string) : "";
    if (_content.trimStart().toLowerCase().startsWith("create ticket:")) {
      console.log("CREATE_TICKET_INTERCEPTOR_TRIGGERED");
      const summary = _content.trim().slice("create ticket:".length).trim();
      let ackContent: string;
      if (!summary) {
        ackContent = "Please provide a ticket summary after: create ticket:";
      } else {
        try {
          const dupId = await findDuplicateTicket(summary);
          if (dupId) {
            logger.info({ dupId }, "CREATE_TICKET_INTERCEPTOR/stream: duplicate suppressed");
            ackContent = `Issue already exists. [${dupId}]`;
          } else {
            const ticketId = `ASH-${Date.now().toString(36).toUpperCase()}`;
            await db.insert(ashleyTicketsTable).values({
              ticketId,
              status: "OPEN",
              category: "BEHAVIOUR",
              severity: "medium",
              summary: summary.slice(0, 280),
              description: summary,
              source: "user_command",
              createdBy: "kane",
              approved: false,
            });
            logger.info({ ticketId }, "CREATE_TICKET_INTERCEPTOR/stream: ticket written");
            ackContent = `Issue logged. [${ticketId}]`;
          }
        } catch (err) {
          logger.error({ err }, "CREATE_TICKET_INTERCEPTOR/stream: DB insert failed");
          ackContent = "Issue noted — but logging failed. Please try again.";
        }
      }
      const ackId = crypto.randomUUID();
      const ackNow = new Date().toISOString();
      const ackMsg = {
        id: ackId, role: "ashley", content: "", status: "streaming",
        imageUrl: null, selfieVibe: null, imageMimeType: null, imageCategory: null,
        imageCaption: null, imageAnalysisMode: null, imageRemembered: null,
        replyToId: null, replyToRole: null, replyToPreview: null, createdAt: ackNow,
      };
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      res.write(`event: meta\ndata: ${JSON.stringify({ streamId: ackId, userMessage: null, ashleyMessage: ackMsg, mode: "new", continueFromMessageId: null })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ content: ackContent, selfieVibe: null })}\n\n`);
      res.end();
      return;
    }
  }

  const deviceId = getDeviceId(req);

  // ---------------------------------------------------------------------------
  // DIAGNOSTIC CHECK — before Zod parse.
  // ---------------------------------------------------------------------------
  const rawBodyS = req.body as Record<string, unknown> | null | undefined;
  const rawUserMsgS = rawBodyS?.["userMessage"] as Record<string, unknown> | null | undefined;
  const rawMessageS = typeof rawUserMsgS?.["content"] === "string" ? rawUserMsgS["content"] : "";
  const normalizedS = rawMessageS.trim().toLowerCase();
  const isExactDiagnosticsS = normalizedS === "run diagnostics";
  const isDiagnosticsIntentS =
    normalizedS.includes("diagnostic") ||
    normalizedS.includes("diagnostics");
  if (isExactDiagnosticsS) {
    await runDiagnosticsReport(req, res, "chat/stream", "sse");
    return;
  }
  if (isDiagnosticsIntentS) {
    // The streaming client expects SSE format — a plain res.json() is read
    // as an unknown event and the mobile treats the stream as failed, then
    // retries on /chat every 4 s. Return a real SSE stream instead so the
    // redirect message appears in the chat bubble and the retry loop stops.
    const redirectContent =
      "To run diagnostics, please use the exact command: run diagnostics";
    const fakeId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ashleyMsg = {
      id: fakeId,
      deviceId,
      role: "ashley",
      content: "",
      status: "streaming",
      imageUrl: null,
      selfieVibe: null,
      imageMimeType: null,
      imageCategory: null,
      imageCaption: null,
      imageAnalysisMode: null,
      imageRemembered: null,
      replyToId: null,
      replyToRole: null,
      replyToPreview: null,
      createdAt: now,
    };
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(
      `event: meta\ndata: ${JSON.stringify({ streamId: fakeId, userMessage: null, ashleyMessage: ashleyMsg, mode: "new", continueFromMessageId: null })}\n\n`,
    );
    res.write(
      `event: done\ndata: ${JSON.stringify({ content: redirectContent, selfieVibe: null })}\n\n`,
    );
    res.end();
    return;
  }

  // ---------------------------------------------------------------------------
  // CREATE TICKET command — raw intercept, same level as diagnostics.
  // Must be before Zod parse. LLM is never called for this command.
  // Syntax: "create ticket: <summary>" (case-insensitive).
  // Returns SSE so the ack appears in the chat bubble.
  // ---------------------------------------------------------------------------
  if (normalizedS.startsWith("create ticket:")) {
    const summary = rawMessageS.trim().slice("create ticket:".length).trim();
    const ackContent = summary
      ? await (async () => {
          try {
            const ticketId = `ASH-${Date.now().toString(36).toUpperCase()}`;
            await db.insert(ashleyTicketsTable).values({
              ticketId,
              status: "OPEN",
              category: "BEHAVIOUR",
              severity: "medium",
              summary: summary.slice(0, 280),
              description: summary,
              source: "user_command",
              createdBy: "kane",
              approved: false,
            });
            req.log.info({ ticketId, summary: summary.slice(0, 80) }, "chat/stream: create ticket command");
            return `Issue logged. [${ticketId}]`;
          } catch (err) {
            req.log.error({ err }, "chat/stream: create ticket command — DB insert failed");
            return "Issue noted — but logging failed. Please try again.";
          }
        })()
      : "Please provide a ticket summary after: create ticket:";
    const ackId = crypto.randomUUID();
    const ackNow = new Date().toISOString();
    const ackMsg = {
      id: ackId, deviceId, role: "ashley", content: "", status: "streaming",
      imageUrl: null, selfieVibe: null, imageMimeType: null, imageCategory: null,
      imageCaption: null, imageAnalysisMode: null, imageRemembered: null,
      replyToId: null, replyToRole: null, replyToPreview: null, createdAt: ackNow,
    };
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: meta\ndata: ${JSON.stringify({ streamId: ackId, userMessage: null, ashleyMessage: ackMsg, mode: "new", continueFromMessageId: null })}\n\n`);
    res.write(`event: done\ndata: ${JSON.stringify({ content: ackContent, selfieVibe: null })}\n\n`);
    res.end();
    return;
  }

  const parsed = ChatStreamBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        parsed.error.issues[0]?.message ?? "Invalid /chat/stream payload",
    });
    return;
  }
  const { userMessage, continueFromMessageId, clientNow, clientTimezone, requestId } =
    parsed.data;
  const isContinue = Boolean(continueFromMessageId);

  // ---- Request idempotency check (new-turn mode only; continue is inherently
  //      idempotent via the existing message id the client already has).
  if (requestId && !isContinue) {
    pruneIdempotencyMap();
    const existing = requestIdempotencyMap.get(requestId);
    if (existing?.status === "pending") {
      // This exact request is already being processed. Return a structured
      // SSE error so the client knows to wait rather than stacking another
      // parallel call. The client-side isSendingRef lock should prevent this
      // in normal operation; this is the belt-and-suspenders server guard.
      req.log.warn({ requestId }, "chat/stream: duplicate in-flight requestId rejected");
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(
        `event: error\ndata: ${JSON.stringify({ error: "IN_FLIGHT_REQUEST: a request with this id is already being processed" })}\n\n`,
      );
      res.end();
      return;
    }
    // Mark as pending immediately — before any async DB or model work.
    requestIdempotencyMap.set(requestId, { status: "pending", createdAt: Date.now() });
  }

  // ---- Continue-mode preflight: validate the interrupted row up-front so
  //      we can return a proper 4xx before opening the SSE stream.
  let interruptedRow: Message | null = null;
  if (isContinue) {
    try {
      const found = await db
        .select()
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.id, continueFromMessageId!),
            eq(messagesTable.deviceId, deviceId),
          ),
        )
        .limit(1);
      if (found.length === 0) {
        res.status(404).json({ error: "Message not found" });
        return;
      }
      const row = found[0]!;
      if (row.role !== "ashley") {
        res
          .status(400)
          .json({ error: "Can only continue from an Ashley message" });
        return;
      }
      if (row.status !== "interrupted") {
        res
          .status(409)
          .json({ error: `Message is not interrupted (status=${row.status})` });
        return;
      }
      interruptedRow = row;
    } catch (err) {
      req.log.error({ err }, "Continue preflight failed");
      res.status(500).json({ error: "Could not load the message to continue" });
      return;
    }
  }

  // ---- New-turn mode: persist the user row idempotently (mirrors /chat).
  let userRow: Message | null = null;
  if (!isContinue && userMessage) {
    const userContent = userMessage.content.trim();
    if (!userContent) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    // APPROVE gate (stream path) — same logic as /chat; returns JSON, never opens SSE.
    const streamApproveMatch = userContent.match(/^APPROVE:\s*(\S+)/i);
    if (streamApproveMatch) {
      const ticketId = streamApproveMatch[1]!;
      try {
        const result = await approveTicketById(ticketId);
        if ("error" in result) {
          res.status(400).json({ approved: false, error: result.error, ticket_id: ticketId });
        } else {
          req.log.info({ ticket_id: ticketId }, "chat/stream: APPROVE gate processed");
          res.json({ approved: true, ticket_id: ticketId, status: "APPROVED" });
        }
      } catch (err) {
        req.log.error({ err, ticket_id: ticketId }, "chat/stream: APPROVE gate failed");
        res.status(500).json({ approved: false, error: "Failed to process approval", ticket_id: ticketId });
      }
      return;
    }

    try {
      const inserted = await db
        .insert(messagesTable)
        .values({
          id: userMessage.id,
          deviceId,
          role: "user",
          content: userContent,
          replyToId: userMessage.replyTo?.id ?? null,
          replyToRole: userMessage.replyTo?.role ?? null,
          replyToPreview: userMessage.replyTo?.preview ?? null,
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
              eq(messagesTable.id, userMessage.id),
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
      }
    } catch (err) {
      req.log.error({ err }, "Failed to persist user message (stream)");
      res.status(500).json({ error: "Could not save your message" });
      return;
    }
  }

  // ---- Load context (profile, memories, summaries, history). For continue
  //      mode we still need the full picture so the model has identical
  //      grounding to the original turn.
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
    void applyMemoryTriageBackground(deviceId, memories);
  } catch (err) {
    req.log.error({ err }, "Failed to load chat context (stream)");
    res.status(500).json({ error: "Could not load conversation" });
    return;
  }

  // Fetch OPEN tickets for prompt injection (Phase 2.5). Non-fatal.
  let openTickets: Array<{ ticketId: string; summary: string; severity: string; status: string }> = [];
  try {
    openTickets = await db
      .select({
        ticketId: ashleyTicketsTable.ticketId,
        summary: ashleyTicketsTable.summary,
        severity: ashleyTicketsTable.severity,
        status: ashleyTicketsTable.status,
      })
      .from(ashleyTicketsTable)
      .where(eq(ashleyTicketsTable.status, "OPEN"));
  } catch (err) {
    req.log.warn({ err }, "Failed to fetch open tickets for stream prompt (non-fatal)");
  }

  // ---- Build the prompt.
  //      In new-turn mode this mirrors /chat exactly. In continue mode we
  //      drop the trailing interrupted row from the verbatim history (we'll
  //      re-add it as the assistant turn explicitly) and append the
  //      "continue naturally" instruction.
  const lastUserRowForTime = isContinue
    ? history.filter((m) => m.role === "user").slice(-1)[0] ?? null
    : userRow;
  let previousMessageAt: Date | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (lastUserRowForTime && m.id === lastUserRowForTime.id) continue;
    if (interruptedRow && m.id === interruptedRow.id) continue;
    previousMessageAt = m.createdAt;
    break;
  }
  const timeContext = buildTimeContext(
    clientNow,
    clientTimezone,
    previousMessageAt,
  );
  const baseSystemPrompt = `${timeContext}\n\n${buildSystemPrompt(profile, memories, summaries)}${buildSystemEventsSection()}\n\n${buildOpenTicketsBlock(openTickets)}`;

  // Web lookup (Stage 1+): if the user message matches the trigger
  // heuristic, run a Tavily search server-side and inject a
  // "=== WEB LOOKUP: <status> ===" block into the system prompt so Ashley
  // always knows the outcome — success, empty, failed, or unavailable.
  // Continue mode skips this (no new user prompt to classify). When the
  // trigger doesn't fire, no block is injected and Section 9 of the Core
  // Spec tells Ashley not to present fresh facts as if she'd just checked.
  let systemPrompt = baseSystemPrompt;
  if (!isContinue && userRow) {
    const builderAware = profile.builderAwareMode !== false;
    const lookup = await maybeRunWebLookup(userRow.content, builderAware);
    if (lookup) {
      req.log.info(
        {
          deviceId,
          query: lookup.query.slice(0, 80),
          outcome: lookup.kind,
          resultCount: lookup.kind === "success" ? lookup.results.length : 0,
          urls: lookup.kind === "success" ? lookup.results.map((r) => r.url) : [],
          reason: lookup.kind === "failed" ? lookup.reason : undefined,
          builderAware,
        },
        "web lookup outcome injected into chat/stream prompt",
      );
      systemPrompt = `${baseSystemPrompt}\n\n${lookup.block}`;
    }
  }

  // Short follow-up image intent resolver (mirror of /chat). Only meaningful
  // for new-turn mode where there's a fresh user message to inspect.
  //
  // HARD SERVER-SIDE GATE (Wren follow-up): if the resolver fires AND we can
  // synthesise a marker server-side, capture the synth result here and use it
  // to short-circuit the streaming LLM call below. This guarantees image
  // intent → image action, never refusal prose / phantom success.
  let imageGateSynth: ReturnType<typeof synthesizeImageActionReply> | null = null;
  if (!isContinue && userRow) {
    try {
      const followUpHistory: FollowUpHistoryTurn[] = history.map((m) => ({
        role: m.role === "user" ? "user" : "ashley",
        content: (m.content ?? "").toString(),
        selfieVibe: m.role === "user" ? null : m.selfieVibe ?? null,
        imageUrl: m.role === "user" ? null : m.imageUrl ?? null,
      }));
      const resolution = resolveImageFollowUp(userRow.content, followUpHistory);
      if (resolution) {
        const synth = synthesizeImageActionReply(resolution);
        if (synth) {
          imageGateSynth = synth;
          const isFootRetry = resolution.kind === "foot_visible_retry";
          req.log.info(
            {
              deviceId,
              kind: resolution.kind,
              imageMode: synth.mode,
              captionPreview: synth.captionText.slice(0, 200),
              descriptionPreview: synth.description.slice(0, 200),
              modeReason: resolution.modeReason,
              imageGenerationTriggered: "yes — server-side marker synthesised, /chat/selfie will run",
              llmCallSkipped: true,
              // Wren's required structured fields for foot-visible-retry.
              recentImageAttempt: isFootRetry ? true : undefined,
              previousImageMode: isFootRetry ? resolution.priorAttemptMode ?? null : undefined,
              retryDetected: isFootRetry ? true : undefined,
              retryReason: isFootRetry ? resolution.modeReason : undefined,
              priorAttemptDelivered: isFootRetry ? resolution.priorAttemptDelivered : undefined,
              generation_called: true,
            },
            "image-intent: HARD GATE (stream) — LLM bypassed, marker synthesised server-side",
          );
        } else {
          systemPrompt = `${systemPrompt}\n\n${buildFollowUpTurnHint(resolution)}`;
          req.log.info(
            {
              deviceId,
              followUpText: resolution.followUpText.slice(0, 200),
              priorVisualText: resolution.priorVisualText?.slice(0, 200) ?? null,
              sanitisedVisualText: resolution.sanitisedVisualText?.slice(0, 200) ?? null,
              sanitised: resolution.sanitised,
              resolvedRequest: resolution.resolvedRequest.slice(0, 240),
              suggestedMode: resolution.suggestedMode,
              modeReason: resolution.modeReason,
              imageGenerationTriggered: "no — no actionable description, falling back to TURN HINT",
            },
            "image-followup: synth declined — TURN HINT fallback engaged (stream)",
          );
        }
      }
    } catch (err) {
      req.log.warn({ err }, "image-followup: resolver threw in /chat/stream (non-fatal)");
    }
  }

  const claudeMessages: Array<{ role: "user" | "assistant"; content: string }> =
    [];
  for (const m of history) {
    // Skip the interrupted row from verbatim history — we'll add it back
    // explicitly as the final assistant turn so the continuation prompt
    // ends with `assistant:<partial>`.
    if (interruptedRow && m.id === interruptedRow.id) continue;
    // For new-turn mode, exclude all incomplete Ashley rows (status=interrupted
    // or status=streaming). Including them contaminates the model's context:
    // a partial like "Ping3" sent as an assistant turn causes the model to
    // treat it as something to continue from, producing blended output
    // ("Ping3Ping4.") for the next user turn. In new-turn mode the user has
    // implicitly moved on; only confirmed complete turns belong in context.
    if (!isContinue && m.role === "ashley" && m.status !== "complete") continue;
    const role: "user" | "assistant" =
      m.role === "user" ? "user" : "assistant";
    let text = (m.content ?? "").trim();
    if (
      !isContinue &&
      userRow &&
      m.id === userRow.id &&
      userMessage?.replyTo
    ) {
      const previewClean = userMessage.replyTo.preview
        .replace(/\s+/g, " ")
        .trim();
      if (previewClean) {
        const refersTo =
          userMessage.replyTo.role === "ashley"
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
  if (claudeMessages.length === 0 && !isContinue) {
    claudeMessages.push({
      role: "user",
      content: userMessage!.content.trim(),
    });
  }

  let continueInstruction: string | null = null;
  if (isContinue && interruptedRow) {
    const partial = (interruptedRow.content ?? "").trim();
    // Re-append the partial as the final assistant turn so the model sees
    // exactly where it left off. Anthropic auto-prefixes the next response
    // with whatever this assistant turn ends with — that's the desired
    // behaviour for "continue from the partial".
    if (partial.length > 0) {
      claudeMessages.push({ role: "assistant", content: partial });
    }
    // Operator-level nudge layered onto the system prompt — keeps the
    // assistant continuation natural rather than restarting.
    continueInstruction =
      "The user tapped stop while you were mid-reply. Continue naturally from where you were, without repeating yourself, restarting the sentence, or apologising. Pick up the thought as if you had never paused.";
  }
  const finalSystemPrompt = continueInstruction
    ? `${systemPrompt}\n\n## Continuation directive\n${continueInstruction}`
    : systemPrompt;

  // ---- Insert Ashley row up-front in `streaming` state. Its id is the
  //      streamId we hand to the client + use for abort lookups.
  let ashleyRow: Message;
  try {
    const [inserted] = await db
      .insert(messagesTable)
      .values({
        id: newId(),
        deviceId,
        role: "ashley",
        content: "",
        status: "streaming",
        selfieVibe: null,
      })
      .returning();
    ashleyRow = inserted!;
  } catch (err) {
    req.log.error({ err }, "Failed to insert streaming Ashley row");
    res.status(500).json({ error: "Could not start Ashley's reply" });
    return;
  }
  const streamId = ashleyRow.id;

  // ---- Open SSE.
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

  req.log.info(
    { requestId: requestId ?? null, streamId, deviceId, isContinue },
    "chat/stream: opened",
  );

  writeEvent("meta", {
    streamId,
    userMessage: userRow,
    ashleyMessage: ashleyRow,
    mode: isContinue ? "continue" : "new",
    continueFromMessageId: continueFromMessageId ?? null,
    // Echo the client-supplied requestId so the client can validate
    // stream ownership and drop late tokens from mismatched streams.
    requestId: requestId ?? null,
  });

  // ---- HARD GATE: image-intent short-circuit. If the resolver upstream
  //      synthesised a marker, emit caption + done immediately and persist
  //      the row WITH selfieVibe set, bypassing the LLM entirely. The
  //      mobile then polls /chat/selfie/:streamId for the actual image.
  if (imageGateSynth) {
    const gateText = imageGateSynth.captionText;
    const gateVibe = imageGateSynth.selfieVibe;
    writeEvent("delta", { text: gateText });
    try {
      await db
        .update(messagesTable)
        .set({ content: gateText, status: "complete", selfieVibe: gateVibe })
        .where(eq(messagesTable.id, streamId));
      writeEvent("done", { content: gateText, selfieVibe: gateVibe });
      req.log.info(
        {
          streamId,
          deviceId,
          imageMode: imageGateSynth.mode,
          captionPreview: gateText.slice(0, 200),
          descriptionPreview: imageGateSynth.description.slice(0, 200),
        },
        "image-intent: HARD GATE (stream) — marker persisted, selfie pipeline armed",
      );
    } catch (err) {
      req.log.error({ err, streamId }, "image-intent gate (stream): persist failed");
      // Hygiene: don't leave the row stuck in `streaming`. Best-effort
      // mark interrupted so the recovery sweep doesn't keep retrying it.
      try {
        await db
          .update(messagesTable)
          .set({ status: "interrupted" })
          .where(eq(messagesTable.id, streamId));
      } catch (markErr) {
        req.log.warn({ err: markErr, streamId }, "image-intent gate (stream): also failed to mark row interrupted");
      }
      if (!res.writableEnded) writeEvent("error", { error: "Couldn't save reply." });
    } finally {
      inFlightStreams.delete(streamId);
      if (!res.writableEnded) res.end();
    }
    return;
  }

  // ---- Register abort controller.
  const ac = new AbortController();
  inFlightStreams.set(streamId, ac);
  let userAborted = false;
  let clientDisconnected = false;
  req.on("close", () => {
    if (!res.writableEnded) {
      // The browser/expo client closed the SSE connection — treat as a stop.
      clientDisconnected = true;
      ac.abort();
    }
  });

  // ---- Stream from the active chat model (Anthropic by default; Gemini
  //      when ASHLEY_TEXT_PROVIDER=gemini, for cost control).
  let accumulated = "";
  let finishedNaturally = false;
  let upstreamErr: unknown = null;
  // When the response starts with `{` it may be a CREATE_TICKET JSON.
  // Suppress deltas so the raw JSON never renders in the chat bubble —
  // the `done` event (which replaces bubble content entirely) will carry
  // the clean "Issue logged." acknowledgement instead.
  let ticketBuffering = false;

  try {
    for await (const chunk of streamChatText({
      system: finalSystemPrompt,
      messages: claudeMessages,
      maxTokens: 4096,
      signal: ac.signal,
    })) {
      if (chunk.length === 0) continue;
      accumulated += chunk;
      // Only suppress deltas when the response is pure JSON (starts with `{`).
      // If there is conversational preamble before the JSON, deltas are allowed
      // to stream — the `done` event replaces the bubble content entirely, so
      // the raw JSON/preamble is overwritten by the ack anyway.
      if (!ticketBuffering && accumulated.trimStart()[0] === "{") {
        ticketBuffering = true;
      }
      if (!ticketBuffering) {
        writeEvent("delta", { text: chunk });
      }
    }
    finishedNaturally = true;
  } catch (err) {
    // Abort surfaces as APIUserAbortError (or a generic AbortError on the
    // signal). Either way, `ac.signal.aborted` will be true. Treat it as
    // an interruption rather than a hard error.
    if (ac.signal.aborted) {
      userAborted = true;
    } else {
      upstreamErr = err;
      req.log.error({ err }, "Chat model stream failed mid-flight");
    }
  }

  // ---- CREATE_TICKET intercept (streaming path).
  //      Runs unconditionally on every natural completion. extractFirstJsonObject
  //      finds ticket JSON even when conversational preamble was streamed first.
  //      The `done` event replaces the entire bubble, so any preamble deltas
  //      that already rendered are overwritten by the ack text.
  if (finishedNaturally) {
    const parsedStreamTicket = tryParseCreateTicket(accumulated);
    if (parsedStreamTicket) {
      let ackText = "";
      try {
        const ticketId = await insertTicketFromAshley(parsedStreamTicket, req.log);
        ackText = `Issue logged. [${ticketId}]`;
      } catch (err) {
        req.log.error({ err }, "chat/stream: failed to write Ashley ticket to DB");
        ackText = "Issue noted — but logging failed. Please try again.";
      }
      try {
        await db
          .update(messagesTable)
          .set({ content: ackText, status: "complete", selfieVibe: null })
          .where(eq(messagesTable.id, streamId));
        writeEvent("done", { content: ackText, selfieVibe: null });
      } catch (err) {
        req.log.error({ err, streamId }, "chat/stream: failed to persist ticket ack");
        if (!res.writableEnded) writeEvent("error", { error: "Couldn't save reply." });
      } finally {
        inFlightStreams.delete(streamId);
        if (!res.writableEnded) res.end();
      }
      return;
    }
  }

  // ---- Strip image marker on the FINAL accumulated text (mirrors /chat).
  //      We only do this for naturally-finished replies — partials get
  //      stored verbatim so a Continue can flow without losing the marker
  //      that the model may complete on the next pass. selfieVibe column
  //      carries the encoded `MODE|vibe` payload; see imageIntent.ts.
  let finalText = accumulated;
  let selfieVibe: string | null = null;
  if (finishedNaturally) {
    finalText = finalText.trim();
    const parsedMarker = parseImageMarker(finalText);
    if (parsedMarker) {
      selfieVibe = encodeStoredVibe(parsedMarker.mode, parsedMarker.vibe);
      req.log.info(
        {
          imageMode: parsedMarker.mode,
          reason: parsedMarker.reason,
          vibePreview: parsedMarker.vibe.slice(0, 120),
        },
        "image-intent: marker detected in /chat/stream reply",
      );
      const before = finalText.slice(0, parsedMarker.startIndex).trim();
      const after = finalText
        .slice(parsedMarker.startIndex + parsedMarker.length)
        .replace(ANY_IMAGE_MARKER_STRIP_RE, "")
        .trim();
      const joined = [before, after].filter((s) => s.length > 0).join("\n\n");
      finalText = joined;
      if (!finalText) {
        finalText = selfieVibe
          ? "*holds up the camera* one sec…"
          : "*tries to take a selfie but fumbles the camera* one sec — try again?";
      }
    }

    // Phantom-image detector (mirror of /chat). See ../lib/imageFollowUp.ts.
    {
      const phantom = detectPhantomImageDelivery({
        text: finalText,
        hasImageMarker: Boolean(selfieVibe),
        hasDeliveredImageUrl: false,
      });
      req.log.info(
        {
          deviceId,
          streamId,
          imageAttemptState: selfieVibe
            ? "prompt_built"
            : phantom.phantom
              ? "ui_delivery_failed_phantom"
              : "no_image_attempt",
          hasImageMarker: Boolean(selfieVibe),
          phantomDetected: phantom.phantom,
          phantomMatchedPhrase: phantom.phantom ? phantom.matchedPhrase : null,
        },
        "image-attempt: post-stream state",
      );
      if (phantom.phantom) {
        req.log.warn(
          {
            streamId,
            matchedPhrase: phantom.matchedPhrase,
            finalTextPreview: finalText.slice(0, 240),
          },
          "phantom-image: replacing roleplay-only image delivery with diagnostic copy (stream)",
        );
        finalText = PHANTOM_IMAGE_DIAGNOSTIC;
      }
    }

    // Tail-defensive: if the model produced no text at all (shouldn't
    // normally happen), drop in the same fallback /chat uses so the row
    // isn't empty.
    if (!finalText) {
      finalText =
        "*goes quiet for a moment, then smiles softly* sorry — i lost my words there. say that again?";
    }

    // Continuity guard on the fully-assembled text. The client already
    // received the raw delta tokens — the corrected text is delivered via
    // the "done" event's `content` field and the DB row, which is what
    // the mobile's useMessages hydration uses as the canonical value.
    finalText = await guardContinuity(finalText);
  }

  // ---- Persist the final state of the Ashley row + emit terminal event.
  try {
    if (finishedNaturally) {
      await db
        .update(messagesTable)
        .set({
          content: finalText,
          status: "complete",
          selfieVibe,
        })
        .where(eq(messagesTable.id, streamId));
      writeEvent("done", { content: finalText, selfieVibe });
      if (requestId) requestIdempotencyMap.set(requestId, { status: "done", createdAt: Date.now() });
    } else if (userAborted) {
      await db
        .update(messagesTable)
        .set({
          content: accumulated,
          status: "interrupted",
        })
        .where(eq(messagesTable.id, streamId));
      // Only send `interrupted` if the client is still listening. If they
      // disconnected (network drop, app backgrounded), there's no socket
      // to write to — the DB row is the source of truth they'll re-hydrate
      // from.
      if (!clientDisconnected) {
        writeEvent("interrupted", { partialContent: accumulated });
      }
    } else {
      // Genuine upstream error.
      await db
        .update(messagesTable)
        .set({
          content: accumulated,
          status: "interrupted",
        })
        .where(eq(messagesTable.id, streamId));
      writeEvent("error", {
        error: "Couldn't reach the language model — try again or continue.",
      });
    }
  } catch (err) {
    req.log.error(
      { err, streamId, finishedNaturally, userAborted },
      "Failed to finalise streaming Ashley row",
    );
    if (!res.writableEnded) {
      writeEvent("error", { error: "Couldn't save Ashley's reply." });
    }
  } finally {
    inFlightStreams.delete(streamId);
    // If the request didn't finish naturally (error / abort), remove from the
    // idempotency map so the client can retry with the same requestId.
    if (requestId && requestIdempotencyMap.get(requestId)?.status === "pending") {
      requestIdempotencyMap.delete(requestId);
    }
    req.log.info(
      { requestId: requestId ?? null, streamId, finishedNaturally, userAborted, clientDisconnected },
      "chat/stream: closed",
    );
    if (!res.writableEnded) res.end();
  }

  // Fire-and-forget memory distillation. Skip on interruption / error
  // because the partial isn't a useful signal for memories. Skip on
  // continue because we don't have a fresh user message paired with it.
  if (
    finishedNaturally &&
    !isContinue &&
    userRow &&
    finalText &&
    upstreamErr === null
  ) {
    void distillMemories(deviceId, userRow.content, finalText);
    void maybeRollUpOlderMessages(deviceId);
  }
});

router.post(
  "/chat/stream/:streamId/abort",
  async (req, res): Promise<void> => {
    const deviceId = getDeviceId(req);
    const streamId = String(req.params["streamId"] ?? "").trim();
    if (!streamId) {
      res.status(400).json({ error: "streamId is required" });
      return;
    }
    const ac = inFlightStreams.get(streamId);
    if (ac) {
      // Defensive: confirm the streamId actually belongs to this device
      // before letting an abort happen, so a stolen X-API-Key from one
      // device can't kill another device's in-flight reply.
      try {
        const found = await db
          .select({ id: messagesTable.id })
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.id, streamId),
              eq(messagesTable.deviceId, deviceId),
            ),
          )
          .limit(1);
        if (found.length === 0) {
          // Treat unknown-to-this-device as a no-op success (idempotent +
          // doesn't leak existence of other devices' streams).
          res.json({ aborted: false });
          return;
        }
      } catch (err) {
        req.log.error({ err, streamId }, "Abort device check failed");
        res.status(500).json({ error: "Could not abort the stream" });
        return;
      }
      ac.abort();
      res.json({ aborted: true });
      return;
    }
    // No live stream — already finished, never existed, or finished between
    // the client deciding to abort and the request landing. Idempotent OK.
    res.json({ aborted: false });
  },
);

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
    void applyMemoryTriageBackground(deviceId, memories);
  } catch (err) {
    req.log.error({ err }, "Failed to load chat context for image turn");
    res.status(500).json({ error: "Could not load conversation" });
    return;
  }

  // Fetch OPEN tickets for prompt injection (Phase 2.5). Non-fatal.
  let openTickets: Array<{ ticketId: string; summary: string; severity: string; status: string }> = [];
  try {
    openTickets = await db
      .select({
        ticketId: ashleyTicketsTable.ticketId,
        summary: ashleyTicketsTable.summary,
        severity: ashleyTicketsTable.severity,
        status: ashleyTicketsTable.status,
      })
      .from(ashleyTicketsTable)
      .where(eq(ashleyTicketsTable.status, "OPEN"));
  } catch (err) {
    req.log.warn({ err }, "Failed to fetch open tickets for image prompt (non-fatal)");
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
  const systemPrompt = `${timeContext}\n\n${buildSystemPrompt(profile, memories, summaries)}${buildSystemEventsSection()}\n\n${buildOpenTicketsBlock(openTickets)}\n\n${imageAddendum}`;

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

// ---------------------------------------------------------------------------
// POST /chat/tts — Stage 3 of the staged voice plan.
//
// Speaks one of Ashley's replies aloud. The mobile client opt-ins via a
// per-device toggle (AsyncStorage `ashley.voiceReplyEnabled`); when on,
// it POSTs the assistant's reply text here right after the /chat round-
// trip lands and plays the returned audio.
//
// Wire format: request `{ text }`, response `{ audioBase64, mimeType }`
// where `audioBase64` is raw base64 mp3 (no data: URL prefix). We use a
// JSON envelope rather than streaming binary because React Native's
// FileSystem.writeAsStringAsync(..., { encoding: 'base64' }) is the
// path-of-least-resistance for getting bytes onto disk; the ~33% size
// inflation is irrelevant for short TTS audio.
//
// Safety posture:
//   • Auth + deviceId + rate-limit = same chokepoint as every other
//     /chat/* route. No new prompt-bypass surface — this is pure
//     output rendering of text Ashley already produced.
//   • Text capped at 4096 chars (the OpenAI TTS API hard limit) so cost
//     ($0.60/M chars on gpt-4o-mini-tts) and latency are bounded.
//     At ~150 words/min that covers ~2.5 minutes of continuous speech.
//   • TTS failure must NEVER break the chat UX — the client swallows
//     errors here silently (Kane just won't hear that one reply).
//
// Future stages:
//   • Stage 3.5 — per-sentence chunking + sequential playback for
//     snappier perceived start.
//   • Stage 5 — switch to gpt-4o-tts and pass `instructions` built
//     from the voice-presence safety floor (gentler delivery for
//     distress, etc — see contentPolicy.ts).
// ---------------------------------------------------------------------------

const TtsBodySchema = z.object({
  text: z
    .string()
    .min(1, "text is required")
    .max(4096, "text exceeds 4096-char TTS cap"),
});

router.post("/chat/tts", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ error: "X-Device-Id header is required" });
    return;
  }
  const parsed = TtsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid /chat/tts payload",
    });
    return;
  }
  try {
    // Strip asterisk markup before synthesis. The TTS engine silently skips
    // text wrapped in asterisks (*like this*), cutting words from the audio.
    // We keep the inner words so nothing is lost — e.g. "*smiles softly*"
    // becomes "smiles softly" rather than disappearing entirely. Any lone
    // stray asterisks are removed. Leading/trailing whitespace is trimmed.
    const stripped = parsed.data.text
      .replace(/\*([^*]*)\*/g, "$1")
      .replace(/\*/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    // Cap the text sent to the model. gpt-audio generates the full audio
    // buffer before returning, so longer text = longer API wait before the
    // client hears anything. 600 chars ≈ 40-50s of speech at natural pace.
    // Cut at the last sentence boundary so the clip ends cleanly.
    const TTS_CHAR_CAP = 600;
    let ttsText = stripped;
    if (stripped.length > TTS_CHAR_CAP) {
      const window = stripped.slice(0, TTS_CHAR_CAP);
      const lastBoundary = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
        window.lastIndexOf(".\n"),
        window.lastIndexOf("!\n"),
        window.lastIndexOf("?\n"),
      );
      ttsText =
        lastBoundary > TTS_CHAR_CAP / 2
          ? window.slice(0, lastBoundary + 1).trimEnd()
          : window.trimEnd();
    }
    const buf = await synthesizeSpeech(ttsText);
    res.json({
      audioBase64: buf.toString("base64"),
      mimeType: "audio/mpeg",
    });
  } catch (err) {
    req.log.error({ err }, "TTS synthesis failed");
    res.status(502).json({
      error: "Couldn't generate speech — try again.",
    });
  }
});

// POST /messages/:messageId/speech — same synthesis logic as /chat/tts,
// keyed by message id so the server can log which message triggered the
// synthesis. Used by the manual per-message Speak button.
router.post("/messages/:messageId/speech", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  if (!deviceId) {
    res.status(400).json({ error: "X-Device-Id header is required" });
    return;
  }
  const parsed = TtsBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid speech payload",
    });
    return;
  }
  try {
    const stripped = parsed.data.text
      .replace(/\*([^*]*)\*/g, "$1")
      .replace(/\*/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    const TTS_CHAR_CAP = 600;
    let ttsText = stripped;
    if (stripped.length > TTS_CHAR_CAP) {
      const window = stripped.slice(0, TTS_CHAR_CAP);
      const lastBoundary = Math.max(
        window.lastIndexOf(". "),
        window.lastIndexOf("! "),
        window.lastIndexOf("? "),
        window.lastIndexOf(".\n"),
        window.lastIndexOf("!\n"),
        window.lastIndexOf("?\n"),
      );
      ttsText =
        lastBoundary > TTS_CHAR_CAP / 2
          ? window.slice(0, lastBoundary + 1).trimEnd()
          : window.trimEnd();
    }
    const buf = await synthesizeSpeech(ttsText);
    res.json({ audioBase64: buf.toString("base64"), mimeType: "audio/mpeg" });
  } catch (err) {
    req.log.error(
      { err, messageId: req.params.messageId },
      "Message speech synthesis failed",
    );
    res.status(502).json({ error: "Couldn't generate speech — try again." });
  }
});
