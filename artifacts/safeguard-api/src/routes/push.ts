/**
 * Web Push subscription + reminder tick endpoints.
 *
 * - `GET  /me/push/public-key` — returns VAPID public key (and whether push
 *   is configured server-side at all). The client uses this to subscribe.
 * - `POST /me/push/subscribe` — register/refresh a browser subscription.
 * - `DELETE /me/push/subscribe` — remove a subscription by endpoint.
 * - `POST /reminders/tick` — fire-now-due reminders. Mounted OUTSIDE the
 *   Clerk gate in `app.ts`; auth is `X-Reminder-Cron-Secret` matching the
 *   `REMINDER_CRON_SECRET` env var.
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import {
  db,
  safeguardPushSubscriptionsTable,
  safeguardProfilesTable,
} from "@workspace/db";
import {
  getVapidPublicKey,
  isPushConfigured,
  runReminderTick,
} from "../lib/reminderWorker";

const router: IRouter = Router();

router.get("/me/push/public-key", (_req, res) => {
  res.json({
    publicKey: getVapidPublicKey(),
    configured: isPushConfigured(),
  });
});

const SubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(500),
    auth: z.string().min(1).max(500),
  }),
  userAgent: z.string().max(500).optional(),
});

router.post("/me/push/subscribe", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const parsed = SubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    // Snapshot the user's preferred language so the worker doesn't have
    // to hit the profile table on every send.
    const profileRows = await db
      .select({ lang: safeguardProfilesTable.preferredLanguage })
      .from(safeguardProfilesTable)
      .where(eq(safeguardProfilesTable.userId, userId));
    const lang = profileRows[0]?.lang ?? "en";

    const now = new Date();
    // Manual upsert keyed on (userId, endpoint). Drizzle's onConflict needs
    // a real unique constraint; we don't have one in production yet, so do
    // a check-then-insert/update.
    const existing = await db
      .select({ id: safeguardPushSubscriptionsTable.id })
      .from(safeguardPushSubscriptionsTable)
      .where(
        and(
          eq(safeguardPushSubscriptionsTable.userId, userId),
          eq(safeguardPushSubscriptionsTable.endpoint, parsed.data.endpoint),
        ),
      );
    if (existing[0]) {
      await db
        .update(safeguardPushSubscriptionsTable)
        .set({
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          lang,
          userAgent: parsed.data.userAgent ?? "",
          lastSeenAt: now,
        })
        .where(eq(safeguardPushSubscriptionsTable.id, existing[0].id));
      res.json({ subscriptionId: existing[0].id, refreshed: true });
      return;
    }
    const [row] = await db
      .insert(safeguardPushSubscriptionsTable)
      .values({
        userId,
        endpoint: parsed.data.endpoint,
        p256dh: parsed.data.keys.p256dh,
        auth: parsed.data.keys.auth,
        lang,
        userAgent: parsed.data.userAgent ?? "",
      })
      .returning({ id: safeguardPushSubscriptionsTable.id });
    res.json({ subscriptionId: row?.id ?? null, refreshed: false });
  } catch (err) {
    next(err);
  }
});

const UnsubscribeBody = z.object({
  endpoint: z.string().url().max(2000),
});

router.delete("/me/push/subscribe", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const parsed = UnsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    await db
      .delete(safeguardPushSubscriptionsTable)
      .where(
        and(
          eq(safeguardPushSubscriptionsTable.userId, userId),
          eq(safeguardPushSubscriptionsTable.endpoint, parsed.data.endpoint),
        ),
      );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get("/me/push/subscriptions", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rows = await db
      .select({
        id: safeguardPushSubscriptionsTable.id,
        endpoint: safeguardPushSubscriptionsTable.endpoint,
        userAgent: safeguardPushSubscriptionsTable.userAgent,
        createdAt: safeguardPushSubscriptionsTable.createdAt,
        lastSeenAt: safeguardPushSubscriptionsTable.lastSeenAt,
      })
      .from(safeguardPushSubscriptionsTable)
      .where(eq(safeguardPushSubscriptionsTable.userId, userId));
    res.json({ subscriptions: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * Public cron endpoint. Auth is a shared secret in the
 * `X-Reminder-Cron-Secret` header. Mounted outside the Clerk gate in
 * `app.ts` so external schedulers can call it without a JWT.
 */
export function reminderTickHandler(): IRouter {
  const r: IRouter = Router();
  r.post("/reminders/tick", async (req, res, next) => {
    try {
      const expected = process.env["REMINDER_CRON_SECRET"];
      if (!expected) {
        res.status(503).json({ error: "tick_disabled" });
        return;
      }
      const provided = req.header("x-reminder-cron-secret") ?? "";
      if (provided !== expected) {
        res.status(401).json({ error: "invalid_secret" });
        return;
      }
      const result = await runReminderTick();
      res.json(result);
    } catch (err) {
      next(err);
    }
  });
  return r;
}

export default router;
