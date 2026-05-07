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

export type Lang = "en" | "uk" | "ar" | "ur" | "ps" | "so";
export const SUPPORTED_LANGS: readonly Lang[] = [
  "en",
  "uk",
  "ar",
  "ur",
  "ps",
  "so",
];

const LANG_NAME: Record<Lang, string> = {
  en: "English",
  uk: "Ukrainian",
  ar: "Arabic",
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
