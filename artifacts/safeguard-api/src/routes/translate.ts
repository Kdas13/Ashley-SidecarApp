import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, safeguardProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  SUPPORTED_LANGS,
  type Lang,
  translate,
} from "../lib/translationService";

const router: IRouter = Router();

const Body = z.object({
  text: z.string().min(1).max(4000),
  from: z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]),
  to: z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]),
});

router.post("/translate", async (req, res, next) => {
  try {
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    // Same consent gate as /me/checkins: any AI processing of user text
    // requires the explicit AI-processing consent on the profile. The
    // profile PUT itself already requires both consents, so this is a
    // belt-and-braces check for the standalone /translate surface.
    const userId = req.auth!.userId;
    const profileRows = await db
      .select({
        consentStorage: safeguardProfilesTable.consentStorage,
        consentAi: safeguardProfilesTable.consentAiProcessing,
      })
      .from(safeguardProfilesTable)
      .where(eq(safeguardProfilesTable.userId, userId));
    const profile = profileRows[0];
    if (!profile?.consentStorage || !profile?.consentAi) {
      res.status(403).json({
        error: "consent_required",
        message: "Complete onboarding (both consents) before using translation.",
      });
      return;
    }
    const result = await translate(
      parsed.data.text,
      parsed.data.from,
      parsed.data.to,
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
