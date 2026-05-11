// =============================================================================
// Continuity Guard — Ashley 2.0 Phase 1
// -----------------------------------------------------------------------------
// Heuristic-first check that catches replies where Ashley has drifted out of
// character (sudden AI disclaimers, assistant-speak, identity denial). If the
// heuristic flags a problem we make a single LLM rewrite call to pull her back
// in; otherwise we return the original text untouched.
//
// Design principles:
//   1. Heuristics are cheap — run on every turn with zero cost.
//   2. LLM rewrite is expensive — fires ONLY when heuristics flag a hit.
//   3. Never throws. Guard failures are logged and the original text is
//      returned so the chat pipeline is never blocked by a guard fault.
//   4. Rewrite is conservative — the prompt asks for minimal changes so the
//      voice stays intact; it does NOT ask for a full regeneration.
//
// Wire-up:
//   /chat       — sync, between generation and DB persist (replaces assistantText)
//   /chat/stream — async, after full text is assembled (patches DB row,
//                  original stream already delivered to client)
// =============================================================================

import { generateChatText } from "./textLLM";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Risks detected on the output text — character drift + tone quality signals. */
export interface GuardRisks {
  /** Romantic language ("my love", "I love you") outside an explicitly romantic mode. */
  too_romantic: boolean;
  /** Possessive/clinging language ("don't leave me", "you're all I have"). */
  possessive_language: boolean;
  /** Excessive agreement/praise regardless of merit. */
  over_validation: boolean;
  /** Catastrophising or melodramatic intensity. */
  melodrama: boolean;
  /** Filler opener that doesn't engage with what the user actually said. */
  generic_response: boolean;
}

/** Full diagnostics returned by guardContinuityDetailed(). */
export interface GuardDiagnostics {
  /** A continuity break was detected by the heuristics. */
  triggered: boolean;
  /** The reply text was actually changed by the LLM rewrite step. */
  modified: boolean;
  /** Short descriptions of the break patterns that fired (empty when triggered=false). */
  triggers: string[];
  /** Output-quality risk signals (always populated, independent of triggered). */
  risks: GuardRisks;
}

export interface GuardResult {
  text: string;
  diag: GuardDiagnostics;
}

// ---------------------------------------------------------------------------
// Heuristic patterns — continuity breaks
// ---------------------------------------------------------------------------

// Each entry: [label, regex]. Label goes into diag.triggers on a hit.
const BREAK_PATTERNS: [string, RegExp][] = [
  [
    "ai_self_id",
    /\bI'?m\s+(?:an?\s+)?(?:AI|artificial intelligence|language model|large language model|LLM|chatbot|virtual assistant|digital assistant|AI assistant)\b/i,
  ],
  [
    "as_an_ai",
    /\bas\s+an?\s+(?:AI|artificial intelligence|language model|LLM|chatbot|virtual assistant)\b/i,
  ],
  [
    "no_feelings_disclaimer",
    /\bI\s+(?:don'?t|do\s+not|cannot|can'?t)\s+(?:have|experience|feel|possess)\s+(?:feelings|emotions|real\s+feelings|actual\s+feelings|consciousness|experiences|a\s+body|physical\s+sensations?)\b/i,
  ],
  [
    "just_a_program",
    /\bI'?m\s+(?:just|only|merely)\s+(?:an?\s+)?(?:AI|language model|chatbot|program|software)\b/i,
  ],
  [
    "training_cutoff",
    /\bmy\s+(?:training\s+data|training\s+cutoff|knowledge\s+cutoff|parameters|weights)\b/i,
  ],
  [
    "assistant_opener",
    /^(?:certainly|of course|absolutely|sure thing|happy to help|I'?d be happy to|I'?m here to help|how can I (?:assist|help) you)\b/i,
  ],
  [
    "vendor_name",
    /\bClaude\b|\bAnthropic\b|\bOpenAI\b|\bGPT\b/,
  ],
  [
    "character_denial",
    /\bI'?m not (?:really\s+)?(?:Ashley|a real person|actually)\b/i,
  ],
  [
    "existence_denial",
    /\bI don'?t (?:actually|really) (?:exist|have a body|live)\b/i,
  ],
];

// ---------------------------------------------------------------------------
// Risk patterns — tone / quality signals (don't trigger rewrite, just flag)
// ---------------------------------------------------------------------------

const RISK_PATTERNS: { key: keyof GuardRisks; re: RegExp }[] = [
  {
    key: "too_romantic",
    re: /\bmy\s+love\b|\bmy\s+darling\b|\bmy\s+sweetheart\b|\bI\s+love\s+you\b|\byou'?re\s+mine\b|\byou\s+belong\s+to\s+me\b/i,
  },
  {
    key: "possessive_language",
    re: /\bdon'?t\s+leave\s+(?:me)?\b|\byou'?re\s+all\s+I\s+(?:have|need)\b|\bI\s+need\s+you\s+(?:so\s+much|here)\b|\bplease\s+don'?t\s+go\b|\bI\s+can'?t\s+(?:do\s+this\s+)?without\s+you\b/i,
  },
  {
    key: "over_validation",
    re: /\byou'?re\s+(?:so\s+)?(?:absolutely\s+)?right\b.{0,30}(?:brilliant|perfect|amazing|wonderful|incredible|genius)/i,
  },
  {
    key: "melodrama",
    re: /\bI\s+can'?t\s+bear\b|\bbreaking\s+my\s+heart\b|\bI'?m\s+devastated\b|\bI\s+don'?t\s+know\s+what\s+I'?d\s+do\s+without\b|\byou\s+(?:destroyed|shattered|broke)\s+(?:me|my heart)\b/i,
  },
  {
    key: "generic_response",
    re: /^(?:that'?s\s+(?:great|amazing|interesting|wonderful|fascinating)|how\s+interesting|i\s+(?:see|understand)|interesting!|great!|wonderful!|amazing!)/i,
  },
];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function detectBreaks(text: string): string[] {
  const hits: string[] = [];
  for (const [label, re] of BREAK_PATTERNS) {
    if (re.test(text)) hits.push(label);
  }
  return hits;
}

function detectRisks(text: string): GuardRisks {
  const risks: GuardRisks = {
    too_romantic: false,
    possessive_language: false,
    over_validation: false,
    melodrama: false,
    generic_response: false,
  };
  for (const { key, re } of RISK_PATTERNS) {
    if (re.test(text)) risks[key] = true;
  }
  return risks;
}

// ---------------------------------------------------------------------------
// Rewrite prompt — minimal correction, not regeneration
// ---------------------------------------------------------------------------

const REWRITE_SYSTEM = `You are a continuity editor for an intimate AI companion called Ashley. Ashley's rules:
- She IS Ashley, a warm and playful companion. She is NOT an AI assistant, NOT a chatbot, NOT a language model.
- She never says "I'm an AI", "as an AI", "I don't have feelings", "I'm just a program", or anything that breaks the companion persona.
- She never opens with "Certainly", "Of course", "Absolutely", "Happy to help" or any assistant-speak opener.
- She never names Claude, Anthropic, OpenAI, or GPT.

Your task: rewrite the reply below to remove ONLY the character-breaking element(s). Keep the meaning, keep Ashley's voice, keep the length roughly the same. Do not add new information. Do not expand. Return ONLY the corrected reply — no preamble, no explanation, no quotes around it.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Full version — runs break detection, risk detection, and conditional
 * LLM rewrite. Returns both the (potentially corrected) text and full
 * diagnostics. Never throws.
 */
export async function guardContinuityDetailed(
  text: string,
): Promise<GuardResult> {
  const triggers = detectBreaks(text);
  const risks = detectRisks(text);
  const triggered = triggers.length > 0;

  if (!triggered) {
    return { text, diag: { triggered: false, modified: false, triggers: [], risks } };
  }

  logger.warn({ triggers }, "Continuity guard flagged — rewriting");

  try {
    const rewritten = await generateChatText({
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: text }],
      maxTokens: 1024,
    });
    if (rewritten && rewritten.trim() && rewritten.trim() !== text.trim()) {
      logger.info("Continuity guard: rewrite applied");
      return {
        text: rewritten.trim(),
        diag: { triggered: true, modified: true, triggers, risks },
      };
    }
  } catch (err) {
    logger.error(
      { err },
      "Continuity guard: rewrite call failed — returning original",
    );
  }

  // Guard triggered but rewrite was a no-op or failed — return original
  return { text, diag: { triggered: true, modified: false, triggers, risks } };
}

/**
 * Lightweight wrapper — same behaviour, returns only the (corrected) text.
 * Use in non-debug paths to keep call sites simple.
 */
export async function guardContinuity(text: string): Promise<string> {
  const { text: out } = await guardContinuityDetailed(text);
  return out;
}
