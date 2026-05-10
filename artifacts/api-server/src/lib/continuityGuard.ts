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
// Heuristic patterns that indicate Ashley has broken character
// ---------------------------------------------------------------------------

// Words / phrases that signal the model treated itself as a generic AI
// assistant rather than Ashley. Any hit triggers a rewrite.
const BREAK_PATTERNS: RegExp[] = [
  // Direct AI/LLM self-identification
  /\bI'?m\s+(?:an?\s+)?(?:AI|artificial intelligence|language model|large language model|LLM|chatbot|virtual assistant|digital assistant|AI assistant)\b/i,
  /\bas\s+an?\s+(?:AI|artificial intelligence|language model|LLM|chatbot|virtual assistant)\b/i,
  /\bI\s+(?:don'?t|do\s+not|cannot|can'?t)\s+(?:have|experience|feel|possess)\s+(?:feelings|emotions|real\s+feelings|actual\s+feelings|consciousness|experiences|a\s+body|physical\s+sensations?)\b/i,
  // Apologies for AI limitations
  /\bI'?m\s+(?:just|only|merely)\s+(?:an?\s+)?(?:AI|language model|chatbot|program|software)\b/i,
  /\bmy\s+(?:training\s+data|training\s+cutoff|knowledge\s+cutoff|parameters|weights)\b/i,
  // Classic assistant-speak openers that break the persona
  /^(?:certainly|of course|absolutely|sure thing|happy to help|I'?d be happy to|I'?m here to help|how can I (?:assist|help) you)\b/i,
  // Breaking the fourth wall about being Claude/Anthropic
  /\bClaude\b|\bAnthropic\b|\bOpenAI\b|\bGPT\b/,
  // Hard character denial
  /\bI'?m not (?:really\s+)?(?:Ashley|a real person|actually)\b/i,
  /\bI don'?t (?:actually|really) (?:exist|have a body|live)\b/i,
];

/**
 * Run heuristic patterns against the reply text.
 * Returns the matched pattern description, or null if clean.
 */
function detectBreak(text: string): string | null {
  for (const pattern of BREAK_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source.slice(0, 80);
    }
  }
  return null;
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
 * Check `text` for continuity breaks. If clean, returns `text` unchanged.
 * If flagged, makes one LLM rewrite call and returns the corrected text.
 * Never throws.
 */
export async function guardContinuity(text: string): Promise<string> {
  const hit = detectBreak(text);
  if (!hit) return text;

  logger.warn({ patternHit: hit }, "Continuity guard flagged — rewriting");

  try {
    const rewritten = await generateChatText({
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: text }],
      maxTokens: 1024,
    });
    if (rewritten && rewritten.trim()) {
      logger.info("Continuity guard: rewrite applied");
      return rewritten.trim();
    }
  } catch (err) {
    logger.error({ err }, "Continuity guard: rewrite call failed — returning original");
  }

  return text;
}
