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
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ImageDefaultsExtra = {
  timeOfDay?: string | null;
  season?: string | null;
  activity?: string | null;
  shotDistance?: string | null;
  cameraAwareness?: string | null;
};

export type GovernanceParams = {
  imageCompositionMode?: string | null;
  imageEnvironmentDefault?: string | null;
  imageOccupancyDefault?: string | null;
  imageCameraDefault?: string | null;
  imageDefaultsExtra?: ImageDefaultsExtra | null;
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
  // ── Home ──────────────────────────────────────────────────────────────────
  "living-room":      { clause: "Ashley is in the living room of her flat; warm, familiar home setting with soft furnishings and natural daylight" },
  "bedroom":          { clause: "Ashley is in the bedroom; soft ambient light, relaxed and private atmosphere" },
  "kitchen":          { clause: "Ashley is in the kitchen; bright everyday domestic setting" },
  "study":            { clause: "Ashley is in a home study or office; bookshelves, a desk, focused quiet atmosphere with warm lighting" },
  "garden":           { clause: "Ashley is in a residential back garden; natural daylight, greenery, relaxed outdoor setting" },
  "bathroom":         { clause: "Ashley is in a home bathroom; clean domestic interior, bright or warm lighting, private and relaxed" },
  // ── Food & Drink ──────────────────────────────────────────────────────────
  "cafe":             { clause: "Ashley is in a cosy café; warm interior lighting, wooden furniture, soft background atmosphere" },
  "restaurant":       { clause: "Ashley is in a restaurant; tables set for dining, warm ambient lighting, other diners present, relaxed social atmosphere" },
  "pub":              { clause: "Ashley is in a British pub; wooden furniture, beer taps at the bar, warm lighting, relaxed social atmosphere" },
  "bar":              { clause: "Ashley is in a bar or cocktail bar; dim warm lighting, bottles behind the counter, relaxed evening atmosphere" },
  "vineyard":         { clause: "Ashley is at a vineyard or winery; rows of vines, natural daylight, rustic and scenic outdoor setting" },
  "whisky-distillery":{ clause: "Ashley is inside a whisky distillery; copper stills, oak casks, stone or brick interior, warm atmospheric lighting" },
  // ── Entertainment ─────────────────────────────────────────────────────────
  "nightclub":        { clause: "Ashley is in a nightclub; low lighting, coloured lights, dancing crowd, music venue atmosphere" },
  "music-gig":        { clause: "Ashley is at a live music gig; stage lighting, crowd, intimate venue atmosphere" },
  "festival":         { clause: "Ashley is at an outdoor music festival; colourful crowds, tents and stages, natural daylight, lively atmosphere" },
  "concert":          { clause: "Ashley is at a concert or live performance; auditorium seating, stage lighting, expectant atmosphere" },
  "sporting-event":   { clause: "Ashley is watching a sporting event from the stands; crowd, pitch or track visible, natural daylight or floodlighting" },
  "cinema":           { clause: "Ashley is in a cinema; rows of seats, large screen, darkened room, warm ambient lighting" },
  "house-party":      { clause: "Ashley is at a house party; domestic interior, groups of people, relaxed social atmosphere, warm lighting" },
  // ── Sports Venues ─────────────────────────────────────────────────────────
  "football-pitch":   { clause: "Ashley is on a football pitch during a match or training session; open grass, goalposts visible, players and crowd in the background, natural daylight, outdoor sports atmosphere. The camera is positioned 15-20 metres back. Ashley is a small figure on the pitch, not the foreground subject. The match and the pitch are the subject. She is one player among fifteen or twenty visible on the field. Ashley occupies no more than 10-15% of the total frame. Ashley is captured mid-action — running, sprinting toward the ball, making a tackle, calling for a pass, or celebrating. She is not standing still. She is not posing. She does not know the camera is there." },
  "football-stadium": { clause: "Ashley is inside a football stadium; rows of seats, pitch visible below, crowd filling the stands, floodlit or natural daylight" },
  "rugby-ground":     { clause: "Ashley is at a rugby ground; open grass pitch, posts visible, players and crowd present, natural daylight, outdoor sports atmosphere" },
  "rugby-pitch":      { clause: "Ashley is on a rugby pitch or at a rugby ground; open grass, posts visible, players and crowd present, natural daylight, outdoor sports atmosphere" },
  "sport-venue":      { clause: "Ashley is at an outdoor sports venue; stands, pitch or track visible, crowd present, natural daylight, active sporting atmosphere" },
  "stadium":          { clause: "Ashley is inside a large sports stadium; rows of seats, pitch visible below, crowd filling the stands, floodlit or natural daylight" },
  "gym":              { clause: "Ashley is in a gym; functional interior, good overhead lighting, athletic surroundings" },
  // ── Public ────────────────────────────────────────────────────────────────
  "museum":           { clause: "Ashley is inside a museum; high ceilings, display cases, natural or gallery lighting, quiet contemplative atmosphere" },
  "art-gallery":      { clause: "Ashley is inside an art gallery; white walls, framed works, clean gallery lighting, calm and considered atmosphere" },
  "library":          { clause: "Ashley is inside a library; shelves of books, reading tables, quiet studious atmosphere, warm or natural lighting" },
  "market":           { clause: "Ashley is at an outdoor or covered market; stalls, produce, crowds of shoppers, natural daylight or warm indoor lighting" },
  "high-street":      { clause: "Ashley is on a busy high street; shopfronts, pedestrians, natural daylight, urban British street setting" },
  "train-station":    { clause: "Ashley is at a train station; platforms, departures board, commuters and travellers, busy transient atmosphere" },
  // ── Outdoor ───────────────────────────────────────────────────────────────
  "outdoors-urban":   { clause: "Ashley is outdoors in a quiet residential street or urban setting; natural light, urban backdrop" },
  "outdoors-nature":  { clause: "Ashley is outdoors in a natural setting — park, field, or light woodland; natural daylight and greenery" },
  "park":             { clause: "Ashley is in a public park; open grass, trees, paths, natural daylight, relaxed outdoor atmosphere" },
  "woodland":         { clause: "Ashley is in light woodland or a forested path; dappled light through trees, natural greenery, quiet and calm" },
  "beach":            { clause: "Ashley is on a beach; sand, sea, natural light, open sky, relaxed coastal atmosphere" },
  "city-centre":      { clause: "Ashley is in a city centre; architecture, streets, pedestrians, urban energy, natural daylight" },
  "walking-trail":    { clause: "Ashley is on a walking or hiking trail; open countryside, footpath, natural daylight, outdoors and active" },
  // ── Travel ────────────────────────────────────────────────────────────────
  "hotel":            { clause: "Ashley is in a hotel room or hotel lobby; well-appointed interior, soft furnishings, ambient lighting, temporary-stay atmosphere" },
  "holiday-cottage":  { clause: "Ashley is in a holiday cottage; cosy domestic interior, exposed beams or stone, warm lighting, relaxed holiday atmosphere" },
  "beach-holiday":    { clause: "Ashley is on a beach holiday; sand, sea, sun, natural light, open sky, relaxed coastal atmosphere" },
  "mountain-retreat": { clause: "Ashley is at a mountain retreat or highland setting; dramatic landscape, open sky, natural daylight, rugged outdoor atmosphere" },
};

// Cat plausibility filter: cats only plausible in home / garden environments.
const HOME_ENVIRONMENTS = new Set(["living-room", "bedroom", "kitchen", "study", "garden", "bathroom", "holiday-cottage"]);

// ---------------------------------------------------------------------------
// Section 2: Occupancy profiles
// ---------------------------------------------------------------------------

function buildOccupancyClause(occupancy: string, envKey: string): string {
  const inHome = HOME_ENVIRONMENTS.has(envKey);
  switch (occupancy) {
    case "with-kane":
      return "Kane is in the scene with Ashley, sitting or standing nearby in a relaxed and natural way";
    case "with-cats":
      if (!inHome) return "";          // cats implausible in café / gym / outdoors
      return "one or two cats are present in the scene, lounging nearby in a natural relaxed way";
    case "with-kane-and-cats":
      if (!inHome) return "Kane is in the scene with Ashley, sitting or standing nearby in a relaxed way";
      return "Kane is in the scene with Ashley, and one or two cats are lounging nearby naturally";
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
  const extra = governance.imageDefaultsExtra ?? {};
  const timeOfDay = (extra.timeOfDay ?? "auto").trim();
  const season = (extra.season ?? "auto").trim();
  const activity = (extra.activity ?? "auto").trim();
  const shotDistance = (extra.shotDistance ?? "auto").trim();
  const cameraAwareness = (extra.cameraAwareness ?? "unaware").trim();

  // ── 1. Resolve environment (Mode 1 explicit or Mode 2 auto) ───────────────
  const resolvedEnvKey = envPref !== "auto" ? envPref : autoSelectEnvironment(now, tz);
  const envEntry = ENVIRONMENTS[resolvedEnvKey];
  if (!envEntry) {
    logger.warn({ resolvedEnvKey, envPref }, `Unknown environment key: "${resolvedEnvKey}" — no environment clause injected into prompt`);
  }

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

  // ── 5. Extra fields — time of day, season, activity, shot distance ─────────
  const TOD_LABELS: Record<string, string> = {
    morning: "morning light",
    afternoon: "afternoon light",
    evening: "evening light",
    night: "night-time, low ambient light",
  };
  if (timeOfDay !== "auto" && TOD_LABELS[timeOfDay]) {
    parts.push(`Time of day: ${TOD_LABELS[timeOfDay]}.`);
  }

  const SEASON_LABELS: Record<string, string> = {
    spring: "spring",
    summer: "summer",
    autumn: "autumn",
    winter: "winter",
  };
  if (season !== "auto" && SEASON_LABELS[season]) {
    parts.push(`Season: ${SEASON_LABELS[season]}.`);
  }

  if (activity !== "auto" && activity) {
    parts.push(`Activity: ${activity}.`);
    if (activity === "playing football") {
      parts.push("Ashley is wearing a football jersey and shorts in colours matching one of the teams visible on the pitch. She is dressed as a player, not a spectator.");
    }
  }

  const SHOT_LABELS: Record<string, string> = {
    "close-up":     "close-up shot",
    "half-body":    "half-body shot",
    "full-body":    "full-body shot",
    "wide-room":    "wide environmental shot",
    "architectural":"architectural wide shot",
  };
  if (shotDistance !== "auto" && SHOT_LABELS[shotDistance]) {
    parts.push(`Shot distance: ${SHOT_LABELS[shotDistance]}.`);
  }

  // ── 6. Camera awareness ───────────────────────────────────────────────────
  const AWARENESS_LABELS: Record<string, string> = {
    unaware:  "Ashley is unaware of the camera — candid, natural, not posed",
    indirect: "Ashley is glancing obliquely toward the camera, not directly",
    direct:   "Ashley is looking directly into the camera",
    auto:     "Ashley is unaware of the camera — candid, natural, not posed",
  };
  const awarenessClause = AWARENESS_LABELS[cameraAwareness] ?? AWARENESS_LABELS["unaware"]!;
  parts.push(`Camera awareness: ${awarenessClause}.`);

  return {
    imageMode: resolvedImageMode,
    vibePrefix: parts.join(" "),
  };
}
