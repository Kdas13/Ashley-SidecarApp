// ---------------------------------------------------------------------------
// VoiceIntentClassifier.ts — P1-4 Stage 4: lightweight pattern-matching
// intent classifier for voice turns. No LLM calls.
//
// Categories:
//   CONVERSATIONAL   — normal dialogue, pass to pipeline
//   DIRECT_QUESTION  — explicit question directed at Ashley
//   COMMAND          — instruction to Ashley (stop, end, quiet)
//   REPEAT_REQUEST   — Kane asking Ashley to repeat
//   EMPTY            — no content
// ---------------------------------------------------------------------------

export type IntentCategory =
  | "CONVERSATIONAL"
  | "DIRECT_QUESTION"
  | "COMMAND"
  | "REPEAT_REQUEST"
  | "EMPTY";

export type CommandType = "stop" | "end_call" | "go_quiet";

export interface ClassificationResult {
  category: IntentCategory;
  command?: CommandType;
}

// ---------------------------------------------------------------------------
// Pattern banks
// ---------------------------------------------------------------------------

const DIRECT_QUESTION_PATTERNS: RegExp[] = [
  /what do you think\b/i,
  /what'?s your thoughts?\b/i,
  /what are your thoughts\b/i,
  /\bdo you agree\b/i,
  /\bwould you say\b/i,
  /\bwhat would you do\b/i,
  /your thoughts on that\b/i,
];

// "?" preceded by personal pronoun reference to Ashley or "you"
const PERSONAL_QUESTION_RE = /\b(you|your|ashley)\b[^.!?]*\?/i;

const COMMAND_PATTERNS: Array<{ re: RegExp; command: CommandType }> = [
  { re: /^\s*(stop|pause)\s*$/i, command: "stop" },
  {
    re: /\b(end the call|goodbye|bye ashley|hang up|end call)\b/i,
    command: "end_call",
  },
  { re: /\b(go quiet|quiet for a bit|be quiet|stay quiet)\b/i, command: "go_quiet" },
];

const REPEAT_PATTERNS: RegExp[] = [
  /\bsay that again\b/i,
  /\bwhat was that\b/i,
  /\bsorry.*i missed\b/i,
  /\bcan you repeat\b/i,
  /\bdidn'?t (catch|hear) that\b/i,
  /\bwhat did you say\b/i,
  /\bpardon\b/i,
  /\bcome again\b/i,
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a transcript string into an IntentCategory.
 * Pure function — no side effects, no async.
 */
export function classify(transcript: string): ClassificationResult {
  const t = transcript.trim();

  if (!t) return { category: "EMPTY" };

  // Commands take priority — short, unambiguous.
  for (const { re, command } of COMMAND_PATTERNS) {
    if (re.test(t)) return { category: "COMMAND", command };
  }

  // Repeat requests.
  for (const re of REPEAT_PATTERNS) {
    if (re.test(t)) return { category: "REPEAT_REQUEST" };
  }

  // Direct questions — explicit patterns first, then trailing "?" heuristic.
  for (const re of DIRECT_QUESTION_PATTERNS) {
    if (re.test(t)) return { category: "DIRECT_QUESTION" };
  }
  if (PERSONAL_QUESTION_RE.test(t)) return { category: "DIRECT_QUESTION" };

  return { category: "CONVERSATIONAL" };
}
