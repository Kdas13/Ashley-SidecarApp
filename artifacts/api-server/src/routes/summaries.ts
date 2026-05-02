import { Router, type IRouter } from "express";
import { db, conversationSummariesTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import {
  ListConversationSummariesResponse,
  CreateConversationSummaryBodySchema,
  UpdateConversationSummaryBodySchema,
  UpdateConversationSummaryParams,
  DeleteConversationSummaryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/conversation-summaries", async (_req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(conversationSummariesTable)
    .orderBy(asc(conversationSummariesTable.coveredThroughCreatedAt));
  res.json(ListConversationSummariesResponse.parse(rows));
});

router.post("/conversation-summaries", async (req, res): Promise<void> => {
  const parsed = CreateConversationSummaryBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [row] = await db
    .insert(conversationSummariesTable)
    .values({
      summary: parsed.data.summary,
      messageCount: parsed.data.messageCount ?? 0,
      coveredThroughCreatedAt: new Date(parsed.data.coveredThroughCreatedAt),
    })
    .returning();
  res.status(201).json(row);
});

router.patch("/conversation-summaries/:id", async (req, res): Promise<void> => {
  const paramsParsed = UpdateConversationSummaryParams.safeParse(req.params);
  const bodyParsed = UpdateConversationSummaryBodySchema.safeParse(req.body);
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
  if (bodyParsed.data.summary !== undefined)
    update["summary"] = bodyParsed.data.summary;
  if (bodyParsed.data.messageCount !== undefined)
    update["messageCount"] = bodyParsed.data.messageCount;
  if (bodyParsed.data.coveredThroughCreatedAt !== undefined)
    update["coveredThroughCreatedAt"] = new Date(
      bodyParsed.data.coveredThroughCreatedAt,
    );

  const [row] = await db
    .update(conversationSummariesTable)
    .set(update)
    .where(eq(conversationSummariesTable.id, id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Summary not found" });
    return;
  }
  res.json(row);
});

router.delete(
  "/conversation-summaries/:id",
  async (req, res): Promise<void> => {
    const parsed = DeleteConversationSummaryParams.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    const result = await db
      .delete(conversationSummariesTable)
      .where(eq(conversationSummariesTable.id, parsed.data.id))
      .returning();
    if (result.length === 0) {
      res.status(404).json({ error: "Summary not found" });
      return;
    }
    res.status(204).end();
  },
);

export default router;
