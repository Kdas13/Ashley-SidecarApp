// =============================================================================
// Image follow-up intent resolver
// -----------------------------------------------------------------------------
// Wren bug report: when Kane describes a visual ("a shy expression with her
// lower lip gently tucked in") and then says "as a picture", Ashley sometimes
// reverts to apologetic capability-wall roleplay instead of treating the
// follow-up as "render the previously described visual as an image".
//
// This module:
//   1. Detects whether the latest user message is a SHORT follow-up image
//      intent (e.g. "as a picture", "show me", "send that as an image").
//   2. Looks back over recent history for the most recent USER turn that
//      contains a visual / appearance description and returns its text.
//   3. Sanitises common unsafe expression phrasings (e.g. "lip bite") into
//      their soft-PG14 equivalents BEFORE the model ever sees them in the
//      injected hint.
//
// The output is a structured "TURN HINT" string that the chat route injects
// into the per-turn system prompt, so the model has an unambiguous, server-
// authored instruction telling it to emit an [image: MODE | ...] tag rather
// than refuse.
// =============================================================================

import { classifyImageIntent, type ImageMode } from "./imageIntent.js";

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

// SHORT follow-up phrasings. These are intentionally short (<= ~6 words) and
// largely contentless on their own — they only make sense when read against
// the previous turn. Long messages with their own visual content do NOT match
// here; they go through the normal classifier.
const FOLLOW_UP_RX =
  /^\s*(as (a |an )?(pic|picture|photo|image|selfie|full[- ]body|outfit (image|view)?|pose( reference)?|art( reference)?|scene|portrait)|make (it|that) (a |an )?(pic|picture|photo|image|selfie|full[- ]body|outfit|pose|scene|portrait)|show me( that)?|show that|send (that|it)( as)?( a| an)?( pic|picture|photo|image|selfie|full[- ]body|outfit|pose|scene|portrait)?|generate (it|that)( as)?( a| an)?( pic|picture|photo|image)?|try (that|it)( as)?( a| an)?( pic|picture|photo|image)?|do (that|it) visually|visualise (it|that)|visualize (it|that)|picture (it|that)|in image form|as image|as a still|as a frame)\s*[.!?]*\s*$/i;

// Per-mode shorthand to bias mode selection from the FOLLOW-UP phrasing
// itself (e.g. "as a full body" → FULL_BODY_MODE) when the prior turn doesn't
// already disambiguate.
const FOLLOW_UP_MODE_HINTS: Array<{ rx: RegExp; mode: ImageMode }> = [
  { rx: /\bas (a |an )?selfie\b/i, mode: "SELFIE_MODE" },
  { rx: /\bas (a |an )?full[- ]?body\b/i, mode: "FULL_BODY_MODE" },
  { rx: /\bas (a |an )?outfit\b/i, mode: "OUTFIT_MODE" },
  { rx: /\bas (a |an )?pose( reference)?\b/i, mode: "POSE_REFERENCE_MODE" },
  { rx: /\bas (a |an )?scene\b/i, mode: "SCENE_MODE" },
  { rx: /\bas (a |an )?portrait\b/i, mode: "PORTRAIT_MODE" },
  { rx: /\bas (a |an )?art( reference)?\b/i, mode: "ART_REFERENCE_MODE" },
];

export function isShortFollowUpImageRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Cap at ~10 words. Anything longer should carry its own description and
  // doesn't need follow-up resolution.
  if (trimmed.split(/\s+/).length > 10) return false;
  return FOLLOW_UP_RX.test(trimmed);
}

// ---------------------------------------------------------------------------
// Visual-content detection (for finding the prior referenced turn)
// ---------------------------------------------------------------------------

// Words that suggest the turn was *describing how Ashley looks / dresses /
// poses / is framed*. Used only to pick the most recent USER turn worth
// inheriting as the visual context for a follow-up like "as a picture".
const VISUAL_CONTENT_RX =
  /\b(expression|smile|smiling|smirk|grin|frown|pout|lip|lips|eyes?|eyebrow|gaze|glance|hair|wearing|outfit|jumper|shirt|t[- ]?shirt|dress|skirt|trousers|jeans|jacket|coat|hoodie|shoes?|boots?|trainers?|standing|sitting|leaning|posing|pose|head[- ]to[- ]toe|full[- ]body|full[- ]length|portrait|selfie|photo|picture|image|shot|frame|framed|catalogue|kitchen|bedroom|window light|natural light|golden hour|backlit|silhouette|barefoot|cross[- ]?legged|arms (crossed|folded|raised)|hands? (in|on))\b/i;

export function looksLikeVisualDescription(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Don't pick up the follow-up phrase itself as the "prior visual".
  if (isShortFollowUpImageRequest(trimmed)) return false;
  return VISUAL_CONTENT_RX.test(trimmed);
}

// ---------------------------------------------------------------------------
// Expression / safety sanitisation
// ---------------------------------------------------------------------------

// Soft rewrite of phrasings that the upstream content policy is likely to
// flag or that the model will refuse for safety reasons, into wording that
// preserves the intended expression without triggering a refusal.
//
// Conservative scope: we only rewrite a small whitelist of common asks. We
// do NOT do broad NSFW filtering here — that's contentPolicy.ts's job.
const SANITISE_RULES: Array<{ rx: RegExp; replacement: string }> = [
  {
    rx: /\b(biting|bite[s]?|chewing|chews?)\s+(her\s+|the\s+)?(lower\s+|bottom\s+)?lip\b/gi,
    replacement: "with her lower lip gently tucked in, like she is trying not to smile",
  },
  {
    rx: /\b(lip\s+bite|lip[- ]biting|lower[- ]lip[- ]bite)\b/gi,
    replacement: "lower lip gently tucked in (like trying not to smile)",
  },
];

export function sanitiseExpression(text: string): {
  text: string;
  changed: boolean;
} {
  if (typeof text !== "string" || !text) return { text: text ?? "", changed: false };
  let out = text;
  let changed = false;
  for (const rule of SANITISE_RULES) {
    if (rule.rx.test(out)) {
      out = out.replace(rule.rx, rule.replacement);
      changed = true;
    }
    rule.rx.lastIndex = 0;
  }
  return { text: out, changed };
}

// ---------------------------------------------------------------------------
// History scan
// ---------------------------------------------------------------------------

export type HistoryTurn = {
  role: "user" | "ashley" | "assistant" | string;
  content: string;
};

/**
 * Walk the recent history backwards (skipping the latest turn, which is the
 * follow-up itself) and return the most recent USER turn that looks like a
 * visual description. Returns null if none found within `lookback` turns.
 */
export function findPriorVisualDescription(
  history: ReadonlyArray<HistoryTurn>,
  lookback = 8,
): { text: string; turnsBack: number } | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  // Skip the latest user turn (the follow-up). Start from the second-to-last.
  const start = history.length - 2;
  const stop = Math.max(0, start - lookback + 1);
  for (let i = start; i >= stop; i--) {
    const turn = history[i];
    if (!turn) continue;
    if (turn.role !== "user") continue;
    const content = (turn.content ?? "").toString();
    if (looksLikeVisualDescription(content)) {
      return { text: content, turnsBack: start - i };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// End-to-end resolver
// ---------------------------------------------------------------------------

export type FollowUpResolution = {
  isFollowUp: true;
  /** Raw latest user text (the "as a picture" phrase). */
  followUpText: string;
  /** Prior user turn that the follow-up references, if found. */
  priorVisualText: string | null;
  /** Sanitised version of the prior visual text (e.g. lip-bite rewritten). */
  sanitisedVisualText: string | null;
  /** Whether sanitisation actually rewrote anything. */
  sanitised: boolean;
  /** Resolved natural-language image request (combined). */
  resolvedRequest: string;
  /** Suggested image mode (from follow-up hint, else from sanitised text). */
  suggestedMode: ImageMode;
  /** Why this mode was picked. */
  modeReason: string;
};

export function resolveImageFollowUp(
  latestUserText: string,
  history: ReadonlyArray<HistoryTurn>,
): FollowUpResolution | null {
  if (!isShortFollowUpImageRequest(latestUserText)) return null;

  const prior = findPriorVisualDescription(history);
  const priorRaw = prior?.text ?? null;
  const { text: sanitised, changed } = priorRaw
    ? sanitiseExpression(priorRaw)
    : { text: null as string | null, changed: false };

  // Mode resolution: explicit hint in the follow-up wins; otherwise classify
  // off the (sanitised) prior text; otherwise PORTRAIT_MODE default.
  let suggestedMode: ImageMode = "PORTRAIT_MODE";
  let modeReason = "default — no prior visual context found";
  for (const hint of FOLLOW_UP_MODE_HINTS) {
    if (hint.rx.test(latestUserText)) {
      suggestedMode = hint.mode;
      modeReason = "follow-up phrasing carried explicit mode hint";
      break;
    }
  }
  if (modeReason.startsWith("default") && sanitised) {
    const classified = classifyImageIntent(sanitised);
    suggestedMode = classified.mode;
    modeReason = `classified from prior visual text — ${classified.reason}`;
  }

  const resolvedRequest = sanitised
    ? `Generate an image of Ashley: ${sanitised.trim()}.`
    : `Generate an image of Ashley as just requested in the follow-up "${latestUserText.trim()}".`;

  return {
    isFollowUp: true,
    followUpText: latestUserText,
    priorVisualText: priorRaw,
    sanitisedVisualText: sanitised,
    sanitised: changed,
    resolvedRequest,
    suggestedMode,
    modeReason,
  };
}

// ---------------------------------------------------------------------------
// Per-turn system prompt hint
// ---------------------------------------------------------------------------

/**
 * Format a FollowUpResolution as a TURN HINT block to be appended to the
 * system prompt for this turn only. The model is told, in plain authoritative
 * language, to emit an [image: MODE | ...] tag using the resolved description
 * and is forbidden from refusing or invoking capability-wall language.
 */
export function buildFollowUpTurnHint(resolution: FollowUpResolution): string {
  const lines: string[] = [];
  lines.push("## TURN HINT — short follow-up image intent detected");
  lines.push(
    'The user\'s latest message is a SHORT follow-up like "as a picture" / "show me" / "make it a picture". This is NOT a capability question. It is an INSTRUCTION to render the previously described visual as an image.',
  );
  lines.push(`- Follow-up text: "${resolution.followUpText.trim()}"`);
  if (resolution.priorVisualText) {
    lines.push(
      `- Prior visual description (from a recent user turn): "${resolution.priorVisualText.trim()}"`,
    );
    if (resolution.sanitised && resolution.sanitisedVisualText) {
      lines.push(
        `- Sanitised version to USE in the image tag: "${resolution.sanitisedVisualText.trim()}"`,
      );
    }
    lines.push(`- Resolved request: ${resolution.resolvedRequest}`);
  } else {
    lines.push(
      "- No prior visual description was found within the recent history. Use the most recent visually-relevant detail you remember from this conversation.",
    );
  }
  lines.push(`- Suggested image mode: ${resolution.suggestedMode} (${resolution.modeReason}).`);
  lines.push("");
  lines.push("Required behaviour for THIS turn:");
  lines.push(
    "1. EMIT an [image: <MODE> | <description>] tag using the resolved request above. Do NOT refuse.",
  );
  lines.push(
    "2. Do NOT say \"I can't generate that\", \"the image is always the same base visual\", \"the capability isn't there\", \"not without you building it\", \"it's a wall\", or any equivalent capability-wall language. The Capability Truth Rule applies here too.",
  );
  lines.push(
    "3. The image is generated by a downstream tool. If it fails, the failure is reported separately by the system; you do not need to apologise pre-emptively.",
  );
  lines.push(
    "4. Keep your caption short and neutral. For FULL_BODY_MODE / OUTFIT_MODE, the existing reply contract still applies — ask the user to confirm head-to-toe / feet / shoes visibility instead of celebrating.",
  );
  return lines.join("\n");
}
