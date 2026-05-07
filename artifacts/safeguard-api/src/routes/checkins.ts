import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  db,
  safeguardCheckinsTable,
  safeguardObservationsTable,
  safeguardProfilesTable,
  safeguardTranslationsTable,
} from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import {
  SUPPORTED_LANGS,
  type Lang,
  type CheckinScores,
  summarizeCheckin,
  extractObservations,
  translate,
} from "../lib/translationService";

const router: IRouter = Router();

const LangSchema = z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]);
const ScoreSchema = z.number().int().min(0).max(10).optional();

/**
 * Daily check-in question set, per safeguarding spec:
 *   - generalFeeling (0=worst, 10=best)
 *   - pain (0=none, 10=worst)
 *   - foodWater (0=none today, 10=well-fed and hydrated)
 *   - medication (0=missed all, 10=took all as prescribed; null = N/A)
 *   - sleep (0=did not sleep, 10=rested)
 *   - safety (0=feels unsafe, 10=feels safe)
 *
 * All scores are individually optional so the user can skip any. `freeText`
 * is the user's words in their own language.
 */
const CheckinBodySchema = z.object({
  lang: LangSchema,
  freeText: z.string().max(4000).default(""),
  scores: z
    .object({
      generalFeeling: ScoreSchema,
      pain: ScoreSchema,
      foodWater: ScoreSchema,
      medication: ScoreSchema,
      sleep: ScoreSchema,
      safety: ScoreSchema,
    })
    .default({}),
});

router.post("/me/checkins", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const parsed = CheckinBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }

    // Hard consent gate at the data-write boundary. The UI also gates this,
    // but the server is the source of truth — never write a check-in for a
    // user who hasn't consented to storage + AI processing.
    const profileRows = await db
      .select({
        consentStorage: safeguardProfilesTable.consentStorage,
        consentAi: safeguardProfilesTable.consentAiProcessing,
      })
      .from(safeguardProfilesTable)
      .where(eq(safeguardProfilesTable.userId, userId));
    const profile = profileRows[0];
    if (!profile?.consentStorage || !profile?.consentAi) {
      res
        .status(403)
        .json({ error: "consent_required", message: "Complete onboarding first." });
      return;
    }

    const { lang, freeText, scores } = parsed.data;
    const checkinScores: CheckinScores = scores;

    // Insert raw check-in first so we always have the source of truth even
    // if the AI step fails (transparency invariant).
    const [checkin] = await db
      .insert(safeguardCheckinsTable)
      .values({
        userId,
        lang,
        freeText,
        generalFeelingScore: scores.generalFeeling ?? null,
        painScore: scores.pain ?? null,
        foodWaterScore: scores.foodWater ?? null,
        medicationScore: scores.medication ?? null,
        sleepScore: scores.sleep ?? null,
        safetyScore: scores.safety ?? null,
      })
      .returning();
    if (!checkin) throw new Error("checkin_insert_failed");

    // If the user wrote in a non-English language, also persist a
    // translation to English of the raw text so a clinician can read the
    // source verbatim.
    let englishRaw = freeText;
    if (lang !== "en" && freeText.trim().length > 0) {
      try {
        const tr = await translate(freeText, lang, "en");
        englishRaw = tr.translated;
        await db.insert(safeguardTranslationsTable).values({
          userId,
          checkinId: checkin.id,
          sourceLang: lang,
          targetLang: "en",
          sourceText: freeText,
          translatedText: tr.translated,
          provider: tr.provider,
          model: tr.model,
          confidence: tr.confidence,
          notes: tr.notes,
        });
      } catch (err) {
        req.log?.warn({ err }, "translation failed; continuing with raw text");
      }
    }

    let summary = "";
    let bullets: string[] = [];
    let flagged = false;
    try {
      const [s, e] = await Promise.all([
        summarizeCheckin({
          rawText: englishRaw || freeText,
          rawLang: "en",
          scores: checkinScores,
          outputLang: "en",
        }),
        extractObservations({
          rawText: englishRaw || freeText,
          rawLang: "en",
          scores: checkinScores,
          outputLang: "en",
        }),
      ]);
      summary = s.summary;
      bullets = e.bullets;
      flagged = e.flagged;
    } catch (err) {
      req.log?.warn({ err }, "summary/extraction failed");
    }

    if (summary || bullets.length > 0) {
      await db.insert(safeguardObservationsTable).values({
        userId,
        checkinId: checkin.id,
        kind: "checkin",
        summary,
        bullets,
        flagged,
        outputLang: "en",
      });
    }

    res.json({ checkin, summary, observations: bullets, flagged });
  } catch (err) {
    next(err);
  }
});

router.get("/me/checkins", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = await db
      .select()
      .from(safeguardCheckinsTable)
      .where(eq(safeguardCheckinsTable.userId, userId))
      .orderBy(desc(safeguardCheckinsTable.createdAt))
      .limit(limit);
    res.json({ checkins: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/me/checkins/today", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const rows = await db
      .select()
      .from(safeguardCheckinsTable)
      .where(
        and(
          eq(safeguardCheckinsTable.userId, userId),
          gte(safeguardCheckinsTable.createdAt, startOfDay),
        ),
      )
      .orderBy(desc(safeguardCheckinsTable.createdAt))
      .limit(1);
    res.json({ checkin: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

export default router;
