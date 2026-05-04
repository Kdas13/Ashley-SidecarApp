import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  ashleyProfileTable,
  conversationSummariesTable,
  memoriesTable,
  messagesTable,
} from "@workspace/db";

import { getDeviceId } from "../middleware/deviceId";
import { getOrCreateProfileFor } from "../lib/profile";
import {
  getPolicyFor,
  isMatureModeAvailable,
  validatePolicyPatch,
  INTIMACY_MIN,
  INTIMACY_MAX,
} from "../lib/contentPolicy";

const router: IRouter = Router();

const MAX_FIELD_LEN = 4000;
const MAX_LARGE_FIELD_LEN = 16000;

const ProfileUpdateSchema = z
  .object({
    name: z.string().max(MAX_FIELD_LEN).optional(),
    age: z.string().max(MAX_FIELD_LEN).optional(),
    identity: z.string().max(MAX_FIELD_LEN).optional(),
    personality: z.string().max(MAX_FIELD_LEN).optional(),
    speakingStyle: z.string().max(MAX_FIELD_LEN).optional(),
    appearance: z.string().max(MAX_FIELD_LEN).optional(),
    refersToUserAs: z.string().max(120).optional(),
    sharedHistory: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    replikaExcerpts: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    // Raw structured carryover (JSON-encoded). Allowed up to 64KB so
    // large pasted excerpts fit comfortably.
    replikaCarryover: z.string().max(64_000).optional(),
    replikaCarryoverSummary: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    relationshipMode: z.string().max(120).optional(),
    builderAwareMode: z.boolean().optional(),
    voiceMode: z.boolean().optional(),
    // 18+ / Mature scaffolding. These pass through validatePolicyPatch
    // (lib/contentPolicy.ts) before hitting the database — the zod shape
    // here only enforces the wire types, the policy module enforces the
    // gating (server flag, age confirmation, intimacy ceiling).
    contentMode: z.enum(["standard", "mature"]).optional(),
    intimacyLevel: z
      .number()
      .int()
      .min(INTIMACY_MIN)
      .max(INTIMACY_MAX)
      .optional(),
    primaryColor: z.string().max(32).optional(),
    accentColor: z.string().max(32).optional(),
    markOnboarded: z.boolean().optional(),
  })
  .strict();

// One-shot hydration endpoint. Returns everything the mobile app needs to
// render the chat from a cold start: profile, full message history, all
// memories, all rolling summaries.  The client uses this on app boot and
// after pull-to-refresh.
router.get("/state", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  try {
    const profile = await getOrCreateProfileFor(deviceId);
    const policy = getPolicyFor(profile);
    const [messages, memories, summaries] = await Promise.all([
      db
        .select()
        .from(messagesTable)
        .where(eq(messagesTable.deviceId, deviceId))
        .orderBy(asc(messagesTable.createdAt)),
      db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.deviceId, deviceId))
        .orderBy(asc(memoriesTable.createdAt)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId))
        .orderBy(asc(conversationSummariesTable.coveredThroughCreatedAt)),
    ]);
    // Surface the resolved policy + the operator switch alongside the raw
    // profile. The mobile app uses these to decide whether to show the
    // 18+ section at all and what its current state is, without re-running
    // the gating rules client-side.
    res.json({
      profile,
      messages,
      memories,
      summaries,
      policy: {
        effectiveMode: policy.effectiveMode,
        intimacyLevel: policy.intimacyLevel,
        intimacyCeiling: policy.intimacyCeiling,
        adultConfirmed: policy.adultConfirmed,
        matureModeAvailable: policy.matureModeAvailable,
        operatorMatureModeAvailable: isMatureModeAvailable(),
      },
    });
  } catch (err) {
    req.log.error({ err }, "GET /state failed");
    res.status(500).json({ error: "Could not load state" });
  }
});

router.put("/profile", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ProfileUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { markOnboarded, contentMode, intimacyLevel, ...fields } = parsed.data;

  try {
    // Make sure the row exists so the update has something to hit, and
    // so the policy guard sees the actual current state (esp. whether
    // adultConfirmedAt is set).
    const current = await getOrCreateProfileFor(deviceId);

    // Run the policy chokepoint BEFORE building the SQL update. This
    // rejects mature-mode requests that don't meet the operator-flag +
    // age-gate requirements, and clamps intimacyLevel to the per-mode
    // ceiling.
    const guard = validatePolicyPatch({
      current,
      patch: { contentMode, intimacyLevel },
    });
    if (!guard.ok) {
      res.status(guard.status).json({ error: guard.error });
      return;
    }

    const updates: Record<string, unknown> = { ...fields, ...guard.sanitised };
    if (markOnboarded) {
      updates["onboardedAt"] = new Date();
    }
    if (Object.keys(updates).length === 0) {
      const profile = await getOrCreateProfileFor(deviceId);
      res.json({ profile });
      return;
    }
    const [profile] = await db
      .update(ashleyProfileTable)
      .set(updates)
      .where(eq(ashleyProfileTable.deviceId, deviceId))
      .returning();
    res.json({ profile });
  } catch (err) {
    req.log.error({ err }, "PUT /profile failed");
    res.status(500).json({ error: "Could not update profile" });
  }
});

// Age gate. The ONLY way adultConfirmedAt ever becomes non-null. Body must
// carry an explicit affirmative payload — no implicit confirmation through
// other endpoints. Idempotent: re-confirming is a no-op (timestamp stays).
const AdultConfirmSchema = z
  .object({ confirm: z.literal(true) })
  .strict();

router.post("/profile/confirm-adult", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = AdultConfirmSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error:
        "Body must be { confirm: true }. The age gate requires an explicit affirmative payload.",
    });
    return;
  }
  try {
    const current = await getOrCreateProfileFor(deviceId);
    if (current.adultConfirmedAt != null) {
      res.json({ profile: current, alreadyConfirmed: true });
      return;
    }
    const [profile] = await db
      .update(ashleyProfileTable)
      .set({ adultConfirmedAt: new Date() })
      .where(eq(ashleyProfileTable.deviceId, deviceId))
      .returning();
    res.json({ profile, alreadyConfirmed: false });
  } catch (err) {
    req.log.error({ err }, "POST /profile/confirm-adult failed");
    res.status(500).json({ error: "Could not record age confirmation" });
  }
});

// Withdraw the 18+ confirmation. Forces effective mode back to standard
// on next prompt build (the policy module gates mature on this timestamp).
router.delete("/profile/confirm-adult", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  try {
    await getOrCreateProfileFor(deviceId);
    const [profile] = await db
      .update(ashleyProfileTable)
      .set({ adultConfirmedAt: null, contentMode: "standard" })
      .where(eq(ashleyProfileTable.deviceId, deviceId))
      .returning();
    res.json({ profile });
  } catch (err) {
    req.log.error({ err }, "DELETE /profile/confirm-adult failed");
    res.status(500).json({ error: "Could not withdraw age confirmation" });
  }
});

// Wipe this device's chat history. Summaries are tied to messages, so they
// go too — otherwise Ashley would still "remember" things from the cleared
// thread on the next reply.
router.delete("/chat/messages", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  try {
    await db.delete(messagesTable).where(eq(messagesTable.deviceId, deviceId));
    await db
      .delete(conversationSummariesTable)
      .where(eq(conversationSummariesTable.deviceId, deviceId));
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DELETE /chat/messages failed");
    res.status(500).json({ error: "Could not clear messages" });
  }
});

// Edit a single rolling summary's text. Used by the "manage memory" UI
// so the user can fine-tune what Ashley remembers about old conversations
// without having to re-summarize them from scratch.
router.patch("/summaries/:id", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const id = req.params.id;
  const parsed = z
    .object({ summary: z.string().min(1).max(MAX_LARGE_FIELD_LEN) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [row] = await db
      .update(conversationSummariesTable)
      .set({ summary: parsed.data.summary.trim() })
      .where(
        and(
          eq(conversationSummariesTable.id, id),
          eq(conversationSummariesTable.deviceId, deviceId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    res.json({ summary: row });
  } catch (err) {
    req.log.error({ err }, "PATCH /summaries/:id failed");
    res.status(500).json({ error: "Could not update summary" });
  }
});

router.delete("/summaries/:id", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const id = req.params.id;
  try {
    await db
      .delete(conversationSummariesTable)
      .where(
        and(
          eq(conversationSummariesTable.id, id),
          eq(conversationSummariesTable.deviceId, deviceId),
        ),
      );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DELETE /summaries/:id failed");
    res.status(500).json({ error: "Could not delete summary" });
  }
});

// Force-delete this device's profile + everything else. Used by the
// "reset companion" affordance in the app (and by tests).
router.delete("/state", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  try {
    await Promise.all([
      db.delete(messagesTable).where(eq(messagesTable.deviceId, deviceId)),
      db.delete(memoriesTable).where(eq(memoriesTable.deviceId, deviceId)),
      db
        .delete(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId)),
      db
        .delete(ashleyProfileTable)
        .where(eq(ashleyProfileTable.deviceId, deviceId)),
    ]);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DELETE /state failed");
    res.status(500).json({ error: "Could not reset state" });
  }
});

export default router;
