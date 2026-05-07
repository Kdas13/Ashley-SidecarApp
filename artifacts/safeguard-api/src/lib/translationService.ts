/**
 * AI service abstraction for Safeguard.
 *
 * Provider-agnostic surface, OpenAI-backed for the MVP. Three named methods
 * — `translate`, `summarizeCheckin`, `extractObservations` — so route code
 * never reaches around the abstraction. Swap providers by re-implementing
 * this module's exports; do NOT branch on provider in routes.
 *
 * SAFEGUARDING INVARIANT (human authority):
 *   Every prompt here is observational only. No advice, diagnosis, plan,
 *   "should", or escalation language. Drift = a safeguarding bug. Fix the
 *   prompt; never paper over with regex post-processing.
 */

import { openai, DEFAULT_MODEL } from "./openai";

export type Lang = "en" | "uk" | "ar" | "pl" | "ur" | "ps" | "so";
export const SUPPORTED_LANGS: readonly Lang[] = [
  "en",
  "uk",
  "ar",
  "pl",
  "ur",
  "ps",
  "so",
];

const LANG_NAME: Record<Lang, string> = {
  en: "English",
  uk: "Ukrainian",
  ar: "Arabic",
  pl: "Polish",
  ur: "Urdu",
  ps: "Pashto",
  so: "Somali",
};

export type Confidence = "high" | "medium" | "low";

export interface TranslationResult {
  translated: string;
  provider: string;
  model: string;
  confidence: Confidence;
  /** Free-text qualifications from the model — ambiguous idiom, untranslated proper noun, etc. */
  notes: string;
}

export interface CheckinScores {
  generalFeeling?: number;
  pain?: number;
  foodWater?: number;
  medication?: number;
  sleep?: number;
  safety?: number;
}

export interface CheckinSummary {
  summary: string;
  provider: string;
  model: string;
}

export interface ObservationExtraction {
  bullets: string[];
  flagged: boolean;
  provider: string;
  model: string;
}

export interface AppointmentSummaryResult {
  summary: string;
  confidence: Confidence;
  notes: string;
  provider: string;
  model: string;
}

export interface FollowupItemDraft {
  kind: "medication" | "followup" | "escalation";
  titleOriginal: string;
  detailOriginal: string;
  plainExplanation: string;
}

export interface FollowupSummaryResult {
  recapOriginal: string;
  recapTranslated: string;
  recapConfidence: Confidence;
  recapNotes: string;
  items: Array<
    FollowupItemDraft & {
      titleTranslated: string;
      detailTranslated: string;
      confidence: Confidence;
    }
  >;
  provider: string;
  model: string;
}

// ---------------------------------------------------------------------------
// translate
// ---------------------------------------------------------------------------

export async function translate(
  text: string,
  fromLang: Lang,
  toLang: Lang,
): Promise<TranslationResult> {
  if (fromLang === toLang || text.trim().length === 0) {
    return {
      translated: text,
      provider: "noop",
      model: "noop",
      confidence: "high",
      notes: "",
    };
  }
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You are a careful translator for a UK GP-continuity safeguarding ` +
          `app used by refugees. Translate from ${LANG_NAME[fromLang]} to ` +
          `${LANG_NAME[toLang]}. Preserve meaning and tone. Use plain ` +
          `language at roughly UK reading age 9. Do NOT add advice, ` +
          `diagnosis, or anything not present in the source. If a term has ` +
          `no good match, keep the original term in brackets after your ` +
          `best attempt.\n\n` +
          `Return JSON with exactly three keys:\n` +
          `  "translated": the translation only, no preamble.\n` +
          `  "confidence": "high" | "medium" | "low" — your honest ` +
          `assessment of how reliable the translation is.\n` +
          `  "notes": short free-text qualifications a clinician should know ` +
          `(ambiguous idiom, name kept untranslated, dialect uncertainty). ` +
          `Empty string if none.`,
      },
      { role: "user", content: text },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { translated?: string; confidence?: string; notes?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const translated = (parsed.translated ?? "").trim();
  const confidence: Confidence =
    parsed.confidence === "high" || parsed.confidence === "low"
      ? parsed.confidence
      : translated.length > 0
        ? "medium"
        : "low";
  return {
    translated,
    provider: "openai",
    model: DEFAULT_MODEL,
    confidence,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

// ---------------------------------------------------------------------------
// summarizeCheckin
// ---------------------------------------------------------------------------

function scoreLines(scores: CheckinScores): string {
  return Object.entries(scores)
    .filter(([, v]) => typeof v === "number")
    .map(([k, v]) => `- ${k}: ${v}/10`)
    .join("\n");
}

export async function summarizeCheckin(args: {
  rawText: string;
  rawLang: Lang;
  scores: CheckinScores;
  outputLang: Lang;
}): Promise<CheckinSummary> {
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You produce strictly observational summaries for a UK GP-continuity ` +
          `safeguarding app used by refugees. You are NOT a clinician. You ` +
          `do NOT give advice, diagnoses, treatment suggestions, or ` +
          `escalation recommendations. Write in ${LANG_NAME[args.outputLang]}, ` +
          `third-person about "the user", plain UK reading-age-9 language.\n\n` +
          `Return JSON with one key "summary": one short paragraph ` +
          `(max 60 words) describing what the user reported today. No ` +
          `interpretation beyond restating the numeric scores in words and ` +
          `quoting the user's own concerns. No "should". No plans.`,
      },
      {
        role: "user",
        content:
          `User wrote (in ${LANG_NAME[args.rawLang]}):\n"""\n${args.rawText}\n"""\n\n` +
          `Self-reported scores (0=worst, 10=best, except pain where 10=worst):\n` +
          `${scoreLines(args.scores) || "(none)"}\n`,
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { summary?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    provider: "openai",
    model: DEFAULT_MODEL,
  };
}

// ---------------------------------------------------------------------------
// extractObservations
// ---------------------------------------------------------------------------

export async function extractObservations(args: {
  rawText: string;
  rawLang: Lang;
  scores: CheckinScores;
  outputLang: Lang;
}): Promise<ObservationExtraction> {
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `Extract neutral, observational bullets from a refugee user's daily ` +
          `wellbeing check-in for a UK GP-continuity app. You are NOT a ` +
          `clinician. NO advice, diagnosis, plans, or "should" statements.\n\n` +
          `Write in ${LANG_NAME[args.outputLang]}. Third-person about "the user".\n\n` +
          `Return JSON with two keys:\n` +
          `  "bullets": array of 1-4 short strings. Each is a single neutral ` +
          `observation (e.g. "User reported pain 7/10 in lower back"). Quote ` +
          `the user's own words where it changes meaning to paraphrase.\n` +
          `  "flagged": boolean. Set true if any bullet describes an immediate ` +
          `safety concern (self-harm intent, urgent medical symptom, abuse, ` +
          `unsafe housing). When true, prefix the relevant bullet(s) with the ` +
          `literal token "[FLAG]" and quote the user's words verbatim.`,
      },
      {
        role: "user",
        content:
          `User wrote (in ${LANG_NAME[args.rawLang]}):\n"""\n${args.rawText}\n"""\n\n` +
          `Self-reported scores (0=worst, 10=best, except pain where 10=worst):\n` +
          `${scoreLines(args.scores) || "(none)"}\n`,
      },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { bullets?: unknown; flagged?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const bullets = Array.isArray(parsed.bullets)
    ? parsed.bullets.filter((o): o is string => typeof o === "string")
    : [];
  const flagged =
    parsed.flagged === true || bullets.some((b) => b.startsWith("[FLAG]"));
  return {
    bullets,
    flagged,
    provider: "openai",
    model: DEFAULT_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Appointment-prep summaries (patient + clinician)
// ---------------------------------------------------------------------------

export interface AppointmentIntakeAnswers {
  mainConcern?: string;
  symptomDuration?: string;
  severity?: string;
  medications?: string;
  allergies?: string;
  sleep?: string;
  appetite?: string;
  painLevel?: string;
  mentalHealth?: string;
  safeguarding?: string;
}

function intakeBlock(intake: AppointmentIntakeAnswers): string {
  const labels: Record<keyof AppointmentIntakeAnswers, string> = {
    mainConcern: "Main concern",
    symptomDuration: "How long it has been happening",
    severity: "How bad it feels",
    medications: "Current medications",
    allergies: "Known allergies",
    sleep: "Sleep",
    appetite: "Appetite",
    painLevel: "Pain level",
    mentalHealth: "Mental health (the user's words)",
    safeguarding: "Safety concerns (the user's words)",
  };
  const lines: string[] = [];
  for (const k of Object.keys(labels) as Array<keyof AppointmentIntakeAnswers>) {
    const v = (intake[k] ?? "").trim();
    if (v.length > 0) lines.push(`- ${labels[k]}: ${v}`);
  }
  return lines.join("\n") || "(no answers given)";
}

function parseSummaryJson(raw: string): {
  summary: string;
  confidence: Confidence;
  notes: string;
} {
  let parsed: { summary?: unknown; confidence?: unknown; notes?: unknown } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* keep defaults */
  }
  const summary =
    typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const confidence: Confidence =
    parsed.confidence === "high" || parsed.confidence === "low"
      ? parsed.confidence
      : summary.length > 0
        ? "medium"
        : "low";
  const notes = typeof parsed.notes === "string" ? parsed.notes : "";
  return { summary, confidence, notes };
}

export async function summarizeForPatient(args: {
  intake: AppointmentIntakeAnswers;
  intakeLang: Lang;
  patientLang: Lang;
}): Promise<AppointmentSummaryResult> {
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You produce a plain-language patient-facing summary for a UK ` +
          `GP-continuity safeguarding app used by refugees. Write in ` +
          `${LANG_NAME[args.patientLang]} at roughly UK reading age 9. ` +
          `Address the patient directly ("you"). Restate what the patient ` +
          `said so they can review and edit it before the appointment. ` +
          `Do NOT add advice, diagnosis, treatment, or "should". Do NOT ` +
          `add anything not present in the source.\n\n` +
          `Return JSON with three keys:\n` +
          `  "summary": one short paragraph (max 90 words) using the ` +
          `patient's words where possible.\n` +
          `  "confidence": "high" | "medium" | "low".\n` +
          `  "notes": short qualifications a clinician should know about ` +
          `the translation/restatement (ambiguity, missing context). Empty ` +
          `string if none.`,
      },
      {
        role: "user",
        content:
          `Intake (in ${LANG_NAME[args.intakeLang]}):\n${intakeBlock(args.intake)}`,
      },
    ],
  });
  const parsed = parseSummaryJson(
    completion.choices[0]?.message?.content ?? "{}",
  );
  return { ...parsed, provider: "openai", model: DEFAULT_MODEL };
}

export async function summarizeForClinician(args: {
  intake: AppointmentIntakeAnswers;
  intakeLang: Lang;
  clinicianLang: Lang;
}): Promise<AppointmentSummaryResult> {
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You produce a concise clinician-facing summary for a UK GP ` +
          `appointment. The patient is a refugee. Write in ` +
          `${LANG_NAME[args.clinicianLang]} using standard UK general-` +
          `practice terminology (presenting complaint, duration, severity, ` +
          `current medications, allergies, sleep/appetite, pain level, ` +
          `observed mental health concerns, safeguarding observations). ` +
          `You are NOT a clinician. Do NOT diagnose, triage, advise, ` +
          `prescribe, or use "should". Mental-health and safeguarding ` +
          `content is OBSERVATIONAL only — quote the patient's words and ` +
          `frame as "patient reports..." for human review.\n\n` +
          `Return JSON with three keys:\n` +
          `  "summary": one structured paragraph or short bullets (max ` +
          `180 words). Clinical terminology where appropriate. Quote the ` +
          `patient verbatim where it changes meaning to paraphrase.\n` +
          `  "confidence": "high" | "medium" | "low".\n` +
          `  "notes": short qualifications about translation reliability or ` +
          `missing intake fields. Empty string if none.`,
      },
      {
        role: "user",
        content:
          `Intake (in ${LANG_NAME[args.intakeLang]}):\n${intakeBlock(args.intake)}`,
      },
    ],
  });
  const parsed = parseSummaryJson(
    completion.choices[0]?.message?.content ?? "{}",
  );
  return { ...parsed, provider: "openai", model: DEFAULT_MODEL };
}

// ---------------------------------------------------------------------------
// translateUtterance — same shape as `translate` but with explicit naming
// for the bidirectional translation workspace; it also tags the system
// prompt with the speaker so the model can adjust register (clinician
// terminology vs lay phrasing).
// ---------------------------------------------------------------------------

export async function translateUtterance(args: {
  text: string;
  fromLang: Lang;
  toLang: Lang;
  speaker: "patient" | "clinician";
}): Promise<TranslationResult> {
  if (args.fromLang === args.toLang || args.text.trim().length === 0) {
    return {
      translated: args.text,
      provider: "noop",
      model: "noop",
      confidence: "high",
      notes: "",
    };
  }
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You translate a single utterance during a live UK GP appointment ` +
          `for a refugee patient. The speaker is the ${args.speaker}. ` +
          `Translate from ${LANG_NAME[args.fromLang]} to ` +
          `${LANG_NAME[args.toLang]}. Preserve meaning and tone. Use plain ` +
          `language at roughly UK reading age 9 when the listener is the ` +
          `patient; preserve clinical terminology when the listener is the ` +
          `clinician. Do NOT add advice, interpretation, or anything not ` +
          `present in the source. If a term has no good match, keep the ` +
          `original term in brackets after your best attempt.\n\n` +
          `Return JSON with three keys:\n` +
          `  "translated": the translation only.\n` +
          `  "confidence": "high" | "medium" | "low".\n` +
          `  "notes": short qualifications (ambiguous idiom, dialect ` +
          `uncertainty, untranslated term). Empty string if none.`,
      },
      { role: "user", content: args.text },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { translated?: string; confidence?: string; notes?: string } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const translated = (parsed.translated ?? "").trim();
  const confidence: Confidence =
    parsed.confidence === "high" || parsed.confidence === "low"
      ? parsed.confidence
      : translated.length > 0
        ? "medium"
        : "low";
  return {
    translated,
    provider: "openai",
    model: DEFAULT_MODEL,
    confidence,
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
  };
}

// ---------------------------------------------------------------------------
// summarizeFollowup — clinician's instructions in → translated patient
// recap + structured follow-up items out.
// ---------------------------------------------------------------------------

export async function summarizeFollowup(args: {
  clinicianText: string;
  clinicianLang: Lang;
  patientLang: Lang;
}): Promise<FollowupSummaryResult> {
  const completion = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          `You take a clinician's after-appointment notes (in ` +
          `${LANG_NAME[args.clinicianLang]}) and produce two outputs for a ` +
          `refugee patient: (1) a plain-language recap in ` +
          `${LANG_NAME[args.patientLang]} (UK reading age 9), and (2) a ` +
          `structured list of follow-up items.\n\n` +
          `You are NOT a clinician. Do NOT add advice, diagnosis, or ` +
          `instructions the clinician did not give. Preserve the ` +
          `clinician's wording — translate, do not invent.\n\n` +
          `Return JSON with these keys:\n` +
          `  "recapOriginal": the clinician's notes restated cleanly in ` +
          `${LANG_NAME[args.clinicianLang]} (one short paragraph).\n` +
          `  "recapTranslated": the same recap translated to ` +
          `${LANG_NAME[args.patientLang]}.\n` +
          `  "recapConfidence": "high" | "medium" | "low".\n` +
          `  "recapNotes": translation qualifications, empty string if none.\n` +
          `  "items": array of objects each with:\n` +
          `    "kind": "medication" | "followup" | "escalation".\n` +
          `    "titleOriginal": short title in ${LANG_NAME[args.clinicianLang]}.\n` +
          `    "titleTranslated": same title in ${LANG_NAME[args.patientLang]}.\n` +
          `    "detailOriginal": one-line detail (e.g. dose + frequency, or ` +
          `"return in 2 weeks"), in ${LANG_NAME[args.clinicianLang]}.\n` +
          `    "detailTranslated": same detail in ${LANG_NAME[args.patientLang]}.\n` +
          `    "plainExplanation": for medication/followup, a one-sentence ` +
          `plain-language reason in ${LANG_NAME[args.patientLang]}; for ` +
          `escalation, the explicit "return if X worsens" clause in ` +
          `${LANG_NAME[args.patientLang]}.\n` +
          `    "confidence": "high" | "medium" | "low".`,
      },
      { role: "user", content: args.clinicianText },
    ],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  type RawItem = {
    kind?: unknown;
    titleOriginal?: unknown;
    titleTranslated?: unknown;
    detailOriginal?: unknown;
    detailTranslated?: unknown;
    plainExplanation?: unknown;
    confidence?: unknown;
  };
  let parsed: {
    recapOriginal?: unknown;
    recapTranslated?: unknown;
    recapConfidence?: unknown;
    recapNotes?: unknown;
    items?: unknown;
  } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const conf = (v: unknown): Confidence =>
    v === "high" || v === "low" ? v : "medium";
  const items = Array.isArray(parsed.items)
    ? (parsed.items as RawItem[])
        .map((it) => {
          const kind: FollowupItemDraft["kind"] =
            it.kind === "medication" ||
            it.kind === "followup" ||
            it.kind === "escalation"
              ? it.kind
              : "followup";
          return {
            kind,
            titleOriginal:
              typeof it.titleOriginal === "string" ? it.titleOriginal : "",
            titleTranslated:
              typeof it.titleTranslated === "string" ? it.titleTranslated : "",
            detailOriginal:
              typeof it.detailOriginal === "string" ? it.detailOriginal : "",
            detailTranslated:
              typeof it.detailTranslated === "string" ? it.detailTranslated : "",
            plainExplanation:
              typeof it.plainExplanation === "string"
                ? it.plainExplanation
                : "",
            confidence: conf(it.confidence),
          };
        })
        .filter((it) => it.titleOriginal.length > 0 || it.detailOriginal.length > 0)
    : [];
  return {
    recapOriginal:
      typeof parsed.recapOriginal === "string" ? parsed.recapOriginal : "",
    recapTranslated:
      typeof parsed.recapTranslated === "string" ? parsed.recapTranslated : "",
    recapConfidence: conf(parsed.recapConfidence),
    recapNotes: typeof parsed.recapNotes === "string" ? parsed.recapNotes : "",
    items,
    provider: "openai",
    model: DEFAULT_MODEL,
  };
}
