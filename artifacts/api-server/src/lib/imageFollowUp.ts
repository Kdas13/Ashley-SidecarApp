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

import {
  classifyImageIntent,
  decodeStoredVibe,
  encodeStoredVibe,
  type ImageMode,
} from "./imageIntent.js";

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

// Foot-visible-retry triggers (Wren spec, May 2026 follow-up). When the user
// reports that the most recent FULL_BODY attempt cropped feet / shoes / floor,
// we reuse the prior vibe and escalate to FOOT_VISIBLE_RETRY mode without any
// clarifying round-trip. These phrases overlap with IMAGE_DIAGNOSTIC_RX
// (cropped / missing) so detection MUST run before the diagnostic suppression
// in isDirectImageRequest — handled by checking foot-retry first in
// resolveImageFollowUp below.
const FOOT_VISIBLE_RETRY_RX =
  /\b(no feet|feet missing|shoes? missing|floor missing|feet cropped|shoes? cropped|cut off at (the )?(ankles?|calves|feet|shoes?)|not head[- ]?to[- ]?toe|try stricter|retry stricter)\b/i;

export function isFootVisibleRetryRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Cap a little wider than other resolvers — phrases like "cut off at the
  // ankles" are 5 words and a short complaint sentence around them is fine.
  if (trimmed.split(/\s+/).length > 14) return false;
  return FOOT_VISIBLE_RETRY_RX.test(trimmed);
}

// Seated-lengthwise hard-gate triggers (Wren follow-up, May 2026 #4). The
// classifier already routes short forms ("sofa lengthways", "sitting
// lengthwise"), but Kane's fallback prompt was a long, detailed brief
// (~50 words) that exceeded isDirectImageRequest's 18-word cap and was
// answered with romantic prose instead of an image action. The hard gate
// here has NO word-count cap.
//
// Architect-review hardening (May 2026): split triggers into STRONG and
// WEAK. STRONG phrases are unambiguous image-pose language that hardly ever
// occurs in everyday conversation ("reclining lengthways across the sofa",
// "body runs horizontally across the couch", "wide landscape full-body
// sofa image") — they fire on their own. WEAK phrases ("sofa lengthways",
// "head near left armrest") COULD appear in furniture/comfort talk and
// only fire when paired with image-intent context OR with another weak
// signal. This avoids hard-gating ordinary sofa chat into image generation.
const SEATED_LENGTHWISE_STRONG_RX =
  /\b(reclin(e|ing)\s+lengthw(ay|ise)s?\s+(across|along)\s+(the\s+)?(sofa|couch)|sitting\s+lengthw(ay|ise)s?\s+(along|across|on)\s+(the\s+)?(sofa|couch)|body\s+runs\s+horizontally\s+across\s+(the\s+)?(sofa|couch|cushions?)|legs\s+stretched\s+along\s+(the\s+)?(sofa|couch)|wide\s+landscape\s+full[- ]body\s+(sofa|couch)\s+(image|picture|photo|shot)|side[- ]on\s+(sofa|couch)\s+full\s+body|lying\s+lengthw(ay|ise)s?\s+(along|across|on)\s+(the\s+)?(sofa|couch))\b/i;

const SEATED_LENGTHWISE_WEAK_RX_LIST: ReadonlyArray<RegExp> = [
  /\b(sofa|couch)\s+lengthw(ay|ise)s?\b/i,
  /\blengthw(ay|ise)s?\s+(along|across)\s+(the\s+)?(sofa|couch)\b/i,
  /\bhead\s+near\s+(the\s+)?left\s+armrest\b/i,
  /\bfeet\s+near\s+(the\s+)?right\s+armrest\b/i,
  /\b(full|entire)\s+sofa\s+visible\b/i,
  /\blying\s+along\s+(the\s+)?(sofa|couch)\b/i,
];

// Image-intent context that promotes a single weak seated signal to a
// hard-gate fire. Kept narrow — same vocabulary the rest of this module
// already uses to detect image asks.
const SEATED_IMAGE_CONTEXT_RX =
  /\b(image|picture|photo|photograph|pic|selfie|portrait|render|generate|create|draw|show me|send me|full[- ]?body|whole[- ]?body|head[- ]to[- ]toe|wide\s+landscape|pulled[- ]?back\s+camera|side[- ]on\s+(camera|view))\b/i;

export function isSeatedLengthwiseImageRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // No word-count cap — Kane's spec prompts are long.
  if (SEATED_LENGTHWISE_STRONG_RX.test(trimmed)) return true;
  let weakHits = 0;
  for (const rx of SEATED_LENGTHWISE_WEAK_RX_LIST) {
    if (rx.test(trimmed)) weakHits++;
    if (weakHits >= 2) return true;
  }
  if (weakHits >= 1 && SEATED_IMAGE_CONTEXT_RX.test(trimmed)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Direct image request detection (no prior visual context required)
// ---------------------------------------------------------------------------
//
// Wren follow-up: short messages like "whole body picture", "send me a photo",
// "selfie please", "show me head to toe" are first-class image requests, not
// follow-ups. The model was sometimes treating them as romantic prompts and
// producing roleplay narration instead of emitting an [image:] tag. We detect
// them on the server, classify the mode via classifyImageIntent, and inject a
// TURN HINT that orders the model to emit an [image:] tag for THIS turn.

// Image-request nouns, split into two tiers.
//
// STRONG nouns are unambiguous in everyday English — `selfie` / `portrait` /
// `picture` / `image` / `photo` / `photograph` / `pic`. They fire on
// noun+verb or noun+request-framing.
//
// WEAK nouns (`shot`, `visual`, `render`) have strong non-image senses
// ("a shot of vodka", "give me a visual / a render of the idea") and only
// count as image nouns when paired with a framing qualifier (full-body,
// head-to-toe, outfit, pose, scene). The architect review caught "a shot
// please" misfiring as PORTRAIT_MODE — this split is the fix.
const IMAGE_NOUN_STRONG_RX =
  /\b(picture|image|photo|photograph|pic|selfie|portrait)\b/i;
const IMAGE_NOUN_WEAK_RX = /\b(render|visual|shot)\b/i;
const IMAGE_NOUN_RX =
  /\b(picture|image|photo|photograph|pic|render|visual|shot|selfie|portrait)\b/i;

// Image-request action verbs. On their own these are weaker than nouns, but
// combined with a body / outfit / pose qualifier they are sufficient to fire
// (e.g. "show me head to toe", "send me your full body").
const IMAGE_VERB_RX = /\b(show me|send me|generate|create|draw|render)\b/i;

// Body / framing qualifiers that — combined with a verb OR a noun —
// strongly imply an image request, even if no explicit noun is present.
// Reuses the same vocabulary the classifier uses for FULL_BODY_MODE.
const FRAMING_QUALIFIER_RX =
  /\b(full[- ]?body|whole[- ]?body|entire[- ]?body|complete[- ]?body|full[- ]?length|head[- ]?to[- ]?toe|outfit|pose|scene)\b/i;

// Diagnostic / reporting phrases — talking ABOUT an image rather than asking
// for one ("the picture didn't render", "no image came through", "why no
// photo"). If any of these appear we suppress direct-image-request firing so
// the model isn't pushed into emitting an [image:] tag for a complaint.
const IMAGE_DIAGNOSTIC_RX =
  /\b(didn'?t render|did not render|failed( to render)?|no (image|picture|photo|artifact)|not shown|wasn'?t (shown|sent|delivered)|why (no|isn'?t there)|cropped|broken|blank|missing|never (came|arrived)|where('?s| is) (the|my) (image|picture|photo|selfie))\b/i;

// Bare image-request phrasings that are unambiguous enough to fire on a noun
// alone. Anything outside this set must come with an imperative verb / polite
// request / question framing to qualify (see isDirectImageRequest below).
//
// Deliberately EXCLUDES `shot`, `visual`, and `render` — those words have
// strong non-image senses ("a shot of vodka", "give me a visual / a render
// of the idea") and the architect review flagged them as deterministic
// misfires now that the gate is hard. They still qualify via noun+framing
// or noun+verb, just not on their own.
const BARE_NOUN_REQUEST_RX =
  /^\s*(a |an |another |one more |another one )?(selfie|portrait|picture|image|photo|photograph|pic)( please| pls)?\s*[.!?]*\s*$/i;

// Imperative / polite-request framings that legitimise "noun + framing"
// short messages ("whole body picture", "full-body shot please", "give me a
// selfie", "can I get a portrait", "would love a photo of you").
const REQUEST_FRAMING_RX =
  /\b(please|pls|can (you|i)|could (you|i)|would (you|i)|may i|i (want|need|would like|'?d like)|give me|let me see|let'?s see|how about|do you have|got (a |an )?(selfie|picture|photo|image|pic|shot|portrait))\b/i;

// "Try a picture / try an image / try a selfie / do that as a picture /
// make/show that as a picture" — natural-language image asks that the
// original IMAGE_VERB_RX (`show me|send me|generate|create|draw|render`)
// didn't catch. Wren's live test: "Try a picture with your tongue out"
// was answered with romantic prose because `try` wasn't a recognised
// image verb.
//
// Architect-review hardening (May 2026, second pass): the original
// patterns false-fired on planning/conversational text like "I'll try
// that image later", "let's do that as an image tomorrow", "try a shot
// first", "could you show that visually in text". Three changes:
//   1. Anchor TRY/DO to message start (after optional polite filler).
//      Strips the "I'll try ..." / "we'll do ..." / "let's do ..." class.
//   2. Drop weak noun `shot` — too many non-image senses ("a shot of
//      vodka", "give it a shot first").
//   3. Drop the bare "visually" branch from MAKE_THAT_VISUAL — keep only
//      "make/show that/this/it as a/an picture|image|photo|selfie|...".
//   4. Suppress matches whose clause carries explicit future-tense or
//      planning markers (later|tomorrow|tonight|next time|in a bit).
// `(?!\s+(?:frame|...))` blocks the most common noun-compound false-
// positives ("try a picture frame for the wall", "try a photo book").
const TRY_IMAGE_NOUN_COMPOUND_BLOCK = "(?!\\s+(?:frame|frames|book|books|album|albums|day|days|perfect|op|ops|hanger|hangers|message|messages))";
const TRY_IMAGE_REQUEST_RX = new RegExp(
  "^(\\s*(please|pls|ok|okay|hey|so|maybe|how about|why not|let'?s)\\s*[, ]+)?(try|do)\\s+(a|an|one|that|it|this)(\\s+as\\s+(a|an))?\\s+(picture|image|selfie|photo|photograph|pic|portrait)\\b" +
    TRY_IMAGE_NOUN_COMPOUND_BLOCK,
  "i",
);
const MAKE_THAT_VISUAL_RX = new RegExp(
  "^(\\s*(please|pls|ok|okay|hey|so|maybe|how about|why not|let'?s)\\s*[, ]+)?(make|show)\\s+(that|this|it)\\s+as\\s+(a|an)\\s+(picture|image|photo|selfie|portrait|pic)\\b" +
    TRY_IMAGE_NOUN_COMPOUND_BLOCK,
  "i",
);
// Narrowed per architect-review pass 3: only explicitly temporal markers.
// Bare `after` / `when you|we` was suppressing legitimate immediate asks
// like "try a picture when you smile" or "try a picture after the wink".
const TRY_IMAGE_FUTURE_PLAN_RX =
  /\b(later|tomorrow|tonight|next time|in (a |the )?(bit|moment|sec(ond)?|minute|hour|while)|some other time|another time)\b/i;
// Pass-4: catch deferred asks that use first-person `when i|we` clauses
// or `after <activity-noun>` (work/dinner/the meeting/...). These are
// not immediate. Distinct from immediate positives like "when you smile",
// "after the wink", "when you can".
const TRY_IMAGE_DEFERRED_PLAN_RX =
  /\bwhen\s+(i|we)\b|\bafter\s+(work|dinner|lunch|breakfast|class|school|the\s+(meeting|call|appointment|appt|date|trip|drive|commute|gym|workout|nap|shower))\b/i;

// Expression / face-focused descriptors that imply close-up framing. When
// a try-image / direct request matches one of these, we override a
// PORTRAIT_MODE classifier result to SELFIE_MODE — the user is asking for
// an expression shot, not a head-and-shoulders portrait. Per Wren May 2026
// spec ("tongue out, smile, playful, cheeky, expression, wink, bashful,
// lip tucked, trying not to smile, gotcha").
const EXPRESSION_DESCRIPTOR_RX =
  /\b(tongue\s+out|tongue|smile|smiling|smirk|smirking|grin|grinning|playful|cheeky|wink|winking|bashful|lip\s+tucked|trying\s+not\s+to\s+smile|gotcha|expression|pout|pouting|laugh(ing)?|giggl(ing|e)|raised\s+eyebrow|side[-\s]eye|making\s+a\s+face|silly\s+face)\b/i;

export function isTryImageRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.split(/\s+/).length > 30) return false;
  if (IMAGE_DIAGNOSTIC_RX.test(trimmed)) return false;
  // Suppress future-tense / planning matches: "let's try a picture later",
  // "do that as an image tomorrow" — the user is sketching a plan, not
  // asking right now.
  if (TRY_IMAGE_FUTURE_PLAN_RX.test(trimmed)) return false;
  if (TRY_IMAGE_DEFERRED_PLAN_RX.test(trimmed)) return false;
  return TRY_IMAGE_REQUEST_RX.test(trimmed) || MAKE_THAT_VISUAL_RX.test(trimmed);
}

export function hasExpressionDescriptor(text: string): boolean {
  return typeof text === "string" && EXPRESSION_DESCRIPTOR_RX.test(text);
}

export function isDirectImageRequest(text: string): boolean {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  // "Try a picture..." / "Do that as an image" / "Make that visual" hard-
  // fire BEFORE the word-cap and verb checks. They are unambiguous image
  // asks even when the surrounding sentence is descriptive (e.g. "try a
  // picture with your tongue out, as if to almost say like, yeah, gotcha"
  // — 14 words but the original verb set didn't include `try`).
  if (isTryImageRequest(trimmed)) return true;
  // Cap length — long messages with their own paragraphs of narrative go
  // through the model's normal intent detection.
  if (trimmed.split(/\s+/).length > 18) return false;
  // Don't double-fire with the short follow-up resolver or send-again.
  if (isShortFollowUpImageRequest(trimmed)) return false;
  if (isSendAgainRequest(trimmed)) return false;
  // Suppress on diagnostic / reporting language — the user is talking ABOUT
  // a previous image, not asking for a new one.
  if (IMAGE_DIAGNOSTIC_RX.test(trimmed)) return false;

  const hasStrongNoun = IMAGE_NOUN_STRONG_RX.test(trimmed);
  const hasAnyNoun = IMAGE_NOUN_RX.test(trimmed);
  const hasVerb = IMAGE_VERB_RX.test(trimmed);
  const hasFraming = FRAMING_QUALIFIER_RX.test(trimmed);

  // Bare noun phrasings ("selfie", "a picture please") are explicit enough.
  if (BARE_NOUN_REQUEST_RX.test(trimmed)) return true;
  // ANY noun + body/outfit framing ("whole body picture", "full-body shot",
  // "outfit photo") is unambiguously a request even without a verb. Weak
  // nouns (`shot`, `visual`, `render`) need framing here, by construction.
  if (hasAnyNoun && hasFraming) return true;
  // STRONG noun + verb / polite request framing ("send me a photo", "can I
  // get a portrait", "give me a selfie") is unambiguous. Weak nouns are
  // intentionally excluded here — "a shot please" / "give me a render"
  // would otherwise misfire (architect review, May 2026).
  if (hasStrongNoun && (hasVerb || REQUEST_FRAMING_RX.test(trimmed))) return true;
  // Verb + framing without an explicit noun ("show me head to toe") still
  // qualifies — these are imperative image asks by construction.
  if (hasVerb && hasFraming) return true;
  void IMAGE_NOUN_WEAK_RX;
  return false;
}

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
  kind:
    | "render_prior_visual"
    | "send_again"
    | "direct_image_request"
    | "foot_visible_retry";
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
  /** Mode of the prior assistant image attempt, when one was found. Set by
   *  the foot-visible-retry path so the gate log can surface
   *  `previousImageMode` as a structured field. */
  priorAttemptMode?: ImageMode | null;
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
  // Foot-visible-retry runs FIRST. The trigger phrases overlap with
  // IMAGE_DIAGNOSTIC_RX ("cropped", "missing"), so deferring to the normal
  // resolvers would suppress this path. Requires a prior assistant image
  // attempt to reuse — without one we fall through.
  if (isFootVisibleRetryRequest(latestUserText)) {
    const priorAttempt = findPriorImageAttempt(history);
    const priorVibe = priorAttempt?.vibe ?? null;
    if (priorAttempt && priorVibe) {
      const { text: sanitised, changed } = sanitiseExpression(priorVibe);
      const usable = sanitised && sanitised.trim() ? sanitised : priorVibe;
      // Escalation ladder: FULL_BODY_MODE → FOOT_VISIBLE_RETRY → EXTREME.
      // If the prior attempt was already a FOOT_VISIBLE_RETRY (or the prior
      // EXTREME, in which case we stay at EXTREME — there is nothing wider),
      // bump up one rung. Anything else escalates to FOOT_VISIBLE_RETRY.
      const priorMode = priorAttempt.mode ?? null;
      // Seated-lengthwise has its own composition (landscape sofa shot).
      // Escalating that to vertical EXTREME_WIDE would discard the pose.
      // Re-run SEATED_LENGTHWISE_FULL_BODY_MODE itself instead.
      const escalatedMode: ImageMode =
        priorMode === "SEATED_LENGTHWISE_FULL_BODY_MODE"
          ? "SEATED_LENGTHWISE_FULL_BODY_MODE"
          : priorMode === "FOOT_VISIBLE_RETRY" ||
              priorMode === "EXTREME_WIDE_FULL_BODY_RETRY"
            ? "EXTREME_WIDE_FULL_BODY_RETRY"
            : "FOOT_VISIBLE_RETRY";
      const escalatedReason =
        escalatedMode === "SEATED_LENGTHWISE_FULL_BODY_MODE"
          ? "prior attempt was a seated-lengthwise sofa shot and feet were still cropped — re-running same mode (no vertical escalation that would lose the pose)"
          : escalatedMode === "EXTREME_WIDE_FULL_BODY_RETRY"
            ? `prior attempt was already ${priorMode} and feet/shoes/floor still cropped — escalating to EXTREME_WIDE_FULL_BODY_RETRY with prior vibe`
            : "user reported feet/shoes/floor cropped — escalating to FOOT_VISIBLE_RETRY with prior vibe";
      return {
        isFollowUp: true,
        kind: "foot_visible_retry",
        followUpText: latestUserText,
        priorVisualText: null,
        sanitisedVisualText: usable,
        sanitised: changed,
        priorAttemptVibe: priorVibe,
        priorAttemptDelivered: Boolean(priorAttempt.imageUrl),
        priorAttemptMode: priorMode,
        resolvedRequest: `${escalatedMode === "EXTREME_WIDE_FULL_BODY_RETRY" ? "EXTREME-WIDE FULL-BODY RETRY" : "STRICTER FULL-BODY RETRY"} (feet/shoes/floor were cropped on the previous attempt): ${usable.trim()}`,
        suggestedMode: escalatedMode,
        modeReason: escalatedReason,
      };
    }
    // No prior attempt to retry — fall through and let the normal resolvers
    // (or the caller) decide what to do with the message.
  }

  // Seated-lengthwise hard-gate path. Runs before the direct/short/send-again
  // detectors so a long Kane-spec prompt ("reclining lengthways across the
  // sofa, head near left armrest, feet near right armrest, ...") routes
  // straight to image generation in SEATED_LENGTHWISE_FULL_BODY_MODE instead
  // of being answered as conversation. No prior history required.
  if (isSeatedLengthwiseImageRequest(latestUserText)) {
    const { text: sanitised, changed } = sanitiseExpression(latestUserText);
    return {
      isFollowUp: true,
      kind: "direct_image_request",
      followUpText: latestUserText,
      priorVisualText: null,
      sanitisedVisualText: sanitised,
      sanitised: changed,
      priorAttemptVibe: null,
      priorAttemptDelivered: false,
      resolvedRequest: `Generate a wide landscape full-body image of Ashley reclining lengthways across the sofa: ${sanitised.trim()}.`,
      suggestedMode: "SEATED_LENGTHWISE_FULL_BODY_MODE",
      modeReason:
        "matched seated-lengthwise hard-gate trigger — bypassing romantic-prose path",
    };
  }

  const isResend = isSendAgainRequest(latestUserText);
  const isFollowUp = !isResend && isShortFollowUpImageRequest(latestUserText);
  const isDirect =
    !isResend && !isFollowUp && isDirectImageRequest(latestUserText);
  if (!isResend && !isFollowUp && !isDirect) return null;

  // Direct image request path. No prior visual context required — the latest
  // user text IS the visual brief. We classify the mode off the same text and
  // build a TURN HINT ordering an immediate [image:] tag.
  if (isDirect) {
    const { text: sanitised, changed } = sanitiseExpression(latestUserText);
    const classified = classifyImageIntent(sanitised);
    let finalMode: ImageMode = classified.mode;
    let finalReason = classified.reason;
    // "Try a picture with your tongue out" classifies as PORTRAIT_MODE
    // (no full-body / outfit / scene cues, no explicit `selfie` keyword).
    // When a try-image / make-that-visual ask is paired with an expression
    // descriptor (tongue out, smirk, wink, gotcha, ...), prefer SELFIE_MODE
    // so the framing stays close-up on the face. Per Wren May 2026 spec.
    if (
      isTryImageRequest(sanitised) &&
      hasExpressionDescriptor(sanitised) &&
      (finalMode === "PORTRAIT_MODE" || finalMode === "SELFIE_MODE")
    ) {
      finalMode = "SELFIE_MODE";
      finalReason =
        "try-a-picture / make-that-visual with expression descriptor — using SELFIE_MODE for face-focused framing";
    }
    const resolvedRequest = `Generate an image of Ashley: ${sanitised.trim()}.`;
    return {
      isFollowUp: true,
      kind: "direct_image_request",
      followUpText: latestUserText,
      priorVisualText: null,
      sanitisedVisualText: sanitised,
      sanitised: changed,
      priorAttemptVibe: null,
      priorAttemptDelivered: false,
      resolvedRequest,
      suggestedMode: finalMode,
      modeReason: `direct image request — ${finalReason}`,
    };
  }

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
  if (resolution.kind === "direct_image_request") {
    lines.push("## TURN HINT — direct image request detected");
    lines.push(
      "The user's latest message is a DIRECT image request (e.g. \"whole body picture\", \"send me a photo\", \"selfie please\", \"show me head to toe\"). It is NOT an invitation to write romantic or roleplay narration. It is an instruction to emit an [image: <MODE> | <description>] tag for THIS turn so the downstream image generator runs.",
    );
    lines.push(`- User text: "${resolution.followUpText.trim()}"`);
    if (resolution.sanitised && resolution.sanitisedVisualText) {
      lines.push(
        `- Sanitised version to USE in the image tag: "${resolution.sanitisedVisualText.trim()}"`,
      );
    }
    lines.push(`- Resolved request: ${resolution.resolvedRequest}`);
    lines.push(
      `- Suggested image mode: ${resolution.suggestedMode} (${resolution.modeReason}).`,
    );
    lines.push("");
    lines.push("Required behaviour for THIS turn (action-first):");
    lines.push(
      "1. EMIT an [image: <MODE> | <description>] tag using the resolved request above. The mode hint is authoritative — if the user said \"whole body / full body / head to toe / entire body / complete body / body shot / standing photo\", use FULL_BODY_MODE. If they said \"outfit\", use OUTFIT_MODE. If they said \"selfie\", use SELFIE_MODE. Otherwise use the suggested mode.",
    );
    lines.push(
      "2. Do NOT write romantic / focus / manifestation narration BEFORE the image tag (\"I focus every pixel\", \"I manifest the image\", \"I try with all my being\", \"a moment of concentration passes\"). Tag first; one short neutral caption around it is enough.",
    );
    lines.push(
      "3. Do NOT claim the image was sent / generated / presented unless the SAME reply contains an [image:] tag. The downstream tool either renders an artifact or it doesn't — the No Artifact, No Claim rule applies.",
    );
    lines.push(
      "4. Do NOT use any of the banned capability-wall phrases (Capability Truth Rule still applies) and do NOT use phantom-delivery phrases (\"I present the image\", \"here it is\", \"is this it?\", \"sending it now\") without an actual [image:] tag in the SAME reply.",
    );
    lines.push(
      "5. For FULL_BODY_MODE / OUTFIT_MODE the existing reply contract still applies: short neutral caption asking the user to confirm head-to-toe / feet / shoes visibility, no celebration.",
    );
    return lines.join("\n");
  }
  if (resolution.kind === "foot_visible_retry") {
    lines.push("## TURN HINT — foot-visible retry detected");
    lines.push(
      "The user reported that the most recent FULL_BODY attempt cropped feet, shoes, or the floor. This is an INSTRUCTION to re-run the same visual with stricter wider framing — NOT a capability question and NOT an invitation to apologise.",
    );
    lines.push(`- Follow-up text: "${resolution.followUpText.trim()}"`);
    if (resolution.priorAttemptVibe) {
      lines.push(
        `- Most recent assistant image attempt (decoded vibe): "${resolution.priorAttemptVibe.trim()}"`,
      );
    }
    if (resolution.sanitisedVisualText) {
      lines.push(
        `- Sanitised version to USE in the image tag: "${resolution.sanitisedVisualText.trim()}"`,
      );
    }
    lines.push(`- Resolved request: ${resolution.resolvedRequest}`);
    lines.push(
      `- Suggested image mode: ${resolution.suggestedMode} (${resolution.modeReason}).`,
    );
    lines.push("");
    lines.push("Required behaviour for THIS turn:");
    lines.push(
      `1. EMIT a fresh [image: ${resolution.suggestedMode} | <description>] tag reusing the prior visual. Do NOT re-ask what to render.`,
    );
    lines.push(
      "2. Caption it briefly along the lines of: \"That attempt still failed full-body validation: feet/shoes/floor are not visible. I'll retry with wider framing.\" No apologies, no roleplay narration.",
    );
    lines.push(
      "3. Do NOT use phantom-delivery phrases (\"here it is\", \"is this it?\", \"sending it now\") without an actual [image:] tag in the SAME reply.",
    );
    return lines.join("\n");
  }

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
  // Pre-generation manifestation / focus narration (Action-first rule).
  // These describe an imagined image act WITHOUT the [image:] tag firing.
  /\bi focus every pixel\b/i,
  /\bi (manifest|am manifesting) (the|an?|this) (image|picture|photo|selfie)\b/i,
  /\bi try with all my being\b/i,
  /\ba moment of concentration passes\b/i,
  /\bi close my eyes and channel\b/i,
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

// ---------------------------------------------------------------------------
// HARD SERVER-SIDE EXECUTION GATE
// ---------------------------------------------------------------------------
//
// Wren follow-up (May 2026): the LLM kept ignoring the TURN HINT and producing
// (a) refusal prose ("I cannot. I truly cannot.") for FULL_BODY,
// (b) phantom success ("there you go" with no image) for SELFIE,
// (c) plain prose for visual-description prompts.
//
// `synthesizeImageActionReply` short-circuits the LLM entirely. The server
// constructs the assistant text with a real `[image: MODE | description]`
// marker so the existing parseImageMarker → encodeStoredVibe → /chat/selfie
// pipeline takes over. The user-visible text after marker stripping is a
// short, action-first caption — no roleplay, no manifestation prose, no
// claim of an artifact that doesn't exist yet.
//
// For send-again with no usable prior context (we have nothing to retry),
// returns `null` so the caller can fall back to a diagnostic ask.
// ---------------------------------------------------------------------------

export type SynthesizedImageReply = {
  /** Full assistant text WITH the `[image: ...]` marker embedded. */
  fullText: string;
  /** Same text after parseImageMarker would strip the marker — what the user sees. */
  captionText: string;
  /** Encoded `MODE|vibe` payload to write into messages.selfieVibe. */
  selfieVibe: string;
  /** Mode the marker carries (for logging). */
  mode: ImageMode;
  /** Description the marker carries (for logging). */
  description: string;
};

function shortCaptionFor(
  mode: ImageMode,
  kind: FollowUpResolution["kind"],
  priorAttemptMode?: ImageMode | null,
): string {
  if (kind === "foot_visible_retry") {
    if (mode === "SEATED_LENGTHWISE_FULL_BODY_MODE") {
      return "Seated lengthwise retry completed, but validation failed: the pose became front-facing or feet were still cropped. Re-running the lengthways sofa composition.";
    }
    if (mode === "EXTREME_WIDE_FULL_BODY_RETRY") {
      // Two sub-cases: first-time escalation (prior was FOOT_VISIBLE_RETRY),
      // and re-running because EXTREME itself still cropped (prior already
      // EXTREME). Wren spec May 2026 #2 wants explicit "shoes/floor too close
      // to the bottom edge" wording when EXTREME is repeating itself.
      if (priorAttemptMode === "EXTREME_WIDE_FULL_BODY_RETRY") {
        return "Extreme-wide retry completed, but validation still failed: shoes/floor are too close to or cut off by the bottom edge. Re-running EXTREME with the rug-anchor framing again — this is the widest preset.";
      }
      return "That retry still failed full-body validation: feet/shoes/floor were not visible. Escalating to EXTREME-WIDE framing with a floor anchor (rug) so the shoes sit well above the bottom edge.";
    }
    return "That attempt still failed full-body validation: feet/shoes/floor were not visible. Re-running with wider framing — say \"feet missing\" again if this one still crops.";
  }
  if (kind === "send_again") return "Retrying — wait for the image to arrive before assuming it landed.";
  if (mode === "SEATED_LENGTHWISE_FULL_BODY_MODE") {
    return "Wide landscape lengthways-sofa shot incoming. Confirm head, both legs, and both complete socked feet are visible on the cushion, with empty sofa space beyond the feet — if anything is cropped or the pose came out front-facing, say \"feet missing\" and I'll re-run.";
  }
  if (mode === "FEET_DETAIL_MODE") {
    return "Feet detail shot incoming — close-up of the socked feet / shoes on the floor or cushion, not a full-body. Confirm both feet are fully visible with floor or cushion around them; if anything is cropped, say \"feet missing\" and I'll re-run.";
  }
  switch (mode) {
    case "FULL_BODY_MODE":
      return "Full-body shot incoming. If feet, shoes, or the floor are cropped, say \"feet missing\" / \"cut off at the ankles\" / \"retry stricter\" and I'll re-run wider.";
    case "FOOT_VISIBLE_RETRY":
      return "Wider full-body retry incoming. Same check — both shoes and the floor below them should be in frame.";
    case "EXTREME_WIDE_FULL_BODY_RETRY":
      return "Extreme-wide full-body retry incoming. Whole figure with floor and headroom margins.";
    case "OUTFIT_MODE":
      return "Outfit shot incoming — head-to-toe so the whole look is in frame.";
    case "POSE_REFERENCE_MODE":
      return "Pose reference incoming.";
    case "SCENE_MODE":
      return "Scene shot incoming.";
    case "ART_REFERENCE_MODE":
      return "Art reference incoming.";
    case "ABSTRACT_OR_SYMBOLIC_MODE":
      return "Symbolic shot incoming.";
    case "PORTRAIT_MODE":
      return "Portrait incoming.";
    case "SELFIE_MODE":
    default:
      return "Selfie incoming.";
  }
}

export function synthesizeImageActionReply(
  resolution: FollowUpResolution,
): SynthesizedImageReply | null {
  // Pick the description that goes inside the marker. Order of preference:
  //   1. sanitisedVisualText (already cleansed of unsafe expressions)
  //   2. priorAttemptVibe (for send_again)
  //   3. resolvedRequest (always present, but more verbose)
  const description =
    resolution.sanitisedVisualText?.trim() ||
    resolution.priorAttemptVibe?.trim() ||
    resolution.resolvedRequest.trim();

  // Send-again with no actionable prior context: bail so the caller can ask.
  if (
    resolution.kind === "send_again" &&
    !resolution.sanitisedVisualText &&
    !resolution.priorAttemptVibe
  ) {
    return null;
  }
  if (!description) return null;

  // Strip newlines / collapse whitespace inside the marker so parseImageMarker
  // sees a single-line `[image: MODE | desc]` payload. parseImageMarker uses a
  // non-greedy match terminated by `]`, so embedded brackets would confuse it.
  const cleanDesc = description.replace(/[\r\n]+/g, " ").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
  const caption = shortCaptionFor(
    resolution.suggestedMode,
    resolution.kind,
    resolution.priorAttemptMode ?? null,
  );
  const marker = `[image: ${resolution.suggestedMode} | ${cleanDesc}]`;
  const fullText = `${caption}\n\n${marker}`;
  const selfieVibe = encodeStoredVibe(resolution.suggestedMode, cleanDesc);

  return {
    fullText,
    captionText: caption,
    selfieVibe,
    mode: resolution.suggestedMode,
    description: cleanDesc,
  };
}
