import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, memoriesTable, type Memory } from "@workspace/db";

import { getDeviceId } from "../middleware/deviceId";

const router: IRouter = Router();

const MAX_MEMORY_LEN = 500;

const CreateMemorySchema = z.object({
  id: z.string().min(8).max(128),
  content: z.string().min(1).max(MAX_MEMORY_LEN),
  tag: z.string().max(60).optional().default("general"),
  importance: z.number().int().min(1).max(5).optional().default(3),
});

const UpdateMemorySchema = z.object({
  content: z.string().min(1).max(MAX_MEMORY_LEN).optional(),
  tag: z.string().max(60).optional(),
  importance: z.number().int().min(1).max(5).optional(),
});

router.post("/memories", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = CreateMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const [row] = await db
      .insert(memoriesTable)
      .values({
        id: parsed.data.id,
        deviceId,
        content: parsed.data.content.trim(),
        tag: parsed.data.tag,
        importance: parsed.data.importance,
      })
      .onConflictDoNothing({ target: memoriesTable.id })
      .returning();
    if (!row) {
      // Same id was already inserted (idempotent retry) — return the existing.
      const existing = await db
        .select()
        .from(memoriesTable)
        .where(
          and(
            eq(memoriesTable.id, parsed.data.id),
            eq(memoriesTable.deviceId, deviceId),
          ),
        )
        .limit(1);
      res.status(200).json({ memory: existing[0] ?? null });
      return;
    }
    res.status(201).json({ memory: row });
  } catch (err) {
    req.log.error({ err }, "POST /memories failed");
    res.status(500).json({ error: "Could not save memory" });
  }
});

router.patch("/memories/:id", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const id = req.params.id;
  const parsed = UpdateMemorySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const updates: Partial<Memory> = {};
    if (parsed.data.content !== undefined)
      updates.content = parsed.data.content.trim();
    if (parsed.data.tag !== undefined) updates.tag = parsed.data.tag;
    if (parsed.data.importance !== undefined)
      updates.importance = parsed.data.importance;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }
    const [row] = await db
      .update(memoriesTable)
      .set(updates)
      .where(
        and(
          eq(memoriesTable.id, id),
          eq(memoriesTable.deviceId, deviceId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "Memory not found" });
      return;
    }
    res.json({ memory: row });
  } catch (err) {
    req.log.error({ err }, "PATCH /memories/:id failed");
    res.status(500).json({ error: "Could not update memory" });
  }
});

router.delete("/memories/:id", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const id = req.params.id;
  try {
    await db
      .delete(memoriesTable)
      .where(
        and(
          eq(memoriesTable.id, id),
          eq(memoriesTable.deviceId, deviceId),
        ),
      );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "DELETE /memories/:id failed");
    res.status(500).json({ error: "Could not delete memory" });
  }
});

export default router;
