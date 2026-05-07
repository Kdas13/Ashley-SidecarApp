/**
 * Reminder worker. Walks `safeguard_followups` rows whose `next_reminder_at`
 * is due, sends a Web-Push notification to every subscription belonging to
 * the user, advances `next_reminder_at` per the cadence rule, and writes
 * an audit row to `safeguard_reminder_sends` for de-duplication.
 *
 * The worker is started in-process from `index.ts` (one tick per minute)
 * and is also exposed as `POST /reminders/tick` so an external cron can
 * invoke it. Both paths call `runReminderTick()`.
 */

import {
  db,
  safeguardFollowupsTable,
  safeguardPushSubscriptionsTable,
  safeguardReminderSendsTable,
  safeguardProfilesTable,
} from "@workspace/db";
import { and, eq, isNull, lte } from "drizzle-orm";
import webpush, { type PushSubscription } from "web-push";
import { logger } from "./logger";
import {
  type Cadence,
  nthReminderAt,
  parseCadence,
} from "./reminderScheduler";

const VAPID_PUBLIC = process.env["VAPID_PUBLIC_KEY"] ?? "";
const VAPID_PRIVATE = process.env["VAPID_PRIVATE_KEY"] ?? "";
const VAPID_SUBJECT =
  process.env["VAPID_SUBJECT"] ?? "mailto:safeguard-pilot@example.org";

let vapidConfigured = false;
function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  vapidConfigured = true;
  return true;
}

export function getVapidPublicKey(): string {
  return VAPID_PUBLIC;
}

export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}

interface NotificationPayload {
  followupId: string;
  kind: string;
  title: string;
  body: string;
  // The clinician's original wording — the SW puts this one tap away.
  original: string;
  url: string;
}

function buildPayload(
  followup: typeof safeguardFollowupsTable.$inferSelect,
  preferredLang: string,
): NotificationPayload {
  const useTranslated = followup.targetLang === preferredLang;
  const title = useTranslated
    ? followup.titleTranslated || followup.titleOriginal
    : followup.titleOriginal;
  const body = useTranslated
    ? followup.detailTranslated ||
      followup.plainExplanation ||
      followup.detailOriginal
    : followup.detailOriginal || followup.plainExplanation;
  const original = `${followup.titleOriginal}${
    followup.detailOriginal ? ` — ${followup.detailOriginal}` : ""
  }`;
  return {
    followupId: followup.id,
    kind: followup.kind,
    title,
    body,
    original,
    // Include the followup id so the patient lands on this exact item
    // when they tap the notification, and so "View clinician's words"
    // can auto-open the original wording for the right row.
    url: `/appointments/${followup.appointmentId}/followup?fid=${encodeURIComponent(followup.id)}`,
  };
}

async function sendToSubscriptions(
  userId: string,
  payload: NotificationPayload,
): Promise<{ delivered: number; pruned: number }> {
  if (!ensureVapid()) return { delivered: 0, pruned: 0 };
  const subs = await db
    .select()
    .from(safeguardPushSubscriptionsTable)
    .where(eq(safeguardPushSubscriptionsTable.userId, userId));
  let delivered = 0;
  let pruned = 0;
  const json = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      const sub: PushSubscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      };
      try {
        await webpush.sendNotification(sub, json, { TTL: 60 * 60 });
        delivered += 1;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        // Push service tells us the subscription is gone.
        if (status === 404 || status === 410) {
          await db
            .delete(safeguardPushSubscriptionsTable)
            .where(eq(safeguardPushSubscriptionsTable.id, s.id));
          pruned += 1;
        } else {
          logger.warn(
            { err, endpointHash: s.id },
            "web push send failed",
          );
        }
      }
    }),
  );
  return { delivered, pruned };
}

interface TickResult {
  considered: number;
  fired: number;
  delivered: number;
  pruned: number;
  errors: number;
}

/**
 * One pass of the worker. Idempotent: re-running with no time elapsed is
 * a no-op because `nextReminderAt` is advanced or nulled on every fire,
 * and `safeguard_reminder_sends` carries the scheduled-slot dedup key.
 */
export async function runReminderTick(now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = {
    considered: 0,
    fired: 0,
    delivered: 0,
    pruned: 0,
    errors: 0,
  };
  // If push isn't configured, we can't deliver anything. Bail out BEFORE
  // touching `next_reminder_at` so schedules don't silently drain on a
  // misconfigured deployment — the next tick after VAPID is set will
  // catch up the same backlog.
  if (!ensureVapid()) {
    return result;
  }
  const due = await db
    .select()
    .from(safeguardFollowupsTable)
    .where(
      and(
        eq(safeguardFollowupsTable.remindersEnabled, true),
        isNull(safeguardFollowupsTable.completedAt),
        // nextReminderAt set and in the past
        lte(safeguardFollowupsTable.nextReminderAt, now),
      ),
    )
    .limit(200);
  result.considered = due.length;
  if (due.length === 0) return result;

  // Group by user so we can look up the preferred language once.
  const byUser = new Map<string, typeof due>();
  for (const row of due) {
    const arr = byUser.get(row.userId) ?? [];
    arr.push(row);
    byUser.set(row.userId, arr);
  }

  for (const [userId, rows] of byUser) {
    const profileRows = await db
      .select({ lang: safeguardProfilesTable.preferredLanguage })
      .from(safeguardProfilesTable)
      .where(eq(safeguardProfilesTable.userId, userId));
    const preferredLang = profileRows[0]?.lang ?? "en";

    for (const row of rows) {
      const scheduledFor = row.nextReminderAt;
      if (!scheduledFor) continue;
      try {
        // Atomic dedup: claim the slot by inserting first. The unique
        // index on (followup_id, scheduled_for) makes a concurrent ticker
        // (in-process + cron, multi-instance, etc.) lose the race
        // cleanly. `onConflictDoNothing().returning()` returns an empty
        // array when another worker already claimed the slot — in which
        // case we do NOT touch this row. The other worker owns both the
        // send AND the advancement of `next_reminder_at`, otherwise both
        // workers would skip a slot.
        const claimed = await db
          .insert(safeguardReminderSendsTable)
          .values({
            followupId: row.id,
            userId,
            scheduledFor,
            success: false,
            deliveredCount: 0,
            errorMessage: "",
          })
          .onConflictDoNothing({
            target: [
              safeguardReminderSendsTable.followupId,
              safeguardReminderSendsTable.scheduledFor,
            ],
          })
          .returning({ id: safeguardReminderSendsTable.id });

        if (!claimed[0]) {
          // Lost the race; another worker is handling this slot.
          continue;
        }

        const payload = buildPayload(row, preferredLang);
        let delivered = 0;
        let pruned = 0;
        let success = true;
        let errorMessage = "";
        try {
          const sent = await sendToSubscriptions(userId, payload);
          delivered = sent.delivered;
          pruned = sent.pruned;
          result.delivered += delivered;
          result.pruned += pruned;
          result.fired += 1;
          success = delivered > 0 || pruned > 0;
        } catch (err) {
          success = false;
          errorMessage = (err as Error).message ?? "send failed";
          result.errors += 1;
        }
        await db
          .update(safeguardReminderSendsTable)
          .set({ success, deliveredCount: delivered, errorMessage })
          .where(eq(safeguardReminderSendsTable.id, claimed[0].id));

        // Advance nextReminderAt only after we've successfully claimed
        // the slot. Delivery success is intentionally NOT a precondition:
        // we slide to the next slot rather than retry a missed minute,
        // but we never skip a slot just because a sibling tick won the
        // claim.
        const cadence = parseCadence(row.cadence);
        const next = nextSlotAfter(cadence, row.reminderCount + 1);
        await db
          .update(safeguardFollowupsTable)
          .set({
            nextReminderAt: next,
            reminderCount: row.reminderCount + 1,
          })
          .where(eq(safeguardFollowupsTable.id, row.id));
      } catch (err) {
        result.errors += 1;
        logger.error({ err, followupId: row.id }, "reminder tick error");
      }
    }
  }
  return result;
}

function nextSlotAfter(cadence: Cadence, alreadySent: number): Date | null {
  return nthReminderAt(cadence, alreadySent);
}

let intervalHandle: NodeJS.Timeout | null = null;

/** Start the in-process tick. Called once from `index.ts`. */
export function startReminderWorker(): void {
  if (intervalHandle) return;
  if (!isPushConfigured()) {
    logger.warn(
      "reminder worker NOT started — VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY missing",
    );
    return;
  }
  const TICK_MS = 60_000;
  const tick = (): void => {
    runReminderTick().catch((err) => {
      logger.error({ err }, "reminder tick crashed");
    });
  };
  intervalHandle = setInterval(tick, TICK_MS);
  // Fire one immediately so cold-start slack doesn't hold reminders.
  tick();
  logger.info({ tickMs: TICK_MS }, "reminder worker started");
}

