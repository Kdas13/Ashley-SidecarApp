import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  ashleyProfileTable,
  conversationSummariesTable,
  mediaAttachmentsTable,
  memoriesTable,
  messagesTable,
  PROACTIVE_CADENCES,
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
    // How often Ashley reaches out first. The scheduler reads this on
    // every tick — flipping to "off" stops further proactive sends within
    // one tick (≤5min). See lib/db/src/schema/ashley.ts for cap mapping.
    proactiveCadence: z.enum(PROACTIVE_CADENCES).optional(),
    greetOnAppOpen: z.boolean().optional(),
    imageGenerationEnabled: z.boolean().optional(),
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
    const [messages, memories, summaries, attachments] = await Promise.all([
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
      // Fetch ready + failed media_attachments so /state hydration can annotate
      // multi-image packet messages with their resolved imageUrls[].
      // Failed rows emit null at their sort_order position so the gallery
      // preserves slot positions and can render an error tile in place.
      db
        .select({
          messageId: mediaAttachmentsTable.messageId,
          imageUrl: mediaAttachmentsTable.imageUrl,
          sortOrder: mediaAttachmentsTable.sortOrder,
          status: mediaAttachmentsTable.status,
        })
        .from(mediaAttachmentsTable)
        .where(
          and(
            eq(mediaAttachmentsTable.deviceId, deviceId),
            inArray(mediaAttachmentsTable.status, ["ready", "failed"]),
          ),
        )
        .orderBy(asc(mediaAttachmentsTable.sortOrder)),
    ]);

    // Build messageId → sorted (string | null)[] from settled attachment rows.
    // null = failed slot (position preserved for gallery error tiles).
    const packetUrls = new Map<string, (string | null)[]>();
    for (const att of attachments) {
      const list = packetUrls.get(att.messageId) ?? [];
      list.push(att.status === "ready" && att.imageUrl ? att.imageUrl : null);
      packetUrls.set(att.messageId, list);
    }

    // Annotate messages that have multi-image packets with their imageUrls.
    const annotatedMessages = messages.map((m) => ({
      ...m,
      imageUrls: packetUrls.get(m.id) ?? null,
    }));

    // Surface the resolved policy + the operator switch alongside the raw
    // profile. The mobile app uses these to decide whether to show the
    // 18+ section at all and what its current state is, without re-running
    // the gating rules client-side.
    res.json({
      profile,
      messages: annotatedMessages,
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
    await db
      .delete(mediaAttachmentsTable)
      .where(eq(mediaAttachmentsTable.deviceId, deviceId));
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

// Bulk import: replace this device's server-side profile + history with a
// previously-exported payload from another device/browser. Used by the
// "Import backup" flow in the mobile profile screen so a fresh APK can
// pick up the user's real Ashley (otherwise the next /state hydration
// overwrites the imported AsyncStorage data with this device's empty
// server defaults).
const ImportProfileSchema = z
  .object({
    name: z.string().max(MAX_FIELD_LEN).optional(),
    age: z.string().max(MAX_FIELD_LEN).optional(),
    identity: z.string().max(MAX_FIELD_LEN).optional(),
    appearance: z.string().max(MAX_FIELD_LEN).optional(),
    personality: z.string().max(MAX_FIELD_LEN).optional(),
    speakingStyle: z.string().max(MAX_FIELD_LEN).optional(),
    refersToUserAs: z.string().max(120).optional(),
    sharedHistory: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    replikaExcerpts: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    replikaCarryover: z.string().max(64_000).optional(),
    replikaCarryoverSummary: z.string().max(MAX_LARGE_FIELD_LEN).optional(),
    relationshipMode: z.string().max(120).optional(),
    builderAwareMode: z.boolean().optional(),
    voiceMode: z.boolean().optional(),
    // contentMode + intimacyLevel are intentionally NOT importable: those
    // require the policy gate (server flag + 18+ confirmation) and an
    // explicit user tap. Any backup that carries them is silently dropped.
    proactiveCadence: z.enum(PROACTIVE_CADENCES).optional(),
    onboardedAt: z.string().nullable().optional(),
  })
  .strip();

const ImportMessageSchema = z
  .object({
    id: z.string().min(1).max(128),
    role: z.enum(["user", "ashley"]),
    content: z.string().max(64_000),
    status: z.enum(["complete", "streaming", "interrupted"]).optional(),
    imageUrl: z.string().max(2048).nullable().optional(),
    selfieVibe: z.string().max(2048).nullable().optional(),
    imageMimeType: z.string().max(120).nullable().optional(),
    imageCategory: z.string().max(60).nullable().optional(),
    imageCaption: z.string().max(MAX_FIELD_LEN).nullable().optional(),
    imageAnalysisMode: z.string().max(60).nullable().optional(),
    imageRemembered: z.boolean().nullable().optional(),
    replyTo: z
      .object({
        id: z.string().max(128),
        role: z.enum(["user", "ashley"]),
        preview: z.string().max(MAX_FIELD_LEN),
      })
      .nullable()
      .optional(),
    createdAt: z.string(),
  })
  .strip();

const ImportMemorySchema = z
  .object({
    id: z.string().min(1).max(128),
    content: z.string().min(1).max(MAX_LARGE_FIELD_LEN),
    tag: z.string().max(60).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strip();

const ImportSummarySchema = z
  .object({
    id: z.string().min(1).max(128),
    summary: z.string().min(1).max(MAX_LARGE_FIELD_LEN),
    messageCount: z.number().int().min(0).optional(),
    coveredThroughCreatedAt: z.string(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strip();

const ImportPayloadSchema = z
  .object({
    schema: z.literal("ashley-sidecar-export"),
    version: z.number().int().min(1),
    data: z.object({
      profile: ImportProfileSchema,
      messages: z.array(ImportMessageSchema).max(50_000),
      memories: z.array(ImportMemorySchema).max(10_000),
      summaries: z.array(ImportSummarySchema).max(10_000),
    }),
  })
  .strip();

function parseDateOrNow(s: string | undefined | null): Date {
  if (!s) return new Date();
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

router.post("/state/import", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = ImportPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { profile, messages, memories, summaries } = parsed.data.data;

  try {
    // Make sure a profile row exists for this device BEFORE the txn so the
    // update inside the txn always has a target row.
    await getOrCreateProfileFor(deviceId);

    const profileUpdates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(profile)) {
      if (k === "onboardedAt") {
        profileUpdates[k] = v ? parseDateOrNow(v as string) : null;
      } else if (v !== undefined) {
        profileUpdates[k] = v;
      }
    }

    const messageRows = messages.map((m) => ({
      id: m.id,
      deviceId,
      role: m.role,
      content: m.content,
      status: m.status ?? "complete",
      imageUrl: m.imageUrl ?? null,
      selfieVibe: m.selfieVibe ?? null,
      imageMimeType: m.imageMimeType ?? null,
      imageCategory: m.imageCategory ?? null,
      imageCaption: m.imageCaption ?? null,
      imageAnalysisMode: m.imageAnalysisMode ?? null,
      imageRemembered: m.imageRemembered ?? null,
      replyToId: m.replyTo?.id ?? null,
      replyToRole: m.replyTo?.role ?? null,
      replyToPreview: m.replyTo?.preview ?? null,
      createdAt: parseDateOrNow(m.createdAt),
    }));
    const memoryRows = memories.map((m) => ({
      id: m.id,
      deviceId,
      content: m.content,
      tag: m.tag ?? "general",
      importance: m.importance ?? 3,
      createdAt: parseDateOrNow(m.createdAt),
      updatedAt: parseDateOrNow(m.updatedAt),
    }));
    const summaryRows = summaries.map((s) => ({
      id: s.id,
      deviceId,
      summary: s.summary,
      messageCount: s.messageCount ?? 0,
      coveredThroughCreatedAt: parseDateOrNow(s.coveredThroughCreatedAt),
      createdAt: parseDateOrNow(s.createdAt),
      updatedAt: parseDateOrNow(s.updatedAt),
    }));

    // Atomic: either everything lands or nothing does. Without this, a
    // mid-import failure (constraint violation, network blip on a chunk)
    // would leave the user with their history wiped server-side and no
    // replacement, and the next /state hydration would clobber their
    // local AsyncStorage cache too — total data loss.
    await db.transaction(async (tx) => {
      if (Object.keys(profileUpdates).length > 0) {
        await tx
          .update(ashleyProfileTable)
          .set(profileUpdates)
          .where(eq(ashleyProfileTable.deviceId, deviceId));
      }
      await tx.delete(messagesTable).where(eq(messagesTable.deviceId, deviceId));
      await tx.delete(memoriesTable).where(eq(memoriesTable.deviceId, deviceId));
      await tx
        .delete(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId));

      const CHUNK = 500;
      // Cross-device migration: the same backup file imported on a
      // previous device leaves rows with these exact ids owned by that
      // old device_id. We "claim" them for the importing device by
      // deleting any existing row with the same id (across ALL devices)
      // before re-inserting under the new device_id. Without this the
      // INSERT silently dropped every row via ON CONFLICT and the user
      // ended up with profile-only restore.
      const messageIds = messageRows.map((r) => r.id);
      const memoryIds = memoryRows.map((r) => r.id);
      const summaryIds = summaryRows.map((r) => r.id);
      for (let i = 0; i < messageIds.length; i += CHUNK) {
        await tx
          .delete(messagesTable)
          .where(inArray(messagesTable.id, messageIds.slice(i, i + CHUNK)));
      }
      for (let i = 0; i < memoryIds.length; i += CHUNK) {
        await tx
          .delete(memoriesTable)
          .where(inArray(memoriesTable.id, memoryIds.slice(i, i + CHUNK)));
      }
      for (let i = 0; i < summaryIds.length; i += CHUNK) {
        await tx
          .delete(conversationSummariesTable)
          .where(
            inArray(conversationSummariesTable.id, summaryIds.slice(i, i + CHUNK)),
          );
      }
      for (let i = 0; i < messageRows.length; i += CHUNK) {
        await tx.insert(messagesTable).values(messageRows.slice(i, i + CHUNK));
      }
      for (let i = 0; i < memoryRows.length; i += CHUNK) {
        await tx.insert(memoriesTable).values(memoryRows.slice(i, i + CHUNK));
      }
      for (let i = 0; i < summaryRows.length; i += CHUNK) {
        await tx
          .insert(conversationSummariesTable)
          .values(summaryRows.slice(i, i + CHUNK));
      }
    });

    res.json({
      ok: true,
      counts: {
        profile: Object.keys(profileUpdates).length > 0,
        messages: messages.length,
        memories: memories.length,
        summaries: summaries.length,
      },
    });
  } catch (err) {
    req.log.error({ err }, "POST /state/import failed");
    res.status(500).json({ error: "Could not import backup" });
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
      db
        .delete(mediaAttachmentsTable)
        .where(eq(mediaAttachmentsTable.deviceId, deviceId)),
    ]);
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DELETE /state failed");
    res.status(500).json({ error: "Could not reset state" });
  }
});

export default router;
