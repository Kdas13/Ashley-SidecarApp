import { Router, type IRouter } from "express";
import { db, ashleyProfileTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  GetProfileResponse,
  UpdateProfileBodySchema,
} from "@workspace/api-zod";
import { getOrCreateProfile } from "../lib/profile";

const router: IRouter = Router();

router.get("/profile", async (req, res): Promise<void> => {
  const profile = await getOrCreateProfile();
  res.json(GetProfileResponse.parse(profile));
});

router.put("/profile", async (req, res): Promise<void> => {
  const parsed = UpdateProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid profile body");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await getOrCreateProfile();

  const { markOnboarded, ...rest } = parsed.data;
  const update: Record<string, unknown> = { ...rest };
  if (markOnboarded) update["onboardedAt"] = new Date();

  const [updated] = await db
    .update(ashleyProfileTable)
    .set(update)
    .where(eq(ashleyProfileTable.id, 1))
    .returning();

  res.json(GetProfileResponse.parse(updated));
});

export default router;
