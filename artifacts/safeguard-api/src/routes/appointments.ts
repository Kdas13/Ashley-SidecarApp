import { Router, type IRouter } from "express";
import { z } from "zod";
import {
  db,
  safeguardAppointmentsTable,
  safeguardAppointmentIntakeTable,
  safeguardAppointmentSummariesTable,
  safeguardAppointmentUtterancesTable,
  safeguardAppointmentExportsTable,
  safeguardFollowupsTable,
  safeguardTranslationsTable,
  safeguardProfilesTable,
  safeguardCheckinsTable,
} from "@workspace/db";
import { and, asc, desc, eq, gte } from "drizzle-orm";
import {
  SUPPORTED_LANGS,
  type Lang,
  summarizeForPatient,
  summarizeForClinician,
  translateUtterance,
  summarizeFollowup,
  type AppointmentIntakeAnswers,
} from "../lib/translationService";
import {
  generateGpExportPdf,
  type PdfCheckinTrend,
} from "../lib/pdfExport";

const router: IRouter = Router();

const LangSchema = z.enum(SUPPORTED_LANGS as unknown as [Lang, ...Lang[]]);

/**
 * Hard consent gate. Identical to the one in checkins.ts — duplicated
 * deliberately so removing one route never accidentally weakens another.
 */
async function requireConsent(userId: string): Promise<boolean> {
  const rows = await db
    .select({
      consentStorage: safeguardProfilesTable.consentStorage,
      consentAi: safeguardProfilesTable.consentAiProcessing,
    })
    .from(safeguardProfilesTable)
    .where(eq(safeguardProfilesTable.userId, userId));
  const p = rows[0];
  return !!(p?.consentStorage && p?.consentAi);
}

// ---------------------------------------------------------------------------
// Create / list / get appointments
// ---------------------------------------------------------------------------

const CreateBody = z.object({
  patientLang: LangSchema,
  clinicianLang: LangSchema,
  title: z.string().max(200).optional().default(""),
});

router.post("/me/appointments", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    if (!(await requireConsent(userId))) {
      res
        .status(403)
        .json({ error: "consent_required", message: "Complete onboarding first." });
      return;
    }
    const parsed = CreateBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const [row] = await db
      .insert(safeguardAppointmentsTable)
      .values({
        userId,
        patientLang: parsed.data.patientLang,
        clinicianLang: parsed.data.clinicianLang,
        title: parsed.data.title,
        status: "draft",
      })
      .returning();
    res.json({ appointment: row });
  } catch (err) {
    next(err);
  }
});

router.get("/me/appointments", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rows = await db
      .select()
      .from(safeguardAppointmentsTable)
      .where(eq(safeguardAppointmentsTable.userId, userId))
      .orderBy(desc(safeguardAppointmentsTable.createdAt))
      .limit(50);
    res.json({ appointments: rows });
  } catch (err) {
    next(err);
  }
});

async function loadAppointment(userId: string, id: string) {
  const rows = await db
    .select()
    .from(safeguardAppointmentsTable)
    .where(
      and(
        eq(safeguardAppointmentsTable.userId, userId),
        eq(safeguardAppointmentsTable.id, id),
      ),
    );
  return rows[0] ?? null;
}

router.get("/me/appointments/:id", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    const appt = await loadAppointment(userId, id);
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const intakeRows = await db
      .select()
      .from(safeguardAppointmentIntakeTable)
      .where(eq(safeguardAppointmentIntakeTable.appointmentId, id));
    const summaries = await db
      .select()
      .from(safeguardAppointmentSummariesTable)
      .where(eq(safeguardAppointmentSummariesTable.appointmentId, id))
      .orderBy(desc(safeguardAppointmentSummariesTable.createdAt));
    const utteranceRows = await db
      .select({
        utterance: safeguardAppointmentUtterancesTable,
        translation: safeguardTranslationsTable,
      })
      .from(safeguardAppointmentUtterancesTable)
      .leftJoin(
        safeguardTranslationsTable,
        eq(
          safeguardAppointmentUtterancesTable.translationId,
          safeguardTranslationsTable.id,
        ),
      )
      .where(eq(safeguardAppointmentUtterancesTable.appointmentId, id))
      .orderBy(asc(safeguardAppointmentUtterancesTable.createdAt));
    const followups = await db
      .select()
      .from(safeguardFollowupsTable)
      .where(eq(safeguardFollowupsTable.appointmentId, id))
      .orderBy(asc(safeguardFollowupsTable.createdAt));
    const exports_ = await db
      .select({
        id: safeguardAppointmentExportsTable.id,
        generatedAt: safeguardAppointmentExportsTable.generatedAt,
        byteSize: safeguardAppointmentExportsTable.byteSize,
      })
      .from(safeguardAppointmentExportsTable)
      .where(eq(safeguardAppointmentExportsTable.appointmentId, id))
      .orderBy(desc(safeguardAppointmentExportsTable.generatedAt));

    // Pick the latest summary per audience.
    const latestPatient = summaries.find((s) => s.audience === "patient") ?? null;
    const latestClinician =
      summaries.find((s) => s.audience === "clinician") ?? null;

    res.json({
      appointment: appt,
      intake: intakeRows[0] ?? null,
      patientSummary: latestPatient,
      clinicianSummary: latestClinician,
      utterances: utteranceRows,
      followups,
      exports: exports_,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Intake — set answers, generate dual summaries
// ---------------------------------------------------------------------------

const IntakeAnswers = z.object({
  mainConcern: z.string().max(2000).optional(),
  symptomDuration: z.string().max(500).optional(),
  severity: z.string().max(500).optional(),
  medications: z.string().max(2000).optional(),
  allergies: z.string().max(1000).optional(),
  sleep: z.string().max(500).optional(),
  appetite: z.string().max(500).optional(),
  painLevel: z.string().max(500).optional(),
  mentalHealth: z.string().max(2000).optional(),
  safeguarding: z.string().max(2000).optional(),
});

const IntakeBody = z.object({
  lang: LangSchema,
  answers: IntakeAnswers,
});

router.put("/me/appointments/:id/intake", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    if (!(await requireConsent(userId))) {
      res.status(403).json({ error: "consent_required" });
      return;
    }
    const appt = await loadAppointment(userId, id);
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = IntakeBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const answers = parsed.data.answers as AppointmentIntakeAnswers;
    // Strip undefined entries so the column type (Record<string,string>) is
    // satisfied — Zod's `.optional()` produces `string | undefined`.
    const answersForDb: Record<string, string> = Object.fromEntries(
      Object.entries(answers).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
    const now = new Date();
    await db
      .insert(safeguardAppointmentIntakeTable)
      .values({
        appointmentId: id,
        userId,
        lang: parsed.data.lang,
        answers: answersForDb,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: safeguardAppointmentIntakeTable.appointmentId,
        set: { lang: parsed.data.lang, answers: answersForDb, updatedAt: now },
      });

    // Generate dual summaries from the same source intake.
    let patientSummaryRow = null;
    let clinicianSummaryRow = null;
    try {
      const [pat, clin] = await Promise.all([
        summarizeForPatient({
          intake: answers,
          intakeLang: parsed.data.lang,
          patientLang: appt.patientLang as Lang,
        }),
        summarizeForClinician({
          intake: answers,
          intakeLang: parsed.data.lang,
          clinicianLang: appt.clinicianLang as Lang,
        }),
      ]);
      [patientSummaryRow] = await db
        .insert(safeguardAppointmentSummariesTable)
        .values({
          appointmentId: id,
          userId,
          audience: "patient",
          lang: appt.patientLang,
          summary: pat.summary,
          confidence: pat.confidence,
          notes: pat.notes,
          provider: pat.provider,
          model: pat.model,
        })
        .returning();
      [clinicianSummaryRow] = await db
        .insert(safeguardAppointmentSummariesTable)
        .values({
          appointmentId: id,
          userId,
          audience: "clinician",
          lang: appt.clinicianLang,
          summary: clin.summary,
          confidence: clin.confidence,
          notes: clin.notes,
          provider: clin.provider,
          model: clin.model,
        })
        .returning();
    } catch (err) {
      req.log?.warn({ err }, "appointment summary generation failed");
    }

    await db
      .update(safeguardAppointmentsTable)
      .set({ status: "ready", updatedAt: now })
      .where(eq(safeguardAppointmentsTable.id, id));

    res.json({
      intake: { lang: parsed.data.lang, answers },
      patientSummary: patientSummaryRow,
      clinicianSummary: clinicianSummaryRow,
    });
  } catch (err) {
    next(err);
  }
});

// Patient may edit their own summary (agency invariant).
const EditPatientBody = z.object({ summary: z.string().min(1).max(4000) });

router.put(
  "/me/appointments/:id/patient-summary",
  async (req, res, next) => {
    try {
      const userId = req.auth!.userId;
      const id = req.params.id!;
      if (!(await requireConsent(userId))) {
        res.status(403).json({ error: "consent_required" });
        return;
      }
      const appt = await loadAppointment(userId, id);
      if (!appt) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const parsed = EditPatientBody.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "invalid_body", issues: parsed.error.issues });
        return;
      }
      // Insert a NEW row marked edited=true rather than overwriting — the
      // original AI version stays in history per the transparency invariant.
      const [row] = await db
        .insert(safeguardAppointmentSummariesTable)
        .values({
          appointmentId: id,
          userId,
          audience: "patient",
          lang: appt.patientLang,
          summary: parsed.data.summary,
          confidence: "high",
          notes: "Edited by patient.",
          provider: "user",
          model: "user",
          edited: true,
        })
        .returning();
      res.json({ patientSummary: row });
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Translation workspace utterance
// ---------------------------------------------------------------------------

const UtteranceBody = z.object({
  speaker: z.enum(["patient", "clinician"]),
  text: z.string().min(1).max(2000),
});

router.post("/me/appointments/:id/utterances", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    if (!(await requireConsent(userId))) {
      res.status(403).json({ error: "consent_required" });
      return;
    }
    const appt = await loadAppointment(userId, id);
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = UtteranceBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const fromLang = (
      parsed.data.speaker === "patient" ? appt.patientLang : appt.clinicianLang
    ) as Lang;
    const toLang = (
      parsed.data.speaker === "patient" ? appt.clinicianLang : appt.patientLang
    ) as Lang;

    const tr = await translateUtterance({
      text: parsed.data.text,
      fromLang,
      toLang,
      speaker: parsed.data.speaker,
    });

    const [translationRow] = await db
      .insert(safeguardTranslationsTable)
      .values({
        userId,
        sourceLang: fromLang,
        targetLang: toLang,
        sourceText: parsed.data.text,
        translatedText: tr.translated,
        provider: tr.provider,
        model: tr.model,
        confidence: tr.confidence,
        notes: tr.notes,
      })
      .returning();

    const [utteranceRow] = await db
      .insert(safeguardAppointmentUtterancesTable)
      .values({
        appointmentId: id,
        userId,
        speaker: parsed.data.speaker,
        translationId: translationRow!.id,
      })
      .returning();

    await db
      .update(safeguardAppointmentsTable)
      .set({ status: "in_session", updatedAt: new Date() })
      .where(eq(safeguardAppointmentsTable.id, id));

    res.json({ utterance: utteranceRow, translation: translationRow });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PDF export
// ---------------------------------------------------------------------------

async function buildPdfInput(userId: string, id: string) {
  const appt = await loadAppointment(userId, id);
  if (!appt) return null;
  const profileRows = await db
    .select()
    .from(safeguardProfilesTable)
    .where(eq(safeguardProfilesTable.userId, userId));
  const profile = profileRows[0];
  const intakeRows = await db
    .select()
    .from(safeguardAppointmentIntakeTable)
    .where(eq(safeguardAppointmentIntakeTable.appointmentId, id));
  const intake = intakeRows[0];
  const summaries = await db
    .select()
    .from(safeguardAppointmentSummariesTable)
    .where(eq(safeguardAppointmentSummariesTable.appointmentId, id))
    .orderBy(desc(safeguardAppointmentSummariesTable.createdAt));
  const patientSummary = summaries.find((s) => s.audience === "patient") ?? null;
  const clinicianSummary =
    summaries.find((s) => s.audience === "clinician") ?? null;

  const since = new Date();
  since.setDate(since.getDate() - 14);
  const checkins = await db
    .select({
      createdAt: safeguardCheckinsTable.createdAt,
      generalFeelingScore: safeguardCheckinsTable.generalFeelingScore,
      painScore: safeguardCheckinsTable.painScore,
      foodWaterScore: safeguardCheckinsTable.foodWaterScore,
      medicationScore: safeguardCheckinsTable.medicationScore,
      sleepScore: safeguardCheckinsTable.sleepScore,
      safetyScore: safeguardCheckinsTable.safetyScore,
    })
    .from(safeguardCheckinsTable)
    .where(
      and(
        eq(safeguardCheckinsTable.userId, userId),
        gte(safeguardCheckinsTable.createdAt, since),
      ),
    )
    .orderBy(desc(safeguardCheckinsTable.createdAt));

  const fields: Array<[string, keyof (typeof checkins)[number]]> = [
    ["General feeling", "generalFeelingScore"],
    ["Pain", "painScore"],
    ["Food and water", "foodWaterScore"],
    ["Medication", "medicationScore"],
    ["Sleep", "sleepScore"],
    ["Felt safety", "safetyScore"],
  ];
  const trends: PdfCheckinTrend[] = fields.map(([label, key]) => ({
    field: label,
    values: checkins.map((c) => ({
      at: c.createdAt.toISOString(),
      score: c[key] as number | null,
    })),
  }));

  return {
    appt,
    profile,
    intake,
    patientSummary,
    clinicianSummary,
    trends,
  };
}

router.post("/me/appointments/:id/export", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    if (!(await requireConsent(userId))) {
      res.status(403).json({ error: "consent_required" });
      return;
    }
    const ctx = await buildPdfInput(userId, id);
    if (!ctx) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const now = new Date();
    const bytes = await generateGpExportPdf({
      generatedAt: now,
      patient: {
        preferredName: ctx.profile?.preferredName ?? "",
        patientLang: ctx.appt.patientLang,
        nativeLanguage: ctx.profile?.nativeLanguage ?? ctx.appt.patientLang,
        clinicianLang: ctx.appt.clinicianLang,
        countryOfOrigin: ctx.profile?.countryOfOrigin ?? "",
        dateOfBirth: ctx.profile?.dateOfBirth ?? "",
        gpName: ctx.profile?.gpName ?? "",
        gpSurgery: ctx.profile?.gpSurgery ?? "",
      },
      intake: {
        lang: ctx.intake?.lang ?? ctx.appt.patientLang,
        answers: ctx.intake?.answers ?? {},
      },
      patientSummary: ctx.patientSummary
        ? {
            lang: ctx.patientSummary.lang,
            text: ctx.patientSummary.summary,
            confidence: ctx.patientSummary.confidence,
            notes: ctx.patientSummary.notes,
            edited: ctx.patientSummary.edited,
          }
        : null,
      clinicianSummary: ctx.clinicianSummary
        ? {
            lang: ctx.clinicianSummary.lang,
            text: ctx.clinicianSummary.summary,
            confidence: ctx.clinicianSummary.confidence,
            notes: ctx.clinicianSummary.notes,
          }
        : null,
      trends: ctx.trends,
    });
    const base64 = Buffer.from(bytes).toString("base64");
    const [row] = await db
      .insert(safeguardAppointmentExportsTable)
      .values({
        appointmentId: id,
        userId,
        generatedAt: now,
        pdfBase64: base64,
        byteSize: bytes.length,
      })
      .returning({
        id: safeguardAppointmentExportsTable.id,
        generatedAt: safeguardAppointmentExportsTable.generatedAt,
        byteSize: safeguardAppointmentExportsTable.byteSize,
      });
    res.json({ export: row });
  } catch (err) {
    next(err);
  }
});

router.get(
  "/me/appointments/:id/export/:exportId.pdf",
  async (req, res, next) => {
    try {
      const userId = req.auth!.userId;
      const exportId = req.params.exportId!;
      const id = req.params.id!;
      const rows = await db
        .select()
        .from(safeguardAppointmentExportsTable)
        .where(
          and(
            eq(safeguardAppointmentExportsTable.id, exportId),
            eq(safeguardAppointmentExportsTable.appointmentId, id),
            eq(safeguardAppointmentExportsTable.userId, userId),
          ),
        );
      const row = rows[0];
      if (!row) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const bytes = Buffer.from(row.pdfBase64, "base64");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="safeguard-${id}.pdf"`,
      );
      res.send(bytes);
    } catch (err) {
      next(err);
    }
  },
);

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

const FollowupBody = z.object({
  clinicianText: z.string().min(1).max(8000),
});

router.post("/me/appointments/:id/followup", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    if (!(await requireConsent(userId))) {
      res.status(403).json({ error: "consent_required" });
      return;
    }
    const appt = await loadAppointment(userId, id);
    if (!appt) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = FollowupBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }

    const result = await summarizeFollowup({
      clinicianText: parsed.data.clinicianText,
      clinicianLang: appt.clinicianLang as Lang,
      patientLang: appt.patientLang as Lang,
    });

    // Persist the recap as a follow-up "recap" item (kind=followup, no due).
    const inserted: Array<typeof safeguardFollowupsTable.$inferSelect> = [];
    for (const it of result.items) {
      const [row] = await db
        .insert(safeguardFollowupsTable)
        .values({
          appointmentId: id,
          userId,
          kind: it.kind,
          sourceLang: appt.clinicianLang,
          targetLang: appt.patientLang,
          titleOriginal: it.titleOriginal,
          titleTranslated: it.titleTranslated,
          detailOriginal: it.detailOriginal,
          detailTranslated: it.detailTranslated,
          plainExplanation: it.plainExplanation,
          confidence: it.confidence,
        })
        .returning();
      if (row) inserted.push(row);
    }

    await db
      .update(safeguardAppointmentsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(safeguardAppointmentsTable.id, id));

    res.json({
      recap: {
        original: result.recapOriginal,
        translated: result.recapTranslated,
        confidence: result.recapConfidence,
        notes: result.recapNotes,
        sourceLang: appt.clinicianLang,
        targetLang: appt.patientLang,
      },
      followups: inserted,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/me/followups", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const rows = await db
      .select()
      .from(safeguardFollowupsTable)
      .where(eq(safeguardFollowupsTable.userId, userId))
      .orderBy(desc(safeguardFollowupsTable.createdAt))
      .limit(50);
    res.json({ followups: rows });
  } catch (err) {
    next(err);
  }
});

router.post("/me/followups/:id/complete", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const id = req.params.id!;
    const [row] = await db
      .update(safeguardFollowupsTable)
      .set({ completedAt: new Date() })
      .where(
        and(
          eq(safeguardFollowupsTable.id, id),
          eq(safeguardFollowupsTable.userId, userId),
        ),
      )
      .returning();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ followup: row });
  } catch (err) {
    next(err);
  }
});

export default router;
