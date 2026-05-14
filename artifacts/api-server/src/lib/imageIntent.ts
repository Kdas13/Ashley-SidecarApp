// =============================================================================
// Image Intent Router — kills "Schrödinger's legs"
// -----------------------------------------------------------------------------
// Until now every visual request from Ashley was funnelled through a single
// selfie-shaped prompt. The result: full-body / outfit / pose-reference asks
// collapsed back into cropped portraits because the prompt itself baked in
// selfie framing.
//
// This module:
//   1. Classifies a free-text visual request into one of 8 explicit modes.
//   2. Emits per-mode prompt wrappers that REQUIRE the right framing and
//      explicitly FORBID the wrong one.
//   3. Tells the caller which provider sizing to use (tall canvas for
//      full-body / outfit / pose / scene; square for selfie / portrait /
//      abstract) and which modes warrant a post-gen "did this actually meet
//      the framing?" check.
//
// SELFIE_MODE is now ONE option, not the default.
// =============================================================================

export const IMAGE_MODES = [
  "SELFIE_MODE",
  "PORTRAIT_MODE",
  "FULL_BODY_MODE",
  "FOOT_VISIBLE_RETRY",
  "EXTREME_WIDE_FULL_BODY_RETRY",
  "SEATED_LENGTHWISE_FULL_BODY_MODE",
  "FEET_DETAIL_MODE",
  "OUTFIT_MODE",
  "POSE_REFERENCE_MODE",
  "SCENE_MODE",
  "ART_REFERENCE_MODE",
  "ABSTRACT_OR_SYMBOLIC_MODE",
] as const;

export type ImageMode = (typeof IMAGE_MODES)[number];

export function isImageMode(value: unknown): value is ImageMode {
  return typeof value === "string" && (IMAGE_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------
// Order matters. Earlier matches win. The hierarchy is intentional:
//   abstract > art-ref > pose-ref > outfit > full-body > scene > portrait > selfie
// because the more-specific framing requirements should swallow the
// less-specific ones (e.g. "full outfit head to toe" should be OUTFIT_MODE,
// not SELFIE_MODE just because "show me" is in the text).

// Explicit selfie language — the ONLY way SELFIE_MODE gets selected.
const SELFIE_RX =
  /\b(selfie|close[- ]?up|face[- ]shot|head[- ]?shot|camera[- ]?held|hold(ing)? (the |a |her )?(camera|phone))\b/i;

// Full-body / framing-explicit language. Per Wren spec: "whole body",
// "entire body", "complete body", "complete form", "full form", "body shot",
// and "standing (picture|photo|image|shot)" must all route to FULL_BODY_MODE,
// alongside the original "full body / head to toe / full length / all of you"
// triggers. This keeps obvious framing demands out of PORTRAIT_MODE crops.
const FULL_BODY_RX =
  /\b(full[- ]?body|whole[- ]?body|entire[- ]?body|complete[- ]?body|full[- ]?length|head[- ]?to[- ]?toe|all of (you|her|herself)|show all of (you|her|herself)|complete form|full form|body shot|standing (picture|photo|image|shot|portrait))\b/i;

// Lower-body / footwear cues — strong signal that a portrait crop fails.
const LIMB_RX = /\b(legs?|feet|ankles?|knees?|thighs?|boots?|footwear|shoes?)\b/i;

// Feet-only / footwear-detail cues (Wren May 2026 follow-up). Routes to
// FEET_DETAIL_MODE — a casual outfit-detail shot of just the feet/shoes,
// NOT a full-body composition. Matches phrasings where feet/shoes are the
// SOLE subject:
//   - "image/picture/photo/close-up of your feet" (any image noun)
//   - "just (your|her) feet" / "feet only" / "shoes only"
//   - "show me your feet/shoes/socked feet"
//   - "close-up of your shoes"
//   - "your feet on the floor/sofa/cushion"
// FEET_DETAIL_RX is checked BEFORE LIMB_RX/FULL_BODY_RX in the classifier
// (and only fires when no concurrent FULL_BODY signal is present) so that
// "show me head to toe with both feet visible" stays FULL_BODY_MODE while
// "just an image of your feet" becomes FEET_DETAIL_MODE.
// All branches except "X only" require explicit image-noun framing
// ("image of your feet", "close-up of your shoes") or an imperative
// ("show me your feet") or a possessive surface phrase ("your feet on
// the floor") — they don't slip on conversational text. The "X only"
// branch ("shoes only", "feet only") is split into its own clause-
// anchored regex so "my shoes only lasted a week" can't false-fire.
const FEET_DETAIL_RX =
  /\b((image|picture|photo|photograph|pic|shot|snap|view|close[-\s]?up)\s+of\s+(your|her|the|ashley'?s)\s+(socked\s+feet|feet|shoes|socks|footwear)|just\s+(your|her|the)\s+(feet|shoes|socked\s+feet)|show\s+(me\s+)?(your|her)\s+(socked\s+feet|feet|shoes|socks|footwear)|close[-\s]?up\s+of\s+(your|her|the)\s+(shoes|feet|socks|socked\s+feet|footwear)|(your|her)\s+(socked\s+feet|feet|shoes)\s+on\s+the\s+(floor|sofa|couch|cushion|rug|carpet))\b/i;
const FEET_DETAIL_ONLY_AT_CLAUSE_START_RX =
  /(?:^|[.!?]\s+)\s*(feet|shoes|socked\s+feet)\s+only\b/i;

// Standing / walking / pose-with-body cues.
const STANDING_RX = /\b(standing|walking|running|sitting full[- ]frame|leaning|posing)\b/i;

// Outfit / wardrobe cues.
const OUTFIT_RX =
  /\b(outfit|fit[- ]check|wardrobe|wearing|fashion|ootd|whole look|entire look)\b/i;

// Pose-reference / character-sheet cues.
const POSE_RX =
  /\b(pose|pose reference|character sheet|reference (sheet|image|pose)|body proportions|silhouette)\b/i;

// Scene / environmental cues.
const SCENE_RX =
  /\b(scene|environment(al)? shot|cinematic|wide shot|landscape|street|backdrop|in the (rain|snow|forest|city)|walking through)\b/i;

// Art / mock-up cues.
const ART_RX =
  /\b(painting|art reference|art mock[- ]?up|painting mock[- ]?up|panel|canvas|sketch reference|illustration mock|study (sheet|reference))\b/i;

// Portrait cues — head/shoulders without selfie framing.
const PORTRAIT_RX =
  /\b(portrait|head and shoulders|bust shot|upper body)\b/i;

// Abstract / symbolic cues.
const ABSTRACT_RX =
  /\b(symbolic|abstract|metaphor(ic)?|conceptual|mood board|aesthetic only|no person|just (a )?(mood|vibe|texture))\b/i;

// Seated-lengthwise / horizontal sofa pose cues. These trigger a landscape
// composition with the body running across the cushions (per Wren spec). Must
// fire BEFORE generic full-body / scene / limb regexes so the lengthwise
// requirement isn't lost to a generic full-body interpretation.
const SEATED_LENGTHWISE_RX =
  /\b((couch|sofa)\s+lengthw(ay|ise)s?|sitting\s+lengthw(ay|ise)s?|lying\s+along\s+(the\s+)?(sofa|couch)|reclin(e|ing)\s+along\s+(the\s+)?(sofa|couch)|side[-\s]on\s+(sofa|couch)\s+full\s+body|legs\s+stretched\s+along\s+(the\s+)?(sofa|couch)|stretched\s+(out\s+)?(along|across)\s+(the\s+)?(sofa|couch))\b/i;

export type ClassifyResult = {
  mode: ImageMode;
  reason: string;
};

/**
 * Classify a free-text visual request into an ImageMode. Pure function,
 * deterministic, no I/O. Designed for the keyword set in the project spec.
 *
 * Defaulting policy: if no explicit signal is present, fall back to
 * PORTRAIT_MODE — NEVER SELFIE_MODE. SELFIE_MODE requires explicit selfie
 * language (per spec).
 */
export function classifyImageIntent(text: string): ClassifyResult {
  const t = (text ?? "").toString();
  if (!t.trim()) {
    return {
      mode: "PORTRAIT_MODE",
      reason: "empty input — defaulting to portrait (selfie not assumed)",
    };
  }
  if (ABSTRACT_RX.test(t))
    return { mode: "ABSTRACT_OR_SYMBOLIC_MODE", reason: "matched abstract/symbolic keyword" };
  if (ART_RX.test(t))
    return { mode: "ART_REFERENCE_MODE", reason: "matched art-reference / mock-up keyword" };
  if (POSE_RX.test(t))
    return { mode: "POSE_REFERENCE_MODE", reason: "matched pose-reference / character-sheet keyword" };
  // Seated-lengthwise must beat OUTFIT / FULL_BODY / SCENE / LIMB — those
  // would otherwise route to a vertical front-facing composition and lose
  // the horizontal sofa pose entirely.
  if (SEATED_LENGTHWISE_RX.test(t))
    return {
      mode: "SEATED_LENGTHWISE_FULL_BODY_MODE",
      reason: "matched seated-lengthwise / lying-along-sofa keyword",
    };
  // Feet-detail must beat OUTFIT / FULL_BODY / LIMB / STANDING — but only
  // when no explicit full-body signal is present in the same message. A
  // message that asks for both ("head to toe with feet visible") still
  // routes to FULL_BODY_MODE; a feet-only ask ("just an image of your
  // feet") routes here. Per Wren May 2026 follow-up.
  if (
    (FEET_DETAIL_RX.test(t) || FEET_DETAIL_ONLY_AT_CLAUSE_START_RX.test(t)) &&
    !FULL_BODY_RX.test(t) &&
    !OUTFIT_RX.test(t)
  )
    return {
      mode: "FEET_DETAIL_MODE",
      reason:
        "matched feet/shoes detail-only keyword (no full-body or outfit signal)",
    };
  if (OUTFIT_RX.test(t))
    return { mode: "OUTFIT_MODE", reason: "matched outfit / wardrobe keyword" };
  if (FULL_BODY_RX.test(t))
    return { mode: "FULL_BODY_MODE", reason: "matched explicit full-body keyword" };
  // SCENE wins over generic movement cues — "cinematic scene of Ashley
  // walking down a rainy street" must NOT be FULL_BODY_MODE just because
  // "walking" matches a movement verb.
  if (SCENE_RX.test(t))
    return { mode: "SCENE_MODE", reason: "matched scene / environmental keyword" };
  // Limb / standing cues unconditionally escalate (the spec lists legs, feet,
  // standing, walking, etc. as explicit "do NOT use SELFIE_MODE" triggers).
  // Selfie words in the same sentence do NOT rescue selfie framing — the
  // limb cue wins because the failure mode we are fixing is cropped legs.
  if (LIMB_RX.test(t) || STANDING_RX.test(t))
    return {
      mode: "FULL_BODY_MODE",
      reason: "matched limb / standing / walking keyword — full-body framing required",
    };
  if (PORTRAIT_RX.test(t))
    return { mode: "PORTRAIT_MODE", reason: "matched portrait / upper-body keyword" };
  if (SELFIE_RX.test(t))
    return { mode: "SELFIE_MODE", reason: "matched explicit selfie keyword" };
  return {
    mode: "PORTRAIT_MODE",
    reason: "no explicit keyword — defaulting to portrait (no forced selfie)",
  };
}

// ---------------------------------------------------------------------------
// Per-mode prompt wrappers
// ---------------------------------------------------------------------------

export type FramingHint = "square" | "tall" | "landscape";

export type PromptWrapper = {
  /**
   * One natural-language sentence describing the SHOT TYPE for this mode.
   * Goes at the head of the image prompt. Use only positive affirmations —
   * gpt-image-1 is a diffusion model and does not understand negation, so
   * "no cropped legs" tends to *summon* cropped legs. Affirm the desired
   * framing instead.
   */
  shotType: string;
  /** One natural-language sentence about lighting / texture / finish. */
  styleLine: string;
  framingHint: FramingHint;
  requiresFullBodyValidation: boolean;
  /** Short label used in client-side pending UI ("taking a selfie…", etc.) */
  pendingLabel: string;
};

const WRAPPERS: Record<ImageMode, PromptWrapper> = {
  SELFIE_MODE: {
    shotType:
      "Warm intimate phone-camera selfie of {subject}, a young woman, with the camera held at arm's length",
    styleLine:
      "Soft natural lighting, slightly soft focus, single subject, photorealistic, no text or watermarks",
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "taking a selfie",
  },
  PORTRAIT_MODE: {
    shotType:
      "Photorealistic head-and-shoulders portrait of {subject}, a young woman, looking at the camera in a candid moment",
    styleLine:
      "Controlled natural lighting, focus on face and expression, single subject, photorealistic, no text or watermarks",
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "framing a portrait",
  },
  FULL_BODY_MODE: {
    // Catalogue-style framing language (per Wren spec, May 2026 follow-up).
    // Pure positive composition — gpt-image-1 ignores negation, so we affirm
    // the floor under the shoes, the empty space above head and below feet,
    // and a wide camera distance with the subject smaller in the frame.
    shotType:
      "Full-length vertical fashion-catalogue reference image of {subject}, a young woman, standing several metres from the camera; her complete figure is visible from the top of her head to the soles of both shoes; both shoes are fully visible and the floor is visible beneath and around both shoes; {subject} is smaller in the frame, centered, with clear empty space above her head and clear empty space below her shoes; the camera is wide enough to show the entire standing body comfortably inside the image",
    styleLine:
      "Vertical portrait composition, fashion catalogue full-body reference style, even readable lighting across the whole body, photorealistic, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "framing a full-body shot",
  },
  FOOT_VISIBLE_RETRY: {
    // Stricter retry wording (per Wren May 2026 follow-up). The previous
    // wording still produced trouser-cuff crops, so this version over-affirms
    // a wide vertical fashion-catalogue composition with the subject smaller
    // in the frame, both shoes complete, and a strip of empty floor below the
    // shoes. Diffusion models ignore negation, so every constraint is
    // expressed as a positive composition fact.
    shotType:
      "Wide full-length vertical fashion-catalogue image of {subject}, a young woman, standing far from the camera; {subject}'s entire body is visible from the top of her head to the soles of both shoes; both shoes are fully visible and the floor beneath both shoes is clearly visible, including a strip of empty floor below the shoes; {subject} is smaller in the frame, occupying only the central sixty-five percent of the image height; clear empty margin above her head and clear empty floor margin below her shoes; the camera is positioned far enough away to show the complete standing figure comfortably inside the frame, including the floor line and baseboard if indoors",
    styleLine:
      "Tall vertical portrait composition, full-body fashion-catalogue framing, even readable lighting across the whole body, photorealistic, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "retrying full-body framing — wider",
  },
  FEET_DETAIL_MODE: {
    // Wren May 2026 follow-up. Feet-only request — should NOT route to
    // FULL_BODY_MODE. Casual outfit-detail composition: socked feet or
    // shoes are the subject, both fully visible on a clear floor or sofa
    // surface, no sexualised framing. All composition language positive
    // (diffusion ignores negation).
    shotType:
      "Casual outfit-detail photograph of {subject}'s socked feet or shoes, framed as a close, harmless detail shot of her footwear; both feet are fully visible inside the frame, resting naturally on the floor or sofa cushion; the floor or cushion surface beneath both feet is clearly visible, anchoring the composition with empty space around the feet on every side; the camera is angled down toward the feet from a close standing distance with comfortable margins beyond the toes and heels",
    styleLine:
      "Outfit-detail composition focused on footwear, soft even natural lighting, photorealistic, single subject, no text or watermarks",
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "framing a feet detail shot",
  },
  SEATED_LENGTHWISE_FULL_BODY_MODE: {
    // Wren May 2026 follow-up #3. The default seated interpretation is a
    // front-facing portrait on a sofa, which loses the lengthwise pose Wren
    // wants. This wrapper forces a landscape canvas, side-on viewpoint, and
    // a horizontal body that runs across the cushions. All constraints
    // expressed positively (diffusion ignores negation). Subject capped at
    // ~65% of image width; entire sofa visible; both feet on the cushion,
    // not hanging off the edge.
    shotType:
      "Wide landscape full-body image of {subject}, a young woman, reclining lengthways across a sofa and viewed side-on from across the room with a pulled-back camera. Her head rests near the LEFT armrest of the sofa and her feet rest near the RIGHT armrest. Her body runs horizontally across the couch cushions, with her shoulders, hips, and legs all aligned along the length of the sofa. Her whole body is visible from the top of her head to the soles of her feet. Both complete socked feet are fully visible resting on the sofa cushion near the right armrest, with empty sofa cushion space visible beyond her feet between her toes and the right armrest. The entire sofa is visible inside the frame, including the left armrest behind her head and the right armrest beyond her feet, with generous margins of cushion above her head and beyond her feet. {subject} occupies up to sixty-five percent of the image width, centered horizontally with empty cushion space at both ends. Pulled-back side-on camera view; the entire figure from the top of the head to the soles of the feet sits well inside the frame with comfortable margins on every side",
    styleLine:
      "Wide landscape composition, side-on full-body view of a person reclining lengthways on a sofa, even readable lighting across the whole body, photorealistic, single subject, no text or watermarks",
    framingHint: "landscape",
    requiresFullBodyValidation: true,
    pendingLabel: "framing a lengthways sofa shot",
  },
  EXTREME_WIDE_FULL_BODY_RETRY: {
    // Second-stage escalation (per Wren May 2026 follow-up #2). The previous
    // version still placed the shoes at the bottom edge of the frame, so this
    // version uses a FLOOR ANCHOR OBJECT — a small rectangular rug — that the
    // diffusion model has to render in full, which forces visible floor area
    // beyond the shoes and pushes the subject up off the bottom edge. Subject
    // capped at 55 percent of image height, extreme catalogue distance, all
    // composition language stated as positive facts (diffusion ignores
    // negation).
    shotType:
      "Very wide full-body fashion-catalogue reference image of {subject}, a young woman, standing far from the camera on a small rectangular rug placed on the floor; the entire rectangular rug is visible inside the frame, including a visible strip of rug and floor beyond both shoes; {subject}'s complete body is visible from the top of her head to the soles of both shoes; both complete shoes are visible and the rug is visible underneath both shoes; the bottom edge of the image shows visible rug and floor below the shoes, with the shoes positioned well above the bottom edge of the image; {subject} occupies no more than fifty-five percent of the image height and is centered in the frame with generous empty margin above her head and generous empty rug and floor margin below her shoes; extreme long-shot catalogue distance, full standing figure with rug fully inside the frame; the floor line and baseboard are visible if indoors",
    styleLine:
      "Tall vertical portrait composition, extreme long-shot full-body catalogue framing, even readable lighting across the whole body, photorealistic, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "retrying full-body framing — extreme wide on rug",
  },
  OUTFIT_MODE: {
    shotType:
      "Full-length outfit reference image of {subject}, a young woman, standing several metres from the camera, her complete outfit visible from head to toe including top, trousers or skirt, both legs, both shoes, and the floor beneath her feet, with clear empty space above her head and below her shoes",
    styleLine:
      "Vertical portrait composition, fashion catalogue outfit view, lighting that flatters the garments and keeps fabric and silhouette readable, photorealistic, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "framing an outfit shot",
  },
  POSE_REFERENCE_MODE: {
    shotType:
      "Full-length vertical pose-reference image of {subject}, a young woman, standing several metres from the camera, her entire body visible from the top of her head to the soles of her shoes, both arms and both legs separated and clearly readable, the floor visible beneath her feet, with clear empty space above her head and below her feet",
    styleLine:
      "Vertical portrait composition, reference-sheet style, even lighting across the body, neutral background, photorealistic, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "drafting a pose reference",
  },
  SCENE_MODE: {
    shotType:
      "Cinematic environmental photograph featuring {subject}, a young woman, framed at whatever camera distance the scene demands, with environmental detail present and legible, in a vertical composition",
    styleLine:
      "Photorealistic cinematic lighting that suits the scene, single subject, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: false,
    pendingLabel: "composing a scene",
  },
  ART_REFERENCE_MODE: {
    shotType:
      "Art-reference image of {subject}, a young woman, composed for use as drawing or painting reference, respecting any canvas or panel framing described in the scene",
    styleLine:
      "Clear forms, readable lighting, photorealistic or stylised as the description requires, no text or watermarks",
    framingHint: "tall",
    requiresFullBodyValidation: false,
    pendingLabel: "sketching a reference",
  },
  ABSTRACT_OR_SYMBOLIC_MODE: {
    shotType:
      "Symbolic visual composition inspired by {subject}'s mood and theme rather than a literal portrait",
    styleLine:
      "Atmospheric lighting, composition-driven, photorealistic or stylised as the description requires, no text or watermarks",
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "drafting an image",
  },
};

export function wrapperFor(mode: ImageMode): PromptWrapper {
  return WRAPPERS[mode];
}

/**
 * Build the per-mode body of an image prompt. The caller is responsible for
 * prepending the provider safety prefix (see contentPolicy).
 *
 * The identity anchor is included but explicitly subordinated to the framing
 * requirements, so a strong "lavender hair / black clothing" anchor cannot
 * silently override a head-to-toe framing demand.
 */
export function buildModePromptBlock(opts: {
  mode: ImageMode;
  vibe: string;
  subjectName: string;
  appearance: string;
}): string {
  const { mode, vibe, subjectName, appearance } = opts;
  const w = wrapperFor(mode);
  // Diffusion models follow natural-language description, not bulleted
  // instructions. The shot-type sentence is the framing anchor; the appearance
  // and vibe are blended in as narrative detail; the style line caps it.
  // Crucially: NO negatives ("no cropped legs", "forbidden:") — diffusion
  // models render whatever words appear, regardless of negation.
  const shot = w.shotType.replace("{subject}", subjectName);
  const appearanceSentence = appearance ? `She has ${appearance}.` : "";
  const vibeText = vibe.trim();
  const vibeSentence = vibeText ? `Scene: ${vibeText}.` : "";
  return [shot + ".", appearanceSentence, vibeSentence, w.styleLine + "."]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Marker parsing — bridges Ashley's chat output to this router.
// ---------------------------------------------------------------------------
// Two accepted forms in Ashley's reply text:
//   New (preferred): [image: <MODE> | <description>]
//   Legacy (BC):      [selfie: <description>]   → SELFIE_MODE
//
// The marker may appear anywhere in the reply. The first valid match wins.
// ---------------------------------------------------------------------------

const IMAGE_MARKER_RX = /\[image:\s*([^|\]]+)\|([^\]]+)\]/i;
const LEGACY_SELFIE_MARKER_RX = /\[selfie:\s*([^\]]+)\]/i;

export type ParsedMarker = {
  mode: ImageMode;
  vibe: string;
  /** The full matched substring (so callers can strip it from the reply). */
  rawMatch: string;
  /** Where the match started (so callers can slice before/after). */
  startIndex: number;
  /** Length of the matched substring. */
  length: number;
  /** Why this mode was chosen (from explicit tag vs classifier fallback). */
  reason: string;
};

export function parseImageMarker(text: string): ParsedMarker | null {
  if (!text) return null;
  // Pick the EARLIEST marker by position across both syntaxes — otherwise a
  // legacy [selfie:...] that appears before a (model-emitted) [image:...]
  // would be left in the user-visible text after the new-syntax match got
  // stripped, leaking a raw tag into the chat.
  const newMatch = text.match(IMAGE_MARKER_RX);
  const legacyMatch = text.match(LEGACY_SELFIE_MARKER_RX);
  const newIdx = newMatch && typeof newMatch.index === "number" ? newMatch.index : -1;
  const legacyIdx =
    legacyMatch && typeof legacyMatch.index === "number" ? legacyMatch.index : -1;

  const useNew =
    newIdx !== -1 && (legacyIdx === -1 || newIdx <= legacyIdx);
  const useLegacy =
    !useNew && legacyIdx !== -1;

  if (useNew && newMatch) {
    const declared = (newMatch[1] ?? "").trim().toUpperCase();
    const vibe = (newMatch[2] ?? "").trim();
    let mode: ImageMode;
    let reason: string;
    if (isImageMode(declared)) {
      mode = declared;
      reason = `model emitted explicit [image:${declared}|...] tag`;
    } else {
      const classified = classifyImageIntent(`${declared} ${vibe}`);
      mode = classified.mode;
      reason = `model emitted [image:${declared}|...] with unknown mode label — classifier fallback: ${classified.reason}`;
    }
    return {
      mode,
      vibe,
      rawMatch: newMatch[0],
      startIndex: newIdx,
      length: newMatch[0].length,
      reason,
    };
  }
  if (useLegacy && legacyMatch) {
    const vibe = (legacyMatch[1] ?? "").trim();
    // Legacy [selfie:...] — respect intent in the description: if it talks
    // about full-body / outfit / pose, route there even though the tag says
    // "selfie". Only fall back to SELFIE_MODE when the description has no
    // contradicting framing signal.
    const classified = classifyImageIntent(vibe);
    const mode: ImageMode =
      classified.mode === "PORTRAIT_MODE" ? "SELFIE_MODE" : classified.mode;
    const reason =
      mode === "SELFIE_MODE"
        ? "legacy [selfie:...] tag with no contradicting framing cues"
        : `legacy [selfie:...] tag overridden by description cues — ${classified.reason}`;
    return {
      mode,
      vibe,
      rawMatch: legacyMatch[0],
      startIndex: legacyIdx,
      length: legacyMatch[0].length,
      reason,
    };
  }
  return null;
}

/**
 * Encode (mode, vibe) into the single `selfieVibe` column without a schema
 * change. Encoded form: `MODE|vibe text`. Decoder is `decodeStoredVibe`.
 *
 * Backwards-compat: rows written before this feature have no MODE prefix —
 * the decoder runs the classifier on them.
 */
export function encodeStoredVibe(mode: ImageMode, vibe: string): string {
  return `${mode}|${vibe.trim()}`;
}

export function decodeStoredVibe(stored: string): { mode: ImageMode; vibe: string; reason: string } {
  const raw = (stored ?? "").trim();
  const sep = raw.indexOf("|");
  if (sep > 0) {
    const maybeMode = raw.slice(0, sep).trim().toUpperCase();
    if (isImageMode(maybeMode)) {
      return {
        mode: maybeMode,
        vibe: raw.slice(sep + 1).trim(),
        reason: "decoded explicit MODE prefix from stored vibe",
      };
    }
  }
  const classified = classifyImageIntent(raw);
  return {
    mode: classified.mode,
    vibe: raw,
    reason: `legacy stored vibe (no MODE prefix) — classifier: ${classified.reason}`,
  };
}
