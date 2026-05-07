import { Router, type IRouter } from "express";
import { z } from "zod";
import { db, safeguardUsersTable, safeguardProfilesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { SUPPORTED_LANGS, type Lang } from "../lib/translationService";

const router: IRouter = Router();

const LangSchema = z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]);
const LiteracySchema = z.enum(["low", "medium", "high"]);

/**
 * Onboarding payload contract. Mirrored in
 * `artifacts/safeguard/src/pages/Onboarding.tsx`. Every field has a defensive
 * default so partial submissions during onboarding don't 400; the UI is
 * what enforces the "must consent before continuing" gate, but the server
 * also refuses to mark onboarding complete unless both consent flags are
 * true (see below).
 */
const ProfileBodySchema = z.object({
  preferredName: z.string().min(1).max(80),
  preferredLanguage: LangSchema,
  nativeLanguage: LangSchema,
  secondaryLanguage: z.union([LangSchema, z.literal("")]).optional().default(""),
  literacyLevel: LiteracySchema.optional().default("medium"),
  countryOfOrigin: z.string().min(1).max(80),
  dateOfBirth: z.string().min(1).max(20),
  gpName: z.string().max(120).optional().default(""),
  gpSurgery: z.string().max(200).optional().default(""),
  ongoingConcerns: z.string().max(2000).optional().default(""),
  currentMedications: z.string().max(2000).optional().default(""),
  accessibilityLargeText: z.boolean().optional().default(false),
  accessibilityHighContrast: z.boolean().optional().default(false),
  accessibilityAudio: z.boolean().optional().default(false),
  accessibilitySimplified: z.boolean().optional().default(false),
  accessibilitySlowerPacing: z.boolean().optional().default(false),
  trustedContactName: z.string().max(120).optional().default(""),
  trustedContactRelation: z.string().max(80).optional().default(""),
  trustedContactPhone: z.string().max(40).optional().default(""),
  consentStorage: z.boolean(),
  consentAiProcessing: z.boolean(),
});

router.get("/me/profile", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rows = await db
      .select()
      .from(safeguardProfilesTable)
      .where(eq(safeguardProfilesTable.userId, userId));
    res.json({ profile: rows[0] ?? null });
  } catch (err) {
    next(err);
  }
});

router.put("/me/profile", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const parsed = ProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    if (!parsed.data.consentStorage || !parsed.data.consentAiProcessing) {
      res.status(400).json({
        error: "consent_required",
        message:
          "Both data storage and AI processing consent are required to save the profile.",
      });
      return;
    }
    const now = new Date();
    const values = {
      userId,
      ...parsed.data,
      consentRecordedAt: now,
      updatedAt: now,
    };
    const [row] = await db
      .insert(safeguardProfilesTable)
      .values(values)
      .onConflictDoUpdate({
        target: safeguardProfilesTable.userId,
        set: values,
      })
      .returning();
    await db
      .update(safeguardUsersTable)
      .set({ onboardingCompletedAt: now })
      .where(eq(safeguardUsersTable.id, userId));
    res.json({ profile: row });
  } catch (err) {
    next(err);
  }
});

export default router;
