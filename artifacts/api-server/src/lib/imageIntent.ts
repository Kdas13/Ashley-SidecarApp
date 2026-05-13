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

// Full-body / framing-explicit language.
const FULL_BODY_RX =
  /\b(full[- ]body|head[- ]to[- ]toe|full[- ]length|all of (you|her|herself)|show all of (you|her|herself))\b/i;

// Lower-body / footwear cues — strong signal that a portrait crop fails.
const LIMB_RX = /\b(legs?|feet|ankles?|knees?|thighs?|boots?|footwear|shoes?)\b/i;

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

export type FramingHint = "square" | "tall";

export type PromptWrapper = {
  positives: string[];
  negatives: string[];
  framingHint: FramingHint;
  requiresFullBodyValidation: boolean;
  /** Short label used in client-side pending UI ("taking a selfie…", etc.) */
  pendingLabel: string;
};

const WRAPPERS: Record<ImageMode, PromptWrapper> = {
  SELFIE_MODE: {
    positives: [
      "Close-up or upper-body framing is allowed.",
      "Camera-held / phone-in-hand selfie language is allowed.",
      "Cropped body is acceptable; full legs are NOT required unless explicitly asked for.",
      "Single subject. Soft natural lighting. Slightly soft focus. Avoid uncanny faces.",
    ],
    negatives: ["text or watermarks"],
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "taking a selfie",
  },
  PORTRAIT_MODE: {
    positives: [
      "Head-and-shoulders or upper-body framing.",
      "Focus on face, expression, identity, controlled lighting.",
      "Single subject, looking at camera or in candid moment.",
      "No selfie / phone-in-hand framing.",
    ],
    negatives: ["selfie crop", "phone in hand", "camera-held framing", "text or watermarks"],
    framingHint: "square",
    requiresFullBodyValidation: false,
    pendingLabel: "framing a portrait",
  },
  FULL_BODY_MODE: {
    positives: [
      "Full body visible from head to toe.",
      "Both legs fully visible.",
      "Feet visible (unless explicitly excluded by the description).",
      "Subject is framed with enough negative space around the body.",
      "Even readable lighting; the silhouette is clearly visible.",
    ],
    negatives: [
      "cropped legs",
      "hidden feet",
      "portrait crop",
      "close-up or selfie framing",
      "cut-off body",
      "lower body hidden by fog, darkness, furniture, foreground objects, or low camera angle",
      "text or watermarks",
    ],
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "framing a full-body shot",
  },
  OUTFIT_MODE: {
    positives: [
      "Full outfit visible.",
      "Head-to-toe framing.",
      "Both legs and footwear visible.",
      "Lighting flatters the garments; fabric and silhouette are readable.",
    ],
    negatives: [
      "selfie crop",
      "cropped lower body",
      "hidden footwear",
      "lower body obscured by fog, shadow, or foreground",
      "text or watermarks",
    ],
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "framing an outfit shot",
  },
  POSE_REFERENCE_MODE: {
    positives: [
      "Clean, readable body pose.",
      "Full silhouette visible.",
      "Limbs clearly separated where possible.",
      "Even lighting that does not hide anatomy.",
    ],
    negatives: [
      "cropped limbs",
      "hidden legs",
      "obscured feet",
      "ambiguous lower body",
      "heavy cinematic shadow that hides anatomy",
      "text or watermarks",
    ],
    framingHint: "tall",
    requiresFullBodyValidation: true,
    pendingLabel: "drafting a pose reference",
  },
  SCENE_MODE: {
    positives: [
      "Prioritise the scene / composition over selfie framing.",
      "Camera distance appropriate to the moment described.",
      "Subject may be full-body, half-body, or environmental as the scene demands.",
      "Environmental detail is present and legible.",
    ],
    negatives: [
      "default close-up selfie framing",
      "phone-in-hand selfie language",
      "text or watermarks",
    ],
    framingHint: "tall",
    requiresFullBodyValidation: false,
    pendingLabel: "composing a scene",
  },
  ART_REFERENCE_MODE: {
    positives: [
      "Art-useful composition.",
      "Respect the requested canvas / panel / framing in the description.",
      "Clear forms, readable lighting, usable as reference.",
    ],
    negatives: [
      "forced selfie framing",
      "phone-in-hand language",
      "text or watermarks",
    ],
    framingHint: "tall",
    requiresFullBodyValidation: false,
    pendingLabel: "sketching a reference",
  },
  ABSTRACT_OR_SYMBOLIC_MODE: {
    positives: [
      "Symbolic visual language: composition, mood, theme over literal portrait.",
      "Do not force the subject's face / body into the image unless the description requires it.",
    ],
    negatives: [
      "forced selfie framing",
      "literal portrait when not requested",
      "text or watermarks",
    ],
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
  const positives = w.positives.map((p) => `- ${p}`).join("\n");
  const negatives = w.negatives.length
    ? `Forbidden in this image: ${w.negatives.join("; ")}.`
    : "";
  const identity = appearance
    ? `Identity anchor (must remain recognisable, but MUST NOT override the framing requirements above): ${appearance}`
    : "";
  return [
    `Image intent: ${mode}.`,
    `Subject: ${subjectName}, a young woman.`,
    `Framing requirements:\n${positives}`,
    negatives,
    identity,
    `Vibe / scene: ${vibe.trim() || "natural, unposed."}`,
  ]
    .filter(Boolean)
    .join("\n");
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
