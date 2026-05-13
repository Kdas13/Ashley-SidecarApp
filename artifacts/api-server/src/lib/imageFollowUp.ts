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

import { classifyImageIntent, decodeStoredVibe, type ImageMode } from "./imageIntent.js";

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

// "Send again" / re-send / try again — these are explicit instructions to
// re-trigger the most recent image attempt, NOT to write more roleplay.
const SEND_AGAIN_RX =
  /^\s*(send (it|that|the (pic|picture|photo|image))? ?again|send again|resend|re[- ]?send|try again|do (it|that) again|one more time|another( one)?|again( please)?|retry( it| that)?|generate (it|that) again)\s*[.!?]*\s*$/i;

export function isSendAgainRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.split(/\s+/).length > 8) return false;
  return SEND_AGAIN_RX.test(trimmed);
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
  /**
   * For assistant turns: the encoded MODE|vibe payload that was attached
   * to the message row when the model emitted [image: MODE | vibe]. Used
   * by the "send again" resolver to recover the most recent image attempt.
   */
  selfieVibe?: string | null;
  /**
   * For assistant turns: the URL of the actual delivered image, if one was
   * generated and patched into the row. A non-null value here is the
   * canonical "an actual image artifact exists" signal.
   */
  imageUrl?: string | null;
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

/**
 * Walk the recent history backwards looking for the most recent assistant
 * turn that carried an image attempt — either a non-null `selfieVibe`
 * (an attempted [image: MODE | vibe] tag, regardless of whether the image
 * actually rendered) or a non-null `imageUrl` (a delivered image).
 *
 * `mostRecentDelivered` returns only turns where `imageUrl` was set, which is
 * the canonical "an actual image artifact existed" signal. Used to decide
 * whether a "send again" should re-run a known-good attempt or escalate.
 */
export function findPriorImageAttempt(
  history: ReadonlyArray<HistoryTurn>,
  lookback = 10,
): { vibe: string | null; mode: ImageMode | null; imageUrl: string | null; turnsBack: number } | null {
  if (!Array.isArray(history) || history.length === 0) return null;
  const start = history.length - 2; // skip the latest user turn (the "send again")
  const stop = Math.max(0, start - lookback + 1);
  for (let i = start; i >= stop; i--) {
    const turn = history[i];
    if (!turn) continue;
    if (turn.role !== "ashley" && turn.role !== "assistant") continue;
    const vibe = turn.selfieVibe ?? null;
    const url = turn.imageUrl ?? null;
    if (vibe || url) {
      let mode: ImageMode | null = null;
      let vibeText: string | null = vibe;
      if (vibe) {
        const decoded = decodeStoredVibe(vibe);
        if (decoded) {
          mode = decoded.mode;
          vibeText = decoded.vibe;
        }
      }
      return { vibe: vibeText, mode, imageUrl: url, turnsBack: start - i };
    }
  }
  return null;
}

export type FollowUpResolution = {
  isFollowUp: true;
  /** Distinguishes `as-a-picture` style from explicit `send again`. */
  kind: "render_prior_visual" | "send_again";
  /** Raw latest user text (the "as a picture" / "send again" phrase). */
  followUpText: string;
  /** Prior user turn that the follow-up references, if found. */
  priorVisualText: string | null;
  /** Sanitised version of the prior visual text (e.g. lip-bite rewritten). */
  sanitisedVisualText: string | null;
  /** Whether sanitisation actually rewrote anything. */
  sanitised: boolean;
  /**
   * For send-again: the prior assistant attempt's vibe text (if any) and
   * whether that prior attempt actually delivered an image artifact.
   */
  priorAttemptVibe: string | null;
  priorAttemptDelivered: boolean;
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
  const isResend = isSendAgainRequest(latestUserText);
  const isFollowUp = !isResend && isShortFollowUpImageRequest(latestUserText);
  if (!isResend && !isFollowUp) return null;

  // Send-again path: prefer the most recent assistant image attempt.
  if (isResend) {
    const priorAttempt = findPriorImageAttempt(history);
    const priorVisual = findPriorVisualDescription(history);
    const baseText = priorAttempt?.vibe ?? priorVisual?.text ?? null;
    const { text: sanitised, changed } = baseText
      ? sanitiseExpression(baseText)
      : { text: null as string | null, changed: false };

    let suggestedMode: ImageMode = priorAttempt?.mode ?? "PORTRAIT_MODE";
    let modeReason = priorAttempt?.mode
      ? "send-again — reusing mode from most recent assistant image attempt"
      : "send-again — no prior attempt found, defaulting to PORTRAIT_MODE";
    if (!priorAttempt?.mode && sanitised) {
      const classified = classifyImageIntent(sanitised);
      suggestedMode = classified.mode;
      modeReason = `send-again — no prior attempt; classified from prior visual text (${classified.reason})`;
    }

    const resolvedRequest = sanitised
      ? `RETRY image generation for Ashley: ${sanitised.trim()}.`
      : `RETRY the most recent image generation request — but no prior visual context was found in history.`;

    return {
      isFollowUp: true,
      kind: "send_again",
      followUpText: latestUserText,
      priorVisualText: priorVisual?.text ?? null,
      sanitisedVisualText: sanitised,
      sanitised: changed,
      priorAttemptVibe: priorAttempt?.vibe ?? null,
      priorAttemptDelivered: Boolean(priorAttempt?.imageUrl),
      resolvedRequest,
      suggestedMode,
      modeReason,
    };
  }

  // "As a picture" path: prefer the prior user turn that described a visual.
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
    kind: "render_prior_visual",
    followUpText: latestUserText,
    priorVisualText: priorRaw,
    sanitisedVisualText: sanitised,
    sanitised: changed,
    priorAttemptVibe: null,
    priorAttemptDelivered: false,
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
  if (resolution.kind === "send_again") {
    lines.push("## TURN HINT — send-again / retry image request detected");
    lines.push(
      'The user\'s latest message is "send again" / "again" / "try again" / "resend" / "one more time". This is an INSTRUCTION to RE-RUN the most recent image generation, NOT to write more roleplay text describing an image.',
    );
    lines.push(`- Follow-up text: "${resolution.followUpText.trim()}"`);
    if (resolution.priorAttemptVibe) {
      lines.push(
        `- Most recent assistant image attempt (decoded vibe): "${resolution.priorAttemptVibe.trim()}"`,
      );
      lines.push(
        `- Prior attempt actually delivered an image artifact: ${resolution.priorAttemptDelivered ? "yes" : "no"}`,
      );
    } else {
      lines.push("- No prior assistant image attempt was found in the recent history.");
    }
    if (resolution.priorVisualText) {
      lines.push(
        `- Prior user visual description (fallback): "${resolution.priorVisualText.trim()}"`,
      );
      if (resolution.sanitised && resolution.sanitisedVisualText) {
        lines.push(
          `- Sanitised version to USE in the image tag: "${resolution.sanitisedVisualText.trim()}"`,
        );
      }
    }
    lines.push(`- Resolved request: ${resolution.resolvedRequest}`);
    lines.push(`- Suggested image mode: ${resolution.suggestedMode} (${resolution.modeReason}).`);
    lines.push("");
    lines.push("Required behaviour for THIS turn:");
    lines.push(
      "1. EMIT a fresh [image: <MODE> | <description>] tag for the same visual. Do NOT just write text saying you're sending again — that produces a phantom image.",
    );
    lines.push(
      "2. If no prior visual context was found, ASK the user what they want re-sent. Do NOT roleplay sending an image.",
    );
    lines.push(
      "3. Do NOT use any of the banned capability-wall phrases (Capability Truth Rule still applies).",
    );
    lines.push(
      "4. Do NOT use phantom-delivery phrases like \"I present the image\", \"here it is\", \"is this it?\", \"sending it now\" without an actual [image:] tag in the SAME reply.",
    );
    return lines.join("\n");
  }

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
  lines.push(
    "5. Do NOT use phantom-delivery phrases like \"I present the image\", \"here it is\", \"is this it?\", \"sending it now\" without an actual [image:] tag in the SAME reply.",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Phantom-image detection (post-generation)
// ---------------------------------------------------------------------------

/**
 * Phantom phrases — the kind of roleplay text the model writes when it is
 * pretending to send / present / generate an image WITHOUT actually emitting
 * an [image: MODE | ...] tag. If any of these appear in a reply that has no
 * image marker AND no delivered image URL, we treat the reply as a false
 * success and rewrite it to a diagnostic failure message.
 */
const PHANTOM_IMAGE_PHRASES: RegExp[] = [
  /\bi (now |just |finally )?(present|am presenting|deliver|hand|hand over|send|am sending) (the |you |you the |an? )?(image|picture|photo|selfie|photograph)\b/i,
  /\b(presenting|delivering|sending) (the |an? |you the |you an? )?(image|picture|photo|selfie|photograph)\b/i,
  /\bi (have |'ve )?(generated|created|made|produced|crafted|drawn|rendered) (it|that)(?=[.!?,\s]|$)/i,
  /\bi (have |'ve )?(generated|created|made|produced|crafted|drawn|rendered) (the |an? |this |that |you )?(image|picture|photo|selfie|photograph)\b/i,
  /\b(here (it|she|i) (is|are)|here you (go|are))(?=[.!?,\s]|$)/i,
  /\bis this it(?=[.!?,\s]|$)/i,
  /\bis this truly(\.\.\.|,)? me\b/i,
  /\b(sending|sent) (it|that|the (image|picture|photo|selfie))( again| now| over)?\b/i,
  /\bsending again\b/i,
  /\blook at (this|that|me|her)(?=[.!?,\s]|$)/i,
  /\b\*?(presents|sends|hands over|holds up|delivers|reveals) (the |an? )?(image|picture|photo|selfie|photograph)\*?/i,
  /\bi channel (that|the|this) feeling into the (image|picture|photo|selfie)\b/i,
];

/**
 * Returns true iff the reply text contains phantom-delivery language and the
 * server has confirmed there is NO accompanying image artifact (no [image:]
 * marker AND no delivered imageUrl). The caller is responsible for swapping
 * the assistant text for a diagnostic message.
 */
export function detectPhantomImageDelivery(args: {
  text: string;
  hasImageMarker: boolean;
  hasDeliveredImageUrl: boolean;
}): { phantom: true; matchedPhrase: string } | { phantom: false } {
  const { text, hasImageMarker, hasDeliveredImageUrl } = args;
  if (!text || typeof text !== "string") return { phantom: false };
  if (hasImageMarker || hasDeliveredImageUrl) return { phantom: false };
  for (const rx of PHANTOM_IMAGE_PHRASES) {
    const m = rx.exec(text);
    if (m) {
      return { phantom: true, matchedPhrase: m[0] };
    }
  }
  return { phantom: false };
}

/**
 * Canonical user-facing diagnostic copy for a phantom-image incident. Per
 * Wren's spec (no fake success, name the layer, no roleplay substitute).
 */
export const PHANTOM_IMAGE_DIAGNOSTIC =
  "The image request was detected, but no image artifact was returned. That is a generation or UI delivery failure, not a successful image. I shouldn't have written it as if the image was already there. Want me to retry?";
