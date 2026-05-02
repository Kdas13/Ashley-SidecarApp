import { Router, type IRouter } from "express";
import { db, memoriesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import {
  ListMemoriesResponse,
  CreateMemoryBodySchema,
  UpdateMemoryBodySchema,
  UpdateMemoryParams,
  DeleteMemoryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/memories", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(memoriesTable)
    .orderBy(desc(memoriesTable.importance), desc(memoriesTable.updatedAt));
  res.json(ListMemoriesResponse.parse(rows));
});

router.post("/memories", async (req, res): Promise<void> => {
  const parsed = CreateMemoryBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(memoriesTable)
    .values({
      content: parsed.data.content,
      tag: parsed.data.tag ?? "general",
      importance: parsed.data.importance ?? 3,
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/memories/:id", async (req, res): Promise<void> => {
  const paramsParsed = UpdateMemoryParams.safeParse(req.params);
  const bodyParsed = UpdateMemoryBodySchema.safeParse(req.body);
  if (!paramsParsed.success || !bodyParsed.success) {
    res.status(400).json({
      error:
        paramsParsed.success === false
          ? paramsParsed.error.message
          : bodyParsed.success === false
            ? bodyParsed.error.message
            : "Invalid",
    });
    return;
  }
  const id = paramsParsed.data.id;
  const update: Record<string, unknown> = {};
  if (bodyParsed.data.content !== undefined) update["content"] = bodyParsed.data.content;
  if (bodyParsed.data.tag !== undefined) update["tag"] = bodyParsed.data.tag;
  if (bodyParsed.data.importance !== undefined)
    update["importance"] = bodyParsed.data.importance;

  const [row] = await db
    .update(memoriesTable)
    .set(update)
    .where(eq(memoriesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.json(row);
});

router.delete("/memories/:id", async (req, res): Promise<void> => {
  const parsed = DeleteMemoryParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const result = await db
    .delete(memoriesTable)
    .where(eq(memoriesTable.id, parsed.data.id))
    .returning();
  if (result.length === 0) {
    res.status(404).json({ error: "Memory not found" });
    return;
  }
  res.status(204).end();
});

export default router;
