/**
 * Route-level intent classifier — spec v3.0.
 *
 * Invariant: runs BEFORE any capability-specific code. No capability state is
 * read here; the function is pure and has no side effects.
 *
 * Output drives a single derived gate used by EVERY image path in the handler:
 *
 *   imageRouteAllowed = imageGenerationEnabled && actionDetected && !isQuestion
 *
 * When imageRouteAllowed is false, the entire image pipeline is skipped —
 * detection, synthesis, fallback messages — unconditionally.
 *
 * Processing pipeline (spec v3.0, §3):
 *   STEP 1 — this function: classify intent, detect action verb, detect question
 *   STEP 2 — caller: compute imageRouteAllowed
 *   STEP 3 — caller: gate every image path on imageRouteAllowed
 *   STEP 4 — LLM or image pipeline (whichever was routed to)
 */

export type RouteIntentType =
  | "question"               // contains "?" or interrogative opener → always conversational
  | "explicit_image_request" // explicit image-creation verb present
  | "command"                // explicit non-image directive
  | "statement"              // declarative sentence (≥ 5 words, has a main verb)
  | "conversational_fragment"// short fragment (≤ 4 words), no action verb
  | "ambiguous";             // everything else

export interface RouteIntentResult {
  intentType: RouteIntentType;
  /** True ONLY when an explicit image-creation action verb is present. */
  actionDetected: boolean;
  /** True when message contains "?" or starts with an interrogative word. */
  isQuestion: boolean;
}

// ---------------------------------------------------------------------------
// Image action verb patterns — ONLY these qualify as explicit image actions
// (spec v3.0, §5: valid verbs are generate / create / draw / show me /
//  send me / render / make clearly tied to image output)
// ---------------------------------------------------------------------------

/** "generate a selfie", "create an image of you", "draw Ashley", etc. */
const IMAGE_ACTION_VERB_RE =
  /\b(generate|create|make|draw|render|produce|paint|design)\s+(me\s+|us\s+)?(an?\s+|a\s+)?(image|picture|photo|selfie|selfies|portrait|artwork|illustration|sketch|pic|visual|snapshot)\b/i;

/** "can you draw / generate / make …", "could you create …", "please render …" */
const MODAL_ACTION_RE =
  /\b(can|could|would|will|please)\s+(you\s+)?(draw|create|generate|make|render|paint|produce|design|send|show)\b/i;

/** "send me a selfie", "send a selfie", "send your selfie" */
const SELFIE_DELIVERY_RE =
  /\bsend\s+(me\s+|us\s+)?(a\s+|your\s+)?selfie(s)?\b/i;

/** "send me a pic / photo / picture / image" */
const SEND_IMAGE_RE =
  /\bsend\s+(me\s+)?(a\s+|an\s+)?(pic|photo|picture|image)\b/i;

/** "show me a selfie / photo / picture / image / pic / portrait" */
const SHOW_IMAGE_RE =
  /\bshow\s+(me\s+)?(a\s+|your\s+|an\s+)?(selfie|photo|picture|image|pic|portrait|artwork)\b/i;

/** "take a selfie", "take a photo", "take a pic" */
const TAKE_PHOTO_RE =
  /\btake\s+(me\s+)?(a\s+)?(selfie|photo|picture|pic)\b/i;

/**
 * Count + image noun — covers natural requests like:
 * "10 pictures please", "5 photos", "3 selfies", "a few pics",
 * "some photos", "several portraits", "another picture"
 */
const COUNT_IMAGE_NOUN_RE =
  /\b(\d+|a\s+few|some|several|few|many|more|another|a\s+couple(\s+of)?)\s+(pictures?|photos?|selfies?|pics?|snapshots?|portraits?|images?|sketches?|artworks?)\b/i;

// ---------------------------------------------------------------------------
// Question detection — absolute conversational override (spec v3.0, §10)
// ---------------------------------------------------------------------------

const HAS_QUESTION_MARK_RE = /\?/;

/**
 * Interrogative openers — messages that begin with these words are treated
 * as questions even without a trailing "?".
 */
const INTERROGATIVE_OPENER_RE =
  /^(what|how|why|where|when|who|which|whose|is|are|was|were|do|does|did|can|could|would|should|will|won't|have|has|had|am|aren't|isn't|doesn't|don't|haven't|hasn't|hadn't)\b/i;

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

/**
 * Classify a user message for routing purposes.
 *
 * Pure function — reads only `text`. No side effects.
 */
export function classifyRouteIntent(text: string): RouteIntentResult {
  const trimmed = text.trim();

  // ---- Question detection: absolute conversational override ----------------
  const isQuestion =
    HAS_QUESTION_MARK_RE.test(trimmed) ||
    INTERROGATIVE_OPENER_RE.test(trimmed);

  // ---- Image action detection: explicit verb required ----------------------
  const actionDetected =
    IMAGE_ACTION_VERB_RE.test(trimmed) ||
    MODAL_ACTION_RE.test(trimmed) ||
    SELFIE_DELIVERY_RE.test(trimmed) ||
    SEND_IMAGE_RE.test(trimmed) ||
    SHOW_IMAGE_RE.test(trimmed) ||
    TAKE_PHOTO_RE.test(trimmed) ||
    COUNT_IMAGE_NOUN_RE.test(trimmed);

  // ---- Intent type: used for logging only; does not affect routing ---------
  let intentType: RouteIntentType;
  if (isQuestion) {
    intentType = "question";
  } else if (actionDetected) {
    intentType = "explicit_image_request";
  } else {
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    intentType = wordCount <= 4 ? "conversational_fragment" : "ambiguous";
  }

  return { intentType, actionDetected, isQuestion };
}
