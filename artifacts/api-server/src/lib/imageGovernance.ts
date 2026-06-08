// =============================================================================
// Image Governance — Section 9 routing engine (Atlas Option B)
// -----------------------------------------------------------------------------
// Applies the Atlas governance framework to each selfie generation call.
//
// Two modes:
//   Mode 1 (manual defaults) — reads profile governance fields. If a field is
//     not "auto", it is used directly.
//   Mode 2 (automatic) — derives environment, composition, and occupancy from
//     real clock time, day of week, and season. Activates when a field is "auto".
//
// Priority contract inside generateAshleySelfie:
//   - Governance only overrides imageMode when the incoming mode is
//     PORTRAIT_MODE (the "no explicit framing" classifier default).
//     All other modes were explicitly requested by the user and must not
//     be overridden.
//   - Environment and occupancy clauses are ALWAYS prepended to the identity-
//     mode vibe (they are additive context, not framing overrides).
//   - Descriptor-mode jobs (redhead / blonde / brunette / blackhair) and
//     OBJECT_ONLY jobs bypass the vibe prefix injection — those paths have
//     tightly controlled prompt structures. Composition mode governance still
//     applies to descriptor jobs (affects the wrapper, not the prompt body).
// =============================================================================

import { type ImageMode } from "./imageIntent.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type GovernanceParams = {
  imageCompositionMode?: string | null;
  imageEnvironmentDefault?: string | null;
  imageOccupancyDefault?: string | null;
  imageCameraDefault?: string | null;
};

export type GovernanceResult = {
  /** Resolved ImageMode — may differ from input when governance overrides composition. */
  imageMode: ImageMode;
  /**
   * Prepend this to the final vibe before buildModePromptBlock.
   * Empty string means nothing to prepend.
   * Only injected in IDENTITY mode (not DESCRIPTOR or OBJECT_ONLY).
   */
  vibePrefix: string;
};

// ---------------------------------------------------------------------------
// Section 1: Composition mode → ImageMode mapping
// ---------------------------------------------------------------------------
// Only overrides when the incoming imageMode is PORTRAIT_MODE (classifier
// default — no explicit user framing demand). All other modes were explicitly
// requested via keyword match.

const COMPOSITION_TO_IMAGE_MODE: Partial<Record<string, ImageMode>> = {
  "ashley-centric":      "PORTRAIT_MODE",
  "balanced":            "PORTRAIT_MODE",
  "environment-centric": "SCENE_MODE",
  "scene":               "SCENE_MODE",
  "social":              "PORTRAIT_MODE",
  "documentary":         "SCENE_MODE",
};

// Section 4: Camera default → ImageMode (takes precedence over composition mode)
const CAMERA_TO_IMAGE_MODE: Partial<Record<string, ImageMode>> = {
  "selfie":        "SELFIE_MODE",
  "portrait":      "PORTRAIT_MODE",
  "lifestyle":     "PORTRAIT_MODE",
  "wide-room":     "SCENE_MODE",
  "architectural": "SCENE_MODE",
  "documentary":   "SCENE_MODE",
};

// ---------------------------------------------------------------------------
// Section 3: Environment catalogue
// ---------------------------------------------------------------------------

type EnvEntry = {
  clause: string;
};

const ENVIRONMENTS: Partial<Record<string, EnvEntry>> = {
  "living-room":     { clause: "Ashley is in the living room of her flat; warm, familiar home setting with soft furnishings and natural daylight" },
  "bedroom":         { clause: "Ashley is in the bedroom; soft ambient light, relaxed and private atmosphere" },
  "kitchen":         { clause: "Ashley is in the kitchen; bright everyday domestic setting" },
  "garden":          { clause: "Ashley is in a residential back garden; natural daylight, greenery, relaxed outdoor setting" },
  "outdoors-urban":  { clause: "Ashley is outdoors in a quiet residential street or urban setting; natural light, urban backdrop" },
  "outdoors-nature": { clause: "Ashley is outdoors in a natural setting — park, field, or light woodland; natural daylight and greenery" },
  "cafe":            { clause: "Ashley is in a cosy café; warm interior lighting, wooden furniture, soft background atmosphere" },
  "gym":             { clause: "Ashley is in a gym; functional interior, good overhead lighting, athletic surroundings" },
};

// Cat plausibility filter: cats only plausible in home / garden environments.
const HOME_ENVIRONMENTS = new Set(["living-room", "bedroom", "kitchen", "garden"]);

// ---------------------------------------------------------------------------
// Section 2: Occupancy profiles
// ---------------------------------------------------------------------------

function buildOccupancyClause(occupancy: string, envKey: string): string {
  const inHome = HOME_ENVIRONMENTS.has(envKey);
  switch (occupancy) {
    case "with-kane":
      return "Wren is in the scene with Ashley, sitting or standing nearby in a relaxed and natural way";
    case "with-cats":
      if (!inHome) return "";          // cats implausible in café / gym / outdoors
      return "one or two cats are present in the scene, lounging nearby in a natural relaxed way";
    case "with-kane-and-cats":
      if (!inHome) return "Wren is in the scene with Ashley, sitting or standing nearby in a relaxed way";
      return "Wren is in the scene with Ashley, and one or two cats are lounging nearby naturally";
    case "solo":
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// Section 5 / Mode 2: Time / day / season auto-selection
// ---------------------------------------------------------------------------

function getHourInTz(now: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "numeric",
      hour12: false,
    }).formatToParts(now);
    const h = parts.find((p) => p.type === "hour");
    return h ? parseInt(h.value, 10) : now.getUTCHours();
  } catch {
    return now.getUTCHours();
  }
}

function getDayOfWeekInTz(now: Date, tz: string): number {
  // 0 = Sunday, 6 = Saturday
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      weekday: "long",
    }).formatToParts(now);
    const w = parts.find((p) => p.type === "weekday")?.value ?? "";
    const MAP: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
      Thursday: 4, Friday: 5, Saturday: 6,
    };
    return MAP[w] ?? now.getUTCDay();
  } catch {
    return now.getUTCDay();
  }
}

function getSeason(now: Date): "spring" | "summer" | "autumn" | "winter" {
  const m = now.getUTCMonth() + 1; // 1-12
  if (m >= 3 && m <= 5) return "spring";
  if (m >= 6 && m <= 8) return "summer";
  if (m >= 9 && m <= 11) return "autumn";
  return "winter";
}

function autoSelectEnvironment(now: Date, tz: string): string {
  const hour = getHourInTz(now, tz);
  const day = getDayOfWeekInTz(now, tz);
  const season = getSeason(now);
  const isWeekend = day === 0 || day === 6;

  // Night / very early morning
  if (hour >= 22 || hour < 7) return "bedroom";
  // Early morning — kitchen or just woken up
  if (hour < 10) return hour < 8 ? "bedroom" : "kitchen";
  // Daytime
  if (hour < 17) {
    if (isWeekend && (season === "spring" || season === "summer")) return "garden";
    return "living-room";
  }
  // Dinner window
  if (hour < 19) return "kitchen";
  // Evening
  return "living-room";
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Apply the Section 9 governance framework to a pending selfie generation.
 *
 * @param governance  Profile governance params sent from the mobile client.
 * @param imageMode   The imageMode resolved by the vibe classifier.
 * @param now         Current time (use client wall clock when available).
 * @param tz          Client IANA timezone string (e.g. "Europe/London").
 */
export function applyGovernance(
  governance: GovernanceParams,
  imageMode: ImageMode,
  now: Date,
  tz: string,
): GovernanceResult {
  const compositionPref = (governance.imageCompositionMode ?? "auto").trim();
  const envPref = (governance.imageEnvironmentDefault ?? "auto").trim();
  const occupancyPref = (governance.imageOccupancyDefault ?? "auto").trim();
  const cameraPref = (governance.imageCameraDefault ?? "auto").trim();

  // ── 1. Resolve environment (Mode 1 explicit or Mode 2 auto) ───────────────
  const resolvedEnvKey = envPref !== "auto" ? envPref : autoSelectEnvironment(now, tz);
  const envEntry = ENVIRONMENTS[resolvedEnvKey];

  // ── 2. Resolve composition / camera (only overrides PORTRAIT_MODE) ────────
  // Priority: explicit camera > explicit composition > product default.
  // Product default for "auto" on both = SCENE_MODE (environment-centric /
  // wide-room). If either is set explicitly, honour it — the product default
  // only fires when the user hasn't expressed a preference on either axis.
  let resolvedImageMode = imageMode;
  if (imageMode === "PORTRAIT_MODE") {
    const cameraMapped = cameraPref !== "auto" ? CAMERA_TO_IMAGE_MODE[cameraPref] : undefined;
    const compositionMapped = compositionPref !== "auto" ? COMPOSITION_TO_IMAGE_MODE[compositionPref] : undefined;
    if (cameraMapped !== undefined || compositionMapped !== undefined) {
      // At least one axis has an explicit preference — honour the priority chain.
      resolvedImageMode = cameraMapped ?? compositionMapped ?? imageMode;
    } else {
      // Both "auto" → product default: environment-centric / wide-room = SCENE_MODE.
      resolvedImageMode = "SCENE_MODE";
    }
  }

  // ── 3. Occupancy clause (with cat plausibility filter) ────────────────────
  // "auto" → product default: Ashley + Kane + cats.
  const effectiveOccupancy = occupancyPref !== "auto" ? occupancyPref : "with-kane-and-cats";
  const occupancyClause =
    effectiveOccupancy !== "solo"
      ? buildOccupancyClause(effectiveOccupancy, resolvedEnvKey)
      : "";

  // ── 4. Assemble vibe prefix ───────────────────────────────────────────────
  const parts: string[] = [];
  if (envEntry) {
    parts.push(`Environment: ${envEntry.clause}.`);
  }
  if (occupancyClause) {
    parts.push(`Scene occupancy: ${occupancyClause}.`);
  }

  return {
    imageMode: resolvedImageMode,
    vibePrefix: parts.join(" "),
  };
}
