// =============================================================================
// Proactive ("Ashley reaches out first") scheduler
// -----------------------------------------------------------------------------
// Periodic worker that decides — for each device with a registered push
// token + non-Off cadence — whether NOW is the moment for Ashley to text
// first, picks a category, generates the message, persists it to chat
// history, and fires the Expo push.
//
// Hard guarantees:
//   - Never throws to the caller (setInterval). Every error is caught and
//     logged; one failing device never breaks the rest of the tick.
//   - Idempotent at the per-device, per-tick level: even if `tickProactive`
//     is invoked twice rapidly, the recent-message guard + global cap will
//     prevent a double send (because the first send wrote a row that the
//     second send sees).
//   - Cheap by default: no Claude call until ALL gates have passed for a
//     specific category candidate.
//   - Ordering is deliberate: medical_checkin → memory_nudge →
//     conversation_gap → routine_support. First eligible wins per tick.
//     medical_checkin is gated OFF in this PR (the medical feature itself
//     hasn't shipped yet) — see SHOULD_SCHEDULE_MEDICAL below.
//
// Cap structure (recap):
//   - Per-category daily cap: 1 / 24h, enforced via `proactive_sends` rows.
//   - Global daily cap: 1 (low) / 2 (normal) / 4 (high), enforced same way.
//   - Recent-message guard: 90 min since ANY message (user or proactive).
//   - Quiet hours: 22:00-08:00 device-local (uses profiles.timezone).
//   - memory_nudge extra: ≥7d since the last memory_nudge (so the same
//     thread isn't re-prodded every day).
//   - conversation_gap extra: ≥24h since the last USER message.
//   - routine_support extra: only fires during the 15:00 hour device-local.
// =============================================================================

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNotNull, ne, sql } from "drizzle-orm";

import {
  db,
  ashleyProfileTable,
  conversationSummariesTable,
  memoriesTable,
  messagesTable,
  proactiveSendsTable,
  PROACTIVE_GLOBAL_CAP_BY_CADENCE,
  type AshleyProfile,
  type ConversationSummary,
  type Memory,
  type Message,
  type ProactiveType,
} from "@workspace/db";

import { logger } from "./logger";
import { generateProactiveMessage } from "./proactiveMessage";
import { sendExpoPush } from "./pushNotifications";

// ----- Tunables ------------------------------------------------------------
const RECENT_MESSAGE_WINDOW_MS = 90 * 60 * 1000; // 90 min
const PER_CATEGORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const MEMORY_NUDGE_RATE_LIMIT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const CONVERSATION_GAP_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const QUIET_HOURS_START = 22; // 22:00 device-local
const QUIET_HOURS_END = 8; // 08:00 device-local (exclusive of 8 itself)
const ROUTINE_SUPPORT_SLOT_HOUR = 15; // 15:xx device-local

// medical_checkin is scaffolded throughout (column, category enum, generator
// branch) but the medical feature itself isn't built yet. This switch keeps
// the scheduler from ever picking the category until that lands. Flip to
// true the moment the medical workflow ships.
const SHOULD_SCHEDULE_MEDICAL = false;

// Push notification UX limits.
const PUSH_TITLE = "Ashley";
const PUSH_BODY_MAX = 100;

// Heuristic for memory_nudge pre-check: does any memory / recent summary
// contain a "thing they wanted to come back to" signal? Keeps us from
// burning a Claude call on devices that obviously have nothing to nudge.
const NUDGE_KEYWORDS_RE =
  /\b(want(?:s|ed)?\s+to|going\s+to|gonna|plan(?:ning)?\s+to|hope\s+to|pick\s+(?:back\s+)?up|come\s+back\s+to|finish|try(?:\s+out)?|start|build|learn|explore|revisit|return\s+to)\b/i;

// ---------------------------------------------------------------------------
// PUBLIC ENTRYPOINTS
// ---------------------------------------------------------------------------

/**
 * Top-level scheduler tick. Called from a setInterval in index.ts.
 * Never throws — all errors are caught & logged. One bad device cannot
 * break the rest of the tick.
 */
export async function tickProactive(): Promise<void> {
  const startedAt = Date.now();
  let candidates: AshleyProfile[] = [];
  try {
    candidates = await db
      .select()
      .from(ashleyProfileTable)
      .where(
        and(
          isNotNull(ashleyProfileTable.pushToken),
          ne(ashleyProfileTable.proactiveCadence, "off"),
        ),
      );
  } catch (err) {
    logger.error({ err }, "Proactive scheduler: failed to load candidates");
    return;
  }

  if (candidates.length === 0) {
    logger.debug("Proactive scheduler tick: no eligible devices");
    return;
  }

  let attempted = 0;
  let sent = 0;
  let skipped = 0;

  for (const profile of candidates) {
    attempted++;
    try {
      const result = await maybeSendForProfile(profile);
      if (result.sent) {
        sent++;
      } else {
        skipped++;
        logger.debug(
          { deviceId: profile.deviceId, reason: result.reason },
          "Proactive scheduler: skipped device",
        );
      }
    } catch (err) {
      logger.error(
        { err, deviceId: profile.deviceId },
        "Proactive scheduler: device failed (caught, continuing)",
      );
    }
  }

  logger.info(
    {
      attempted,
      sent,
      skipped,
      durationMs: Date.now() - startedAt,
    },
    "Proactive scheduler tick complete",
  );
}

/**
 * Force a single device through the scheduler — for the dev-only debug
 * endpoint (`POST /api/proactive/debug-tick`). Returns a detailed result
 * so the caller can introspect why a send did or didn't happen.
 */
export async function forceTickForDevice(
  deviceId: string,
): Promise<TickResult> {
  const [profile] = await db
    .select()
    .from(ashleyProfileTable)
    .where(eq(ashleyProfileTable.deviceId, deviceId))
    .limit(1);
  if (!profile) {
    return { sent: false, reason: "no profile" };
  }
  if (!profile.pushToken) {
    return { sent: false, reason: "no push token" };
  }
  if (profile.proactiveCadence === "off") {
    return { sent: false, reason: "cadence=off" };
  }
  return maybeSendForProfile(profile);
}

// ---------------------------------------------------------------------------
// PER-DEVICE EVALUATION
// ---------------------------------------------------------------------------

export type TickResult =
  | {
      sent: true;
      proactiveType: ProactiveType;
      messageId: string;
      pushOk: boolean;
    }
  | { sent: false; reason: string };

// ---------------------------------------------------------------------------
// PER-DEVICE MUTEX
// ---------------------------------------------------------------------------
// `maybeSendForProfile` does a multi-step read-check-write:
//   1. Read recent messages + proactiveSends rows.
//   2. Decide if this device is eligible (caps, guards, quiet hours).
//   3. Generate a Claude reply (slow — multi-second).
//   4. Insert message row + proactiveSends row + send the push.
//
// Between steps 1 and 4 nothing prevents a SECOND concurrent invocation
// for the same device from passing the same gates and double-sending.
// Realistic ways this can happen:
//   • setInterval tick takes >5min (Claude latency spike) and overlaps
//     with the next tick.
//   • A debug-tick HTTP call lands while the regular tick is mid-flight
//     for that device.
//   • Future: multiple node processes (we'd then need a DB advisory
//     lock — flagged in replit.md follow-ups).
//
// Single-process mutex: a per-deviceId Map of in-flight promises. Any
// second caller for the same device is rejected immediately rather than
// queued — queuing would just defer the duplicate and still violate the
// cap once the first resolves. The cleanup runs in `finally` so a
// crashed device evaluation doesn't deadlock the slot.
const deviceLocks = new Map<string, Promise<TickResult>>();

async function maybeSendForProfile(profile: AshleyProfile): Promise<TickResult> {
  const existing = deviceLocks.get(profile.deviceId);
  if (existing) {
    // Don't await — that would queue the duplicate and still write twice.
    return { sent: false, reason: "concurrent_tick_in_progress" };
  }
  const work = (async () => evaluateAndSend(profile))();
  deviceLocks.set(profile.deviceId, work);
  try {
    return await work;
  } finally {
    deviceLocks.delete(profile.deviceId);
  }
}

async function evaluateAndSend(
  profile: AshleyProfile,
): Promise<TickResult> {
  const now = new Date();

  // ---- Gate 1: Quiet hours ----------------------------------------------
  if (isWithinQuietHours(now, profile.timezone)) {
    return { sent: false, reason: "quiet_hours" };
  }

  // ---- Gate 2: Recent message guard (any direction) ---------------------
  const recentMessage = await getMostRecentMessage(profile.deviceId);
  if (
    recentMessage &&
    now.getTime() - recentMessage.createdAt.getTime() < RECENT_MESSAGE_WINDOW_MS
  ) {
    return { sent: false, reason: "recent_message" };
  }

  // ---- Gate 3: Global daily cap -----------------------------------------
  const cadence = profile.proactiveCadence;
  if (cadence === "off") {
    // Defensive: candidate query already excludes this, but never trust.
    return { sent: false, reason: "cadence=off" };
  }
  const globalCap = PROACTIVE_GLOBAL_CAP_BY_CADENCE[cadence as "low" | "normal" | "high"] ?? 0;
  if (globalCap === 0) {
    return { sent: false, reason: `unknown cadence: ${cadence}` };
  }
  const sentInLast24h = await countProactiveSendsSince(
    profile.deviceId,
    new Date(now.getTime() - GLOBAL_WINDOW_MS),
  );
  if (sentInLast24h >= globalCap) {
    return { sent: false, reason: `global_cap_hit (${sentInLast24h}/${globalCap})` };
  }

  // ---- Build the per-device context once (used for category eligibility +
  // the message generator). One DB round trip instead of two.
  const [memories, summaries, recentHistory, recentSends] = await Promise.all([
    db
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.deviceId, profile.deviceId)),
    db
      .select()
      .from(conversationSummariesTable)
      .where(eq(conversationSummariesTable.deviceId, profile.deviceId)),
    // Most recent ~30 messages, oldest-first for the prompt.
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.deviceId, profile.deviceId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(30),
    // All proactive sends in the last 7 days — covers per-category cap
    // (24h) AND memory_nudge rate limit (7d) in one query.
    db
      .select()
      .from(proactiveSendsTable)
      .where(
        and(
          eq(proactiveSendsTable.deviceId, profile.deviceId),
          gte(
            proactiveSendsTable.sentAt,
            new Date(now.getTime() - MEMORY_NUDGE_RATE_LIMIT_MS),
          ),
        ),
      ),
  ]);
  recentHistory.reverse();

  // ---- Walk categories in priority order, first eligible wins -----------
  const candidateCategories: ProactiveType[] = [
    "medical_checkin",
    "memory_nudge",
    "conversation_gap",
    "routine_support",
  ];

  for (const category of candidateCategories) {
    const eligibility = isCategoryEligible({
      category,
      profile,
      now,
      memories,
      summaries,
      recentSends,
      mostRecentUserMessageAt: mostRecentUserMessageAt(recentHistory),
    });
    if (!eligibility.ok) continue;

    // Hours of silence (only meaningful for conversation_gap; passed for
    // all categories so the generator can vary tone if it wants).
    const lastUserAt = mostRecentUserMessageAt(recentHistory);
    const hoursOfSilence = lastUserAt
      ? (now.getTime() - lastUserAt.getTime()) / (60 * 60 * 1000)
      : 0;

    // Generate the message. Empty string = "model declined" → fall through
    // to next category (don't burn the cap on an aborted send).
    const text = await generateProactiveMessage({
      profile,
      history: recentHistory,
      memories,
      summaries,
      category,
      hoursOfSilence,
    });
    if (!text) {
      logger.info(
        { deviceId: profile.deviceId, category },
        "Proactive generator returned empty — falling through",
      );
      continue;
    }

    // Persist + push. If the message insert fails we abort the device for
    // this tick (don't try the next category — the DB is the problem).
    const messageId = randomUUID();
    try {
      await db.insert(messagesTable).values({
        id: messageId,
        deviceId: profile.deviceId,
        role: "ashley",
        content: text,
        status: "complete",
        source: "proactive",
        proactiveType: category,
      });
      await db.insert(proactiveSendsTable).values({
        id: randomUUID(),
        deviceId: profile.deviceId,
        messageId,
        proactiveType: category,
      });
    } catch (err) {
      logger.error(
        { err, deviceId: profile.deviceId, category },
        "Failed to persist proactive message — aborting device for this tick",
      );
      return { sent: false, reason: "persist_failed" };
    }

    // Fire the push. Never blocks success — the message is already in chat
    // and will appear next time Kane opens the app even if the push fails.
    const pushBody = truncateForPush(text);
    const pushResult = await sendExpoPush({
      to: profile.pushToken!,
      title: PUSH_TITLE,
      body: pushBody,
      data: {
        kind: "proactive",
        proactiveType: category,
        messageId,
        route: "/chat",
      },
    });

    if (!pushResult.ok && pushResult.tokenInvalid) {
      // Token is dead at the OS level — clear it so we stop trying. The
      // mobile app will re-register on next launch.
      try {
        await db
          .update(ashleyProfileTable)
          .set({ pushToken: null })
          .where(eq(ashleyProfileTable.deviceId, profile.deviceId));
        logger.warn(
          { deviceId: profile.deviceId },
          "Cleared invalid push token after Expo error",
        );
      } catch (err) {
        logger.error(
          { err, deviceId: profile.deviceId },
          "Failed to clear invalid push token",
        );
      }
    }

    return {
      sent: true,
      proactiveType: category,
      messageId,
      pushOk: pushResult.ok,
    };
  }

  return { sent: false, reason: "no_eligible_category" };
}

// ---------------------------------------------------------------------------
// CATEGORY ELIGIBILITY
// ---------------------------------------------------------------------------

type EligibilityArgs = {
  category: ProactiveType;
  profile: AshleyProfile;
  now: Date;
  memories: Memory[];
  summaries: ConversationSummary[];
  recentSends: Array<{
    proactiveType: string;
    sentAt: Date;
  }>;
  mostRecentUserMessageAt: Date | null;
};

function isCategoryEligible(
  args: EligibilityArgs,
): { ok: true } | { ok: false; reason: string } {
  const { category, now, memories, summaries, recentSends, mostRecentUserMessageAt } =
    args;

  // Per-category daily cap: have we already sent THIS category in the last
  // 24h? Applies to every category.
  const lastForCategory = recentSends
    .filter((s) => s.proactiveType === category)
    .reduce<Date | null>(
      (acc, s) => (acc === null || s.sentAt > acc ? s.sentAt : acc),
      null,
    );
  if (
    lastForCategory &&
    now.getTime() - lastForCategory.getTime() < PER_CATEGORY_WINDOW_MS
  ) {
    return { ok: false, reason: `category_cap_${category}` };
  }

  switch (category) {
    case "medical_checkin": {
      if (!SHOULD_SCHEDULE_MEDICAL) {
        return { ok: false, reason: "medical_feature_not_built" };
      }
      // When the medical feature lands: eligible iff lastMedicalCheckinAt
      // is null OR before today (device-local). For now this branch is
      // unreachable.
      return { ok: false, reason: "medical_feature_not_built" };
    }

    case "memory_nudge": {
      // Extra rate-limit: 7d since last memory_nudge (so we don't keep
      // prodding the same thread). This is on top of the 1/day per-cat cap.
      if (
        lastForCategory &&
        now.getTime() - lastForCategory.getTime() < MEMORY_NUDGE_RATE_LIMIT_MS
      ) {
        return { ok: false, reason: "memory_nudge_rate_limit" };
      }
      // Cheap pre-check: do any memories or recent summaries contain a
      // "wanted to come back to" signal? Saves a Claude call on devices
      // that obviously have nothing to nudge. The model is still the
      // final arbiter (returns SKIP if nothing fits).
      const corpus = [
        ...memories.map((m) => m.content),
        ...summaries.slice(-5).map((s) => s.summary),
      ].join("\n");
      if (!NUDGE_KEYWORDS_RE.test(corpus)) {
        return { ok: false, reason: "no_nudgeable_item" };
      }
      return { ok: true };
    }

    case "conversation_gap": {
      // Eligible only after ≥24h of user silence. Uses the most recent
      // USER message (not any message) so a previous proactive send by
      // Ashley doesn't count as "they spoke recently".
      if (!mostRecentUserMessageAt) {
        // No user history at all — skip. We don't want Ashley reaching
        // out before the user has even said hello.
        return { ok: false, reason: "no_user_history" };
      }
      if (
        now.getTime() - mostRecentUserMessageAt.getTime() <
        CONVERSATION_GAP_THRESHOLD_MS
      ) {
        return { ok: false, reason: "user_spoke_recently" };
      }
      return { ok: true };
    }

    case "routine_support": {
      // Soft wellbeing nudges only fire in the 15:00 hour device-local so
      // they don't compete with morning/evening rhythms.
      const hour = deviceLocalHour(now, args.profile.timezone);
      if (hour !== ROUTINE_SUPPORT_SLOT_HOUR) {
        return { ok: false, reason: `routine_slot (now=${hour})` };
      }
      return { ok: true };
    }

    case "app_open_greeting": {
      // Never scheduled — only triggered by POST /api/proactive/on-app-open.
      // The branch exists for TypeScript exhaustiveness only.
      return { ok: false, reason: "scheduler_disabled_for_app_open" };
    }
  }
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function isWithinQuietHours(now: Date, timezone: string): boolean {
  const hour = deviceLocalHour(now, timezone);
  // Quiet hours wrap midnight: 22, 23, 0..7 are quiet; 8..21 are awake.
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

async function getMostRecentMessage(deviceId: string): Promise<Message | null> {
  const [row] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.deviceId, deviceId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(1);
  return row ?? null;
}

function mostRecentUserMessageAt(history: Message[]): Date | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role === "user") return m.createdAt;
  }
  return null;
}

async function countProactiveSendsSince(
  deviceId: string,
  since: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(proactiveSendsTable)
    .where(
      and(
        eq(proactiveSendsTable.deviceId, deviceId),
        gte(proactiveSendsTable.sentAt, since),
      ),
    );
  return row?.n ?? 0;
}

function truncateForPush(text: string): string {
  // Strip line breaks first so the preview reads as a single line.
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= PUSH_BODY_MAX) return flat;
  return `${flat.slice(0, PUSH_BODY_MAX - 1).trimEnd()}…`;
}
