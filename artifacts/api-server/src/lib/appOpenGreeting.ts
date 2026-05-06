// =============================================================================
// On-app-open greeting
// -----------------------------------------------------------------------------
// Server-side decision + generator for "say hi when the user opens the app".
// Mobile pings POST /api/proactive/on-app-open on every cold launch /
// foreground resume; this module is the gate + generator.
//
// Design notes:
//   - Independent from the push scheduler. The cadence selector governs
//     PUSHED messages while the user is away. This greeting only fires while
//     the user is actively opening the app, so it has its own profile flag
//     (`greetOnAppOpen`) and its own dedupe window.
//   - Reuses `generateProactiveMessage` so Ashley's voice + persona stack is
//     identical to a normal turn (and the universal guardrails — no clingy,
//     no emergency language — apply too).
//   - No push notification: the user is already looking at the app. The
//     in-foreground notification listener also drops the push surface for
//     this category to keep things quiet.
//   - Cap audit row written to `proactive_sends` so the 4h dedupe is durable
//     across server restarts and so a future history wipe doesn't reset it.
// =============================================================================

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";

import {
  db,
  ashleyProfileTable,
  conversationSummariesTable,
  memoriesTable,
  messagesTable,
  proactiveSendsTable,
  type Message,
} from "@workspace/db";

import { logger } from "./logger";
import { generateProactiveMessage } from "./proactiveMessage";

// Tunables ---------------------------------------------------------------------
// Don't greet if the user/Ashley exchanged anything in the last MIN_GAP — that
// way closing-then-reopening the app a minute later doesn't trigger a hi.
const MIN_MESSAGE_GAP_MS = 4 * 60 * 60 * 1000; // 4h
// Don't fire two greetings within this window even if other gates pass.
const GREETING_DEDUPE_MS = 4 * 60 * 60 * 1000; // 4h
// Quiet hours, mirrored from the scheduler — silent greetings overnight feel
// just as wrong as silent push notifications would.
const QUIET_HOURS_START = 22;
const QUIET_HOURS_END = 8;

export type GreetingResult =
  | { greeted: false; reason: string }
  | { greeted: true; message: Message };

/**
 * Evaluate gates for `deviceId` and, if eligible, generate + persist a fresh
 * "welcome back" message in Ashley's voice. Returns the new message row on
 * success, or `{ greeted: false, reason }` for any skip (toggle off, recent
 * activity, dedupe, quiet hours, model declined, etc).
 *
 * Never throws — all errors are caught and surfaced as a `greeted: false`
 * result so a transient failure can never break the app's cold-start path.
 */
export async function maybeGenerateAppOpenGreeting(
  deviceId: string,
): Promise<GreetingResult> {
  let profile;
  try {
    [profile] = await db
      .select()
      .from(ashleyProfileTable)
      .where(eq(ashleyProfileTable.deviceId, deviceId))
      .limit(1);
  } catch (err) {
    logger.warn({ err, deviceId }, "appOpenGreeting: profile lookup failed");
    return { greeted: false, reason: "profile_lookup_failed" };
  }
  if (!profile) return { greeted: false, reason: "no_profile" };
  if (profile.greetOnAppOpen === false) {
    return { greeted: false, reason: "toggle_off" };
  }

  const now = new Date();

  // Quiet hours — same wrap-midnight logic the scheduler uses.
  if (isWithinQuietHours(now, profile.timezone)) {
    return { greeted: false, reason: "quiet_hours" };
  }

  // Dedupe: one greeting per 4h window, durable in proactive_sends.
  try {
    const [recentGreeting] = await db
      .select()
      .from(proactiveSendsTable)
      .where(
        and(
          eq(proactiveSendsTable.deviceId, deviceId),
          eq(proactiveSendsTable.proactiveType, "app_open_greeting"),
          gte(
            proactiveSendsTable.sentAt,
            new Date(now.getTime() - GREETING_DEDUPE_MS),
          ),
        ),
      )
      .limit(1);
    if (recentGreeting) {
      return { greeted: false, reason: "greeting_dedupe" };
    }
  } catch (err) {
    logger.warn({ err, deviceId }, "appOpenGreeting: dedupe lookup failed");
    return { greeted: false, reason: "dedupe_lookup_failed" };
  }

  // Pull recent context for the message generator. Same window the scheduler
  // uses so Ashley has the same texture to react to.
  let memories;
  let summaries;
  let recentHistory;
  try {
    [memories, summaries, recentHistory] = await Promise.all([
      db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.deviceId, deviceId)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId)),
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.deviceId, deviceId))
        .orderBy(desc(messagesTable.createdAt))
        .limit(30),
    ]);
  } catch (err) {
    logger.warn({ err, deviceId }, "appOpenGreeting: context lookup failed");
    return { greeted: false, reason: "context_lookup_failed" };
  }

  // Min-gap: don't greet a session that's been actively chatting.
  const mostRecent = recentHistory[0]; // desc, so [0] is newest
  if (
    mostRecent &&
    now.getTime() - mostRecent.createdAt.getTime() < MIN_MESSAGE_GAP_MS
  ) {
    return { greeted: false, reason: "recent_activity" };
  }

  // Don't greet a fresh install with zero history — feels jarring to launch
  // the app for the first time and immediately get a "welcome back".
  const hasUserMessage = recentHistory.some((m) => m.role === "user");
  if (!hasUserMessage) {
    return { greeted: false, reason: "no_user_history" };
  }

  // Generator wants oldest-first.
  recentHistory.reverse();
  const lastUserAt = mostRecentUserMessageAt(recentHistory);
  const hoursOfSilence = lastUserAt
    ? (now.getTime() - lastUserAt.getTime()) / (60 * 60 * 1000)
    : 0;

  const text = await generateProactiveMessage({
    profile,
    history: recentHistory,
    memories,
    summaries,
    category: "app_open_greeting",
    hoursOfSilence,
  });
  if (!text) {
    return { greeted: false, reason: "model_declined" };
  }

  const messageId = randomUUID();
  let inserted: Message | undefined;
  try {
    [inserted] = await db
      .insert(messagesTable)
      .values({
        id: messageId,
        deviceId,
        role: "ashley",
        content: text,
        status: "complete",
        source: "proactive",
        proactiveType: "app_open_greeting",
      })
      .returning();
    await db.insert(proactiveSendsTable).values({
      id: randomUUID(),
      deviceId,
      messageId,
      proactiveType: "app_open_greeting",
    });
  } catch (err) {
    logger.error(
      { err, deviceId },
      "appOpenGreeting: failed to persist greeting",
    );
    return { greeted: false, reason: "persist_failed" };
  }

  if (!inserted) {
    return { greeted: false, reason: "persist_failed" };
  }

  return { greeted: true, message: inserted };
}

// -----------------------------------------------------------------------------
// Helpers (mirrored from proactiveScheduler — kept inline so this module stays
// self-contained and the scheduler can keep its private helpers private).
// -----------------------------------------------------------------------------

function isWithinQuietHours(now: Date, timezone: string): boolean {
  const hour = deviceLocalHour(now, timezone);
  if (hour >= QUIET_HOURS_START) return true;
  if (hour < QUIET_HOURS_END) return true;
  return false;
}

function deviceLocalHour(now: Date, timezone: string): number {
  const safeTz = timezone && timezone.length <= 64 ? timezone : "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: safeTz,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour")?.value ?? "0";
    return Number.parseInt(h, 10);
  } catch {
    return now.getUTCHours();
  }
}

function mostRecentUserMessageAt(history: Message[]): Date | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") return m.createdAt;
  }
  return null;
}
