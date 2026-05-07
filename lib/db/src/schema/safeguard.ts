/**
 * Safeguard pilot — schema.
 *
 * Hard-namespaced from Ashley: every table prefixed `safeguard_`. No FKs
 * cross between Ashley and Safeguard tables. Both products share the
 * Postgres instance because Replit projects get one managed Postgres, but
 * they share nothing else.
 *
 * Identity model: `id` is the Clerk user id (`user_xxx`). All per-user
 * tables FK to `safeguard_users.id` so deleting a user cascades.
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  boolean,
  uuid,
  index,
  jsonb,
} from "drizzle-orm/pg-core";

export const safeguardUsersTable = pgTable("safeguard_users", {
  // Clerk user id — owned externally, treated as opaque string.
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    withTimezone: true,
  }),
});

export const safeguardProfilesTable = pgTable("safeguard_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
  preferredName: text("preferred_name").notNull().default(""),
  // ISO 639-1: en | uk | ar | ur | ps | so. The UI surface language.
  preferredLanguage: text("preferred_language").notNull().default("en"),
  // First language the user actually thinks in. May equal preferredLanguage
  // when their first language is one of the supported UI surfaces, but the
  // GP needs to know it explicitly for interpreter booking.
  nativeLanguage: text("native_language").notNull().default("en"),
  // Optional second language they're comfortable being communicated in
  // (e.g. some Arabic, working English). Empty when none.
  secondaryLanguage: text("secondary_language").notNull().default(""),
  // "low" | "medium" | "high" — self-reported reading/writing comfort in
  // their preferred language. Drives whether `accessibilitySimplified` is
  // recommended and whether long-form prompts are kept short.
  literacyLevel: text("literacy_level").notNull().default("medium"),
  countryOfOrigin: text("country_of_origin").notNull().default(""),
  // Free text — UK GP often only needs year; storing as string keeps
  // partial dates ("1987", "1987-04") representable without coercion.
  dateOfBirth: text("date_of_birth").notNull().default(""),
  gpName: text("gp_name").notNull().default(""),
  gpSurgery: text("gp_surgery").notNull().default(""),
  ongoingConcerns: text("ongoing_concerns").notNull().default(""),
  currentMedications: text("current_medications").notNull().default(""),
  // Accessibility toggles — all boolean, all default off so we never
  // assume what the user needs.
  accessibilityLargeText: boolean("accessibility_large_text")
    .notNull()
    .default(false),
  accessibilityHighContrast: boolean("accessibility_high_contrast")
    .notNull()
    .default(false),
  accessibilityAudio: boolean("accessibility_audio").notNull().default(false),
  accessibilitySimplified: boolean("accessibility_simplified")
    .notNull()
    .default(false),
  accessibilitySlowerPacing: boolean("accessibility_slower_pacing")
    .notNull()
    .default(false),
  // Optional trusted contact — surfaced in the support sheet alongside
  // statutory numbers. Phone is a free-text string; we don't validate it
  // because international refugee numbers vary wildly.
  trustedContactName: text("trusted_contact_name").notNull().default(""),
  trustedContactRelation: text("trusted_contact_relation")
    .notNull()
    .default(""),
  trustedContactPhone: text("trusted_contact_phone").notNull().default(""),
  // Hard consent gate. Both must be true to make a check-in. Stored as
  // booleans + a timestamp so we can surface "you consented on <date>"
  // back to the user later.
  consentStorage: boolean("consent_storage").notNull().default(false),
  consentAiProcessing: boolean("consent_ai_processing")
    .notNull()
    .default(false),
  consentRecordedAt: timestamp("consent_recorded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const safeguardCheckinsTable = pgTable(
  "safeguard_checkins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Language the user wrote `freeText` in.
    lang: text("lang").notNull().default("en"),
    freeText: text("free_text").notNull().default(""),
    // 0..10 self-reports; nullable individually so the user can skip any.
    // Six required scores per the spec: general feeling, pain, food/water,
    // medication taken, sleep, felt safety.
    generalFeelingScore: integer("general_feeling_score"),
    painScore: integer("pain_score"),
    foodWaterScore: integer("food_water_score"),
    medicationScore: integer("medication_score"),
    sleepScore: integer("sleep_score"),
    safetyScore: integer("safety_score"),
    // Legacy columns kept nullable so older rows still read. New writes
    // use the six scores above.
    moodScore: integer("mood_score"),
    energyScore: integer("energy_score"),
    appetiteScore: integer("appetite_score"),
  },
  (t) => [index("safeguard_checkins_user_created_idx").on(t.userId, t.createdAt)],
);

export const safeguardObservationsTable = pgTable(
  "safeguard_observations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    // Per-checkin observations FK to the checkin; trend observations
    // (repeated distress, missed check-in) leave this null and live as
    // synthetic rows generated server-side.
    checkinId: uuid("checkin_id").references(
      () => safeguardCheckinsTable.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // "checkin" | "trend_repeated_distress" | "trend_missed_checkin"
    kind: text("kind").notNull().default("checkin"),
    // Strictly observational — see safeguardingInvariants.human_authority.
    summary: text("summary").notNull().default(""),
    bullets: jsonb("bullets").$type<string[]>().notNull().default([]),
    // True if any bullet is tagged with the [FLAG] safety token, OR if
    // the trend logic detected a sustained low-score / safety pattern.
    flagged: boolean("flagged").notNull().default(false),
    outputLang: text("output_lang").notNull().default("en"),
  },
  (t) => [
    index("safeguard_observations_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
  ],
);

/**
 * GP appointments. One row per planned/in-progress/completed appointment.
 * `patientLang` and `clinicianLang` are the two languages negotiated for
 * this session — both stored so the PDF can label them and the translation
 * workspace can default correctly.
 */
export const safeguardAppointmentsTable = pgTable(
  "safeguard_appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // "draft" (intake in progress) | "ready" (intake complete, summaries done)
    // | "in_session" (translation workspace open) | "completed" (follow-up
    // captured). The state isn't gated server-side beyond what the routes
    // require — it exists so the UI can pick up where the user left off.
    status: text("status").notNull().default("draft"),
    patientLang: text("patient_lang").notNull().default("en"),
    clinicianLang: text("clinician_lang").notNull().default("en"),
    title: text("title").notNull().default(""),
  },
  (t) => [
    index("safeguard_appointments_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
  ],
);

/**
 * Intake answers — captured one-question-at-a-time in the patient's
 * language. Stored as a flexible jsonb map of well-known keys (mainConcern,
 * symptomDuration, severity, medications, allergies, sleep, appetite,
 * painLevel, mentalHealth, safeguarding) so the schema doesn't need a
 * migration each time we tweak the question set. The patient's raw words
 * are preserved verbatim per the safeguarding invariants.
 */
export const safeguardAppointmentIntakeTable = pgTable(
  "safeguard_appointment_intake",
  {
    appointmentId: uuid("appointment_id")
      .primaryKey()
      .references(() => safeguardAppointmentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    lang: text("lang").notNull().default("en"),
    answers: jsonb("answers")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
);

/**
 * Dual summaries derived from a single intake. One row per audience so we
 * can store the patient-facing plain-language version (in patient lang)
 * AND the clinician version (in clinician lang) side-by-side. Both are
 * AI-generated from the same source — `confidence` is the AI's self-report
 * and is surfaced on every screen and in the PDF.
 */
export const safeguardAppointmentSummariesTable = pgTable(
  "safeguard_appointment_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => safeguardAppointmentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    // "patient" | "clinician"
    audience: text("audience").notNull(),
    lang: text("lang").notNull(),
    summary: text("summary").notNull(),
    // patient summary is editable by the user; clinician summary is not.
    edited: boolean("edited").notNull().default(false),
    confidence: text("confidence").notNull().default("medium"),
    notes: text("notes").notNull().default(""),
    provider: text("provider").notNull().default("openai"),
    model: text("model").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("safeguard_appointment_summaries_appt_idx").on(t.appointmentId),
  ],
);

/**
 * Translation workspace utterances. One row per back-and-forth utterance.
 * `translationId` references the existing translations table — never
 * collapses original + translated into a single field.
 */
export const safeguardAppointmentUtterancesTable = pgTable(
  "safeguard_appointment_utterances",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => safeguardAppointmentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    // "patient" | "clinician"
    speaker: text("speaker").notNull(),
    translationId: uuid("translation_id").references(
      () => safeguardTranslationsTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("safeguard_appointment_utterances_appt_created_idx").on(
      t.appointmentId,
      t.createdAt,
    ),
  ],
);

/**
 * GP-export PDFs. We store the bytes inline (bytea) so a re-download is
 * stable even if the input data is later edited; the original at-time-of-
 * export PDF is the durable artifact a clinician may have already filed.
 */
export const safeguardAppointmentExportsTable = pgTable(
  "safeguard_appointment_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => safeguardAppointmentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // base64-encoded bytes of the generated PDF. Storing as text keeps the
    // schema portable and avoids a bytea dependency in drizzle-pg.
    pdfBase64: text("pdf_base64").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
  },
  (t) => [
    index("safeguard_appointment_exports_appt_idx").on(t.appointmentId),
  ],
);

/**
 * Post-appointment follow-up items: medication reminders, follow-up
 * appointments, and explicit escalation notes ("return if X worsens").
 * Original clinician wording AND translated patient-facing wording are
 * stored separately per the original-wording-preserved invariant.
 */
export const safeguardFollowupsTable = pgTable(
  "safeguard_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => safeguardAppointmentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    // "medication" | "followup" | "escalation"
    kind: text("kind").notNull(),
    sourceLang: text("source_lang").notNull().default("en"),
    targetLang: text("target_lang").notNull(),
    titleOriginal: text("title_original").notNull(),
    titleTranslated: text("title_translated").notNull(),
    detailOriginal: text("detail_original").notNull().default(""),
    detailTranslated: text("detail_translated").notNull().default(""),
    // For "escalation" rows this is the "return if X worsens" clause; for
    // medication/followup it is the plain-language explanation of why.
    plainExplanation: text("plain_explanation").notNull().default(""),
    confidence: text("confidence").notNull().default("medium"),
    dueAt: timestamp("due_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("safeguard_followups_user_created_idx").on(t.userId, t.createdAt),
  ],
);

export const safeguardTranslationsTable = pgTable(
  "safeguard_translations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => safeguardUsersTable.id, { onDelete: "cascade" }),
    // Optional link back to the originating check-in.
    checkinId: uuid("checkin_id").references(
      () => safeguardCheckinsTable.id,
      { onDelete: "cascade" },
    ),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sourceLang: text("source_lang").notNull(),
    targetLang: text("target_lang").notNull(),
    sourceText: text("source_text").notNull(),
    translatedText: text("translated_text").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    // "high" | "medium" | "low" — see translationService.
    confidence: text("confidence").notNull().default("medium"),
    // Free-text qualifications from the model (e.g. "ambiguous idiom",
    // "name kept untranslated"). Surfaced to the GP alongside the text.
    notes: text("notes").notNull().default(""),
  },
  (t) => [
    index("safeguard_translations_user_created_idx").on(
      t.userId,
      t.createdAt,
    ),
  ],
);
