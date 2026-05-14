// =============================================================================
// VisualSpec — category-driven image-intent extraction (Wren spec May 2026)
// -----------------------------------------------------------------------------
// REPLACES the literal-phrase pattern with category vocabularies. Adding
// support for "lavender hair" / "platinum hair" / "any new colour" is now a
// one-line vocab addition, not a new regex branch.
//
// The seven categories from Wren's spec:
//   1. APPEARANCE     — hair colour, hairstyle, skin tone, expression
//   2. CLOTHING       — items, accessories, outfit themes
//   3. ENVIRONMENT    — location, time of day, weather
//   4. POSE / BODY    — body position / orientation
//   5. CAMERA         — shot type / framing
//   6. PROPS          — vehicles, tools, background objects
//   7. STYLE / MEDIUM — painting / sketch / concept art / etc.
//
// Output:
//   - VisualSpec     — structured attributes
//   - imageIntent    — was this a visual ask at all?
//   - resolvedMode   — which existing ImageMode it routes to
//   - description    — structured paragraph for buildModePromptBlock vibe
//
// This module is PURE — no I/O, no LLM calls. Deterministic, unit-testable.
// It runs ahead of the legacy regex gates in lib/imageFollowUp.ts; the legacy
// gates remain as a fallback for prompts the extractor doesn't recognise.
// =============================================================================

import type { ImageMode } from "./imageIntent.js";

// ---------------------------------------------------------------------------
// Category vocabularies
// ---------------------------------------------------------------------------
// Multi-word entries are matched as literal substrings (case-insensitive).
// Single-word entries use \b word boundaries to avoid sub-word matches
// (e.g. "red" must not match "reduce").

const HAIR_COLOURS = [
  "ginger", "red", "auburn", "copper", "strawberry blonde",
  "blonde", "blond", "platinum", "silver", "white", "grey", "gray",
  "brunette", "brown", "chestnut", "chocolate", "caramel",
  "black", "jet black", "raven",
  "blue", "navy", "turquoise", "teal", "aqua",
  "pink", "rose", "magenta",
  "purple", "lavender", "lilac", "violet",
  "green", "emerald", "mint",
  "orange", "peach",
  "rainbow", "ombre", "balayage",
];

const HAIRSTYLES = [
  "short", "long", "medium length", "shoulder length", "cropped",
  "curly", "wavy", "straight", "frizzy",
  "braided", "plaited", "plait", "braid", "french braid", "fishtail",
  "ponytail", "high ponytail", "low ponytail", "pigtails",
  "bun", "top knot", "messy bun", "space buns",
  "messy", "tied up", "tied back", "loose", "let down",
  "shaved", "buzzcut", "undercut", "mohawk",
  "bob", "lob", "pixie", "fringe", "bangs", "layered",
  "wet", "slicked back",
];

const SKIN_DESCRIPTORS = [
  "paler", "darker", "tanned", "sun-kissed", "sunkissed", "sun kissed",
  "pale", "fair", "olive", "bronzed", "golden", "glowing",
  "freckled", "freckles",
  "rosy", "flushed", "sallow",
];

const EXPRESSIONS = [
  "smile", "smiling", "grin", "grinning", "smirk", "smirking",
  "laugh", "laughing", "giggling", "giggle",
  "frown", "frowning", "scowl", "scowling",
  "serious", "stern", "stoic", "neutral",
  "sad", "tearful", "crying", "upset",
  "surprised", "shocked", "wide-eyed", "wide eyed",
  "angry", "furious", "glaring",
  "cheeky", "playful", "mischievous", "bashful", "shy",
  "wink", "winking", "tongue out", "pout", "pouting",
  "thoughtful", "contemplative", "dreamy",
  "tired", "exhausted", "sleepy",
  "confident", "determined", "focused",
];

const CLOTHING_ITEMS = [
  "dress", "gown", "sundress",
  "dungarees", "overalls",
  "hoodie", "jumper", "sweater", "cardigan",
  "jacket", "coat", "blazer", "cloak", "robe", "kimono",
  "t-shirt", "tshirt", "shirt", "blouse", "tank top", "crop top", "vest",
  "trousers", "pants", "jeans", "leggings", "shorts", "skirt", "mini skirt",
  "suit", "tuxedo",
  "pyjamas", "pajamas", "onesie", "tutu",
  "tracksuit", "sweatpants", "joggers",
  "uniform", "scrubs", "apron", "lab coat",
  "wedding dress", "ball gown",
  "bikini", "swimsuit",
  "amish outfit", "cowboy outfit", "chef outfit", "farmer outfit",
  "gothic outfit", "victorian dress", "medieval dress",
];

const ACCESSORIES = [
  "hat", "cap", "beanie", "beret", "fedora", "cowboy hat", "amish hat", "top hat",
  "crown", "tiara", "sash", "scarf", "bandana", "tie", "bowtie",
  "necklace", "choker", "pendant", "gold chain", "silver chain",
  "earrings", "studs", "hoops",
  "bracelet", "watch", "wristband",
  "glasses", "sunglasses", "shades",
  "gloves", "mittens",
  "belt", "suspenders",
  "boots", "wellies", "trainers", "sneakers", "heels", "stilettos", "flats", "sandals", "flip flops",
  "socks", "stockings", "tights",
  "backpack", "handbag", "tote", "clutch",
  "umbrella", "parasol",
  "mickey mouse ears", "cat ears", "headphones", "headband",
];

const ENVIRONMENT_LOCATIONS = [
  "beach", "sea", "ocean", "lake", "river", "pond",
  "field", "meadow", "garden", "park", "forest", "wood", "jungle", "desert",
  "mountain", "mountains", "hill", "hilltop", "valley", "cliff",
  "farm", "barnyard", "orchard", "vineyard",
  "street", "road", "alley", "pavement", "sidewalk",
  "city", "village", "town square", "market",
  "rooftop", "balcony", "terrace", "patio",
  "kitchen", "bedroom", "bathroom", "living room", "lounge", "study", "library",
  "cafe", "coffee shop", "pub", "bar", "restaurant", "diner", "bistro",
  "studio", "office", "warehouse", "gym", "theatre", "theater", "cinema",
  "shop", "store", "supermarket", "bakery",
  "church", "chapel", "cathedral", "temple",
  "barn", "stable", "shed", "greenhouse", "cellar", "attic", "garage",
  "school", "classroom", "university", "hall",
  "train station", "airport", "platform", "bus stop",
];

const SURFACES_AND_VEHICLES = [
  "sofa", "couch", "chair", "bed", "bench", "floor", "rug", "carpet", "stage", "throne",
  "tractor", "car", "truck", "bike", "motorbike", "horse", "boat", "train", "bus", "van", "plane", "ladder",
  "bonnet", "hood", "easel", "canvas", "steps", "staircase", "doorway", "window",
  "streetlight", "lamppost", "fence", "wall", "tree", "gate",
];

const VEHICLE_VOCAB = [
  "tractor", "car", "truck", "bike", "motorbike", "horse", "boat",
  "train", "bus", "van", "plane",
];

const TIME_OF_DAY = [
  "sunrise", "dawn", "early morning", "morning",
  "midday", "noon", "lunchtime", "afternoon",
  "evening", "golden hour", "dusk", "sunset", "twilight",
  "night", "midnight", "nighttime", "late night",
];

const WEATHER = [
  "rain", "raining", "rainy", "drizzle", "drizzling", "downpour", "storm", "stormy", "thunderstorm",
  "snow", "snowing", "snowy", "blizzard",
  "fog", "foggy", "mist", "misty", "hazy",
  "sun", "sunny", "sunshine",
  "cloud", "cloudy", "overcast",
  "wind", "windy", "breezy", "gale",
  "frost", "frosty", "icy",
];

const POSE_VERBS = [
  "sitting", "seated", "sat", "perched",
  "standing", "stood",
  "lying", "laying", "reclining", "stretched out", "sprawled",
  "kneeling", "crouching", "squatting",
  "leaning", "lounging", "propped",
  "walking", "strolling", "running", "sprinting", "jogging", "skipping",
  "jumping", "leaping", "dancing", "twirling",
  "holding", "carrying", "grasping", "clutching",
  "wearing", "dressed",
  "riding", "driving", "cycling",
  "posing", "modelling", "modeling",
  "cross-legged", "cross legged",
];

// Multi-word / unambiguous art keywords only. Bare "painting" / "drawing" /
// "sketch" are excluded because they collide with verb usage ("at an easel
// painting something" is a SCENE, not an art-reference request). When the
// user really does mean the noun, they say it with an article or possessive
// ("your painting", "a sketch", "the drawing") — the ART_NOUN_WITH_ARTICLE_RX
// below handles that case.
const ART_KEYWORDS = [
  "oil painting", "watercolour painting", "watercolor painting", "acrylic painting",
  "concept art", "art reference", "reference image",
  "mock-up", "mock up", "mockup", "canvas painting",
  "your artwork", "your latest artwork", "your art", "your painting",
  "your drawing", "your sketch", "your illustration",
];
// Allow up to two adjective-like words between the article/possessive and
// the noun ("your latest painting", "a quick rough sketch"). The trailing
// noun is the last capture group so callers can extract it.
const ART_NOUN_WITH_ARTICLE_RX =
  /\b(your|her|a|an|the|show\s+me\s+(?:a|an|the|your)|give\s+me\s+(?:a|an|the|your))\s+(?:\w+\s+){0,2}(painting|drawing|sketch|illustration|artwork)\b/i;

const FEET_ONLY_RX =
  /\b(just\s+(your|her|the)\s+(feet|shoes|socks|socked\s+feet)|feet\s+only|shoes\s+only|close[- ]?up\s+of\s+(your|her|the)\s+(feet|shoes|socks|socked\s+feet)|(picture|image|photo|shot)\s+of\s+(your|her|the)\s+(feet|shoes|socks|socked\s+feet))\b/i;

const SELFIE_RX =
  /\b(selfie|head\s?shot|face\s?shot|camera\s?held|holding\s+(the|a|her)\s+(camera|phone))\b/i;

const SEATED_LENGTHWISE_RX =
  /\b((couch|sofa)\s+lengthw(ay|ise)s?|sitting\s+lengthw(ay|ise)s?|lying\s+along\s+(the\s+)?(sofa|couch)|reclin(e|ing)\s+along\s+(the\s+)?(sofa|couch)|stretched\s+(out\s+)?(along|across)\s+(the\s+)?(sofa|couch))\b/i;

const FULL_BODY_RX =
  /\b(full[- ]?body|whole[- ]?body|head[- ]?to[- ]?toe|full[- ]?length|complete body|all of (you|her))\b/i;

const REQUEST_VERBS_RX =
  /\b(show|send|give|generate|make|create|render|draw|paint|illustrate|mock\s*up|visualise|visualize|picture|photograph|shoot)\b/i;
const REQUEST_FRAMING_RX =
  /\b(show\s+(me|us)|send\s+(me|us)|give\s+(me|us)|let\s+me\s+see|let'?s\s+see|how\s+about|what\s+about|i\s+want\s+to\s+see|i\s+(would|'?d)\s+like\s+to\s+see|can\s+i\s+see|could\s+i\s+see|i\s+want|i\s+need|i'?d\s+like)\b/i;
const SECOND_PERSON_RX = /\b(you|your|yourself|her|herself|ashley|ashley'?s)\b/i;
// Follow-up / edit cues from Wren spec May 2026:
//   "same but" / "same thing but"  / "same image but"
//   "change <X>" / "change it" / "change the <X>"
//   "for this image" / "for that photo"
//   "make it <X>"
//   "keep everything but" / "keep the rest but"
//   "different <X>" / "no different"
//   "add a/an <X>" / "remove the <X>" / "more <X>" / "less <X>"
//   "try again" / "do that again" / "one more time" / "no luck" / "didn't work"
// These set isFollowUp=true. The caller MUST then load the prior VisualSpec
// from history and merge the new (delta) spec onto it.
const FOLLOW_UP_PHRASES_RX =
  /\b(try\s+again|same\s+again|again\s+please|do\s+(it|that)\s+again|one\s+more\s+time|run\s+(it|that)\s+again|same\s+(but|thing\s+but|image\s+but|picture\s+but|photo\s+but)|but\s+(wider|change|different|with)|change\s+(it|that|the)|make\s+(it|her|him|your|the)|edit\s+(it|that)|for\s+(this|that)\s+(photo|image|picture)|keep\s+(everything|the\s+rest)\s+but|different\s+(outfit|background|colour|color|hair|pose|setting|scene|location|expression)|add\s+(a|an|the|some)\s+|remove\s+(the|that|her|his)\s+|take\s+off\s+(the|her|his)\s+|put\s+on\s+(a|an|the|her|his)\s+|more\s+(blurry|sharp|wide|cinematic|dramatic|colourful)|less\s+(blurry|sharp|wide|cinematic|dramatic)|no\s+luck|didn'?t\s+work)\b/i;
const IMAGE_DIAGNOSTIC_SUPPRESS_RX =
  /\b(didn'?t render|did not render|failed( to render)?|no (image|picture|photo|artifact) (came|appeared|arrived|landed)|wasn'?t (shown|sent|delivered)|cropped|broken|blank|never (came|arrived)|where('?s| is) (the|my) (image|picture|photo|selfie))\b/i;

// ---------------------------------------------------------------------------
// VisualSpec type
// ---------------------------------------------------------------------------

export type VisualMode =
  | "SCENE_IMAGE_MODE"
  | "FULL_BODY_MODE"
  | "FEET_DETAIL_MODE"
  | "SELFIE_MODE"
  | "PORTRAIT_MODE"
  | "ART_REFERENCE_MODE"
  | "SEATED_LENGTHWISE_FULL_BODY_MODE"
  | "RETRY_PREVIOUS_IMAGE_MODE"
  | "IMAGE_EDIT_MODE";

export interface VisualSpec {
  rawUserText: string;
  imageIntent: boolean;
  intentReason: string;
  /**
   * True when the latest user text is a follow-up / edit cue ("same but",
   * "change the background", "make it night", "different outfit", ...).
   * The caller MUST then load the prior VisualSpec from history and merge
   * THIS spec onto it via mergeVisualSpecs() before resolving the mode.
   * Renamed from isRetryOrEdit; the old field is kept as an alias for any
   * legacy reader.
   */
  isFollowUp: boolean;
  /** @deprecated alias for isFollowUp — preserved for any inline reader */
  isRetryOrEdit: boolean;

  appearance: {
    hairColour?: string;
    hairstyle?: string;
    skinTone?: string;
    expression?: string;
  };

  clothing: {
    items: string[];
    accessories: string[];
  };

  environment: {
    location?: string;
    timeOfDay?: string;
    weather?: string;
  };

  pose: {
    bodyPosition?: string;
  };

  framing: {
    shotType?: "close_up" | "medium" | "full_body" | "wide" | "extreme_wide";
  };

  props: {
    objects: string[];
    vehicles: string[];
  };

  style: {
    medium?: string;
    isArtworkRequest: boolean;
  };

  matchedTriggers: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFirstMatch(haystackLower: string, vocab: string[]): string | undefined {
  // Longest-first so multi-word terms ("messy bun", "wedding dress") win
  // over their single-word prefix ("bun", "dress"). Sorting per call is
  // cheap on these tiny vocab tables.
  const sorted = [...vocab].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    if (term.includes(" ") || term.includes("-")) {
      if (haystackLower.includes(term)) return term;
    } else {
      const rx = new RegExp(`\\b${term}\\b`, "i");
      if (rx.test(haystackLower)) return term;
    }
  }
  return undefined;
}

function findAllMatches(haystackLower: string, vocab: string[]): string[] {
  const hits = new Set<string>();
  for (const term of vocab) {
    if (term.includes(" ") || term.includes("-")) {
      if (haystackLower.includes(term)) hits.add(term);
    } else {
      const rx = new RegExp(`\\b${term}\\b`, "i");
      if (rx.test(haystackLower)) hits.add(term);
    }
  }
  return Array.from(hits);
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export function extractVisualSpec(text: string): VisualSpec {
  const raw = (text ?? "").toString();
  const lower = raw.toLowerCase();
  const matched: string[] = [];

  const spec: VisualSpec = {
    rawUserText: raw,
    imageIntent: false,
    intentReason: "",
    isFollowUp: false,
    isRetryOrEdit: false,
    appearance: {},
    clothing: { items: [], accessories: [] },
    environment: {},
    pose: {},
    framing: {},
    props: { objects: [], vehicles: [] },
    style: { isArtworkRequest: false },
    matchedTriggers: matched,
  };

  if (!raw.trim()) return spec;

  // Hair colour: "<colour> hair" / "hair <colour>" / "make ... hair <colour>"
  // / "<colour> ... hair". We only count a colour as a hair-colour when the
  // word "hair" appears in the same message, otherwise "blue jeans" would
  // wrongly become hair colour.
  if (/\bhair\b/i.test(raw)) {
    const colour = findFirstMatch(lower, HAIR_COLOURS);
    if (colour) {
      spec.appearance.hairColour = colour;
      matched.push(`appearance.hairColour=${colour}`);
    }
    const style = findFirstMatch(lower, HAIRSTYLES);
    if (style) {
      spec.appearance.hairstyle = style;
      matched.push(`appearance.hairstyle=${style}`);
    }
  }

  // Skin tone — only count when paired with the word "skin" or "complexion"
  // to avoid "pale blue" / "darker shade" false positives.
  if (/\b(skin|complexion)\b/i.test(raw)) {
    const tone = findFirstMatch(lower, SKIN_DESCRIPTORS);
    if (tone) {
      spec.appearance.skinTone = tone;
      matched.push(`appearance.skinTone=${tone}`);
    }
  }

  // Expression
  const expression = findFirstMatch(lower, EXPRESSIONS);
  if (expression) {
    spec.appearance.expression = expression;
    matched.push(`appearance.expression=${expression}`);
  }

  // Clothing — use "wearing" / "dressed" / "in (a|an) ..." cues to avoid
  // matching mention-of-clothing rather than request-for-clothing. Cheap heuristic:
  // if any clothing vocab is present AND the prompt has a request verb or pose
  // verb or "wearing/dressed/in", count it. Otherwise skip.
  const clothingHits = findAllMatches(lower, CLOTHING_ITEMS);
  const accessoryHits = findAllMatches(lower, ACCESSORIES);
  const hasClothingCue =
    /\b(wearing|dressed|in\s+(a|an|the|some|her|his|paint[- ]covered)|wears|put\s+on|change\s+(your|her|the)\s+outfit|outfit|change\s+clothes)\b/i.test(raw) ||
    REQUEST_VERBS_RX.test(raw) ||
    REQUEST_FRAMING_RX.test(raw);
  if (clothingHits.length && hasClothingCue) {
    spec.clothing.items = clothingHits;
    matched.push(`clothing.items=[${clothingHits.join(",")}]`);
  }
  if (accessoryHits.length && hasClothingCue) {
    spec.clothing.accessories = accessoryHits;
    matched.push(`clothing.accessories=[${accessoryHits.join(",")}]`);
  }

  // Environment / location
  // Real environment locations only — beaches, fields, kitchens, ...
  // Surfaces (sofa, bonnet, easel) and vehicles (car, tractor) are NOT
  // locations: they go into props.objects / props.vehicles below. This is
  // critical for state merging — "add a car" must not overwrite a prior
  // environment.location=field. The mode resolver still routes to SCENE_MODE
  // on the strength of any populated props field, so "Show me you on a
  // sofa" still routes correctly.
  const location = findFirstMatch(lower, ENVIRONMENT_LOCATIONS);
  if (location) {
    spec.environment.location = location;
    matched.push(`environment.location=${location}`);
  }

  const tod = findFirstMatch(lower, TIME_OF_DAY);
  if (tod) {
    spec.environment.timeOfDay = tod;
    matched.push(`environment.timeOfDay=${tod}`);
  }

  const weather = findFirstMatch(lower, WEATHER);
  if (weather) {
    spec.environment.weather = weather;
    matched.push(`environment.weather=${weather}`);
  }

  // Pose
  const pose = findFirstMatch(lower, POSE_VERBS);
  if (pose) {
    spec.pose.bodyPosition = pose;
    matched.push(`pose.bodyPosition=${pose}`);
  }

  // Framing — explicit shot-type wins
  if (/\b(close[- ]?up|extreme close[- ]?up)\b/i.test(raw)) {
    spec.framing.shotType = "close_up";
    matched.push("framing.shotType=close_up");
  } else if (/\b(extreme wide|extreme[- ]wide angle|very wide shot)\b/i.test(raw)) {
    spec.framing.shotType = "extreme_wide";
    matched.push("framing.shotType=extreme_wide");
  } else if (/\b(wide(?:[- ]angle)?|wide shot|landscape shot|wide landscape)\b/i.test(raw)) {
    spec.framing.shotType = "wide";
    matched.push("framing.shotType=wide");
  } else if (FULL_BODY_RX.test(raw)) {
    spec.framing.shotType = "full_body";
    matched.push("framing.shotType=full_body");
  } else if (/\b(medium shot|mid shot)\b/i.test(raw)) {
    spec.framing.shotType = "medium";
    matched.push("framing.shotType=medium");
  }

  // Props / vehicles
  const vehicleHits = findAllMatches(lower, VEHICLE_VOCAB);
  if (vehicleHits.length) {
    spec.props.vehicles = vehicleHits;
    matched.push(`props.vehicles=[${vehicleHits.join(",")}]`);
  }
  // Generic "object" props extracted from SURFACES_AND_VEHICLES that aren't
  // also vehicles or already captured as location. Used to enrich the prompt.
  const surfaceObjects = findAllMatches(lower, SURFACES_AND_VEHICLES).filter(
    (o) => !vehicleHits.includes(o) && o !== spec.environment.location,
  );
  if (surfaceObjects.length) {
    spec.props.objects = surfaceObjects;
    matched.push(`props.objects=[${surfaceObjects.join(",")}]`);
  }

  // Style / artwork — multi-word vocab OR explicit "<article> <art-noun>"
  const art = findFirstMatch(lower, ART_KEYWORDS);
  if (art) {
    spec.style.medium = art;
    spec.style.isArtworkRequest = true;
    matched.push(`style.medium=${art}`);
  } else if (ART_NOUN_WITH_ARTICLE_RX.test(raw)) {
    const m = raw.match(ART_NOUN_WITH_ARTICLE_RX);
    const noun = (m?.[m.length - 1] ?? "artwork").toLowerCase();
    spec.style.medium = noun;
    spec.style.isArtworkRequest = true;
    matched.push(`style.medium=${noun}`);
  }

  // ---- Image-intent decision ----
  if (IMAGE_DIAGNOSTIC_SUPPRESS_RX.test(raw)) {
    spec.imageIntent = false;
    spec.intentReason = "diagnostic phrasing — talking ABOUT a previous image, not requesting one";
    return spec;
  }

  const hasMutation =
    !!spec.appearance.hairColour ||
    !!spec.appearance.hairstyle ||
    !!spec.appearance.skinTone ||
    !!spec.appearance.expression ||
    spec.clothing.items.length > 0 ||
    spec.clothing.accessories.length > 0 ||
    !!spec.environment.location ||
    !!spec.environment.timeOfDay ||
    !!spec.environment.weather ||
    !!spec.pose.bodyPosition ||
    !!spec.framing.shotType ||
    spec.props.vehicles.length > 0 ||
    spec.props.objects.length > 0 ||
    spec.style.isArtworkRequest;

  const hasRequestCue = REQUEST_VERBS_RX.test(raw) || REQUEST_FRAMING_RX.test(raw);
  const hasSecondPerson = SECOND_PERSON_RX.test(raw);
  const hasFollowUpCue = FOLLOW_UP_PHRASES_RX.test(raw);

  if (hasFollowUpCue) {
    spec.isFollowUp = true;
    spec.isRetryOrEdit = true;
    spec.imageIntent = true;
    spec.intentReason =
      "follow-up/edit phrasing — caller MUST merge with prior VisualSpec from history";
    // Note: do NOT return early. We still want to extract any delta
    // attributes ("change the background to a beach" needs location=beach
    // captured BELOW, not just isFollowUp=true). Continue to attribute
    // extraction; the resolver consumes both flags.
  }

  // A request is image intent if:
  //  - explicit selfie / artwork request (no mutation needed), OR
  //  - request cue + (mutation OR second-person reference + framing/pose)
  if (SELFIE_RX.test(raw) && hasRequestCue) {
    spec.imageIntent = true;
    spec.intentReason = "explicit selfie language with request cue";
    return spec;
  }
  if (spec.style.isArtworkRequest && hasRequestCue) {
    spec.imageIntent = true;
    spec.intentReason = "artwork request with request cue";
    return spec;
  }
  if (hasRequestCue && hasMutation) {
    spec.imageIntent = true;
    spec.intentReason = "request cue + extracted visible mutation";
    return spec;
  }
  if (hasRequestCue && hasSecondPerson && (spec.framing.shotType || spec.pose.bodyPosition)) {
    spec.imageIntent = true;
    spec.intentReason = "request cue + second-person + pose/framing";
    return spec;
  }

  // Follow-up phrasing alone is enough to count as image intent, even
  // without an explicit request cue ("make her blonde", "different outfit"
  // are valid edit asks the moment a prior image exists). The earlier
  // branch already set imageIntent=true; we re-affirm here so this final
  // fallthrough doesn't clobber it.
  if (hasFollowUpCue) {
    spec.imageIntent = true;
    spec.intentReason =
      "follow-up/edit phrasing — caller MUST merge with prior VisualSpec from history";
    return spec;
  }

  spec.imageIntent = false;
  spec.intentReason = "no request cue or no extracted visible mutation";
  return spec;
}

// ---------------------------------------------------------------------------
// Mode resolver
// ---------------------------------------------------------------------------
// Maps the spec to one of the EXISTING ImageMode values so the rest of the
// pipeline (wrapperFor, buildModePromptBlock) keeps working unchanged.
//
// Priority order matches Wren spec §5: retry > feet > artwork > seated-
// lengthwise > full-body > scene > selfie > portrait.

export function resolveImageModeFromSpec(
  spec: VisualSpec,
  opts?: { hasPriorAttempt?: boolean },
): { mode: ImageMode; reason: string } {
  if (spec.isFollowUp && opts?.hasPriorAttempt) {
    // Caller handles retry by replaying the prior attempt's mode. We surface
    // SCENE_MODE here as a safe default; the send-again branch in
    // resolveImageFollowUp will override with the prior mode.
    return { mode: "SCENE_MODE", reason: "retry/edit — caller replays prior attempt" };
  }
  if (FEET_ONLY_RX.test(spec.rawUserText)) {
    return { mode: "FEET_DETAIL_MODE", reason: "feet/shoes-only request" };
  }
  if (spec.style.isArtworkRequest) {
    return { mode: "ART_REFERENCE_MODE", reason: "artwork / reference request" };
  }
  if (SEATED_LENGTHWISE_RX.test(spec.rawUserText)) {
    return {
      mode: "SEATED_LENGTHWISE_FULL_BODY_MODE",
      reason: "seated lengthwise / lying along sofa",
    };
  }
  if (spec.framing.shotType === "full_body") {
    return { mode: "FULL_BODY_MODE", reason: "explicit full-body framing" };
  }
  // Any scene mutation routes to SCENE_MODE — environment, wardrobe, pose,
  // props, vehicles, accessories, weather, time of day. This is Wren spec §6.
  const hasSceneMutation =
    !!spec.environment.location ||
    !!spec.environment.timeOfDay ||
    !!spec.environment.weather ||
    !!spec.pose.bodyPosition ||
    spec.clothing.items.length > 0 ||
    spec.clothing.accessories.length > 0 ||
    spec.props.vehicles.length > 0 ||
    spec.props.objects.length > 0;
  if (hasSceneMutation) {
    return { mode: "SCENE_MODE", reason: "scene mutation present (env/wardrobe/pose/props)" };
  }
  // Appearance-only change with no scene context → close-up to show the change
  const hasAppearanceOnly =
    !!spec.appearance.hairColour ||
    !!spec.appearance.hairstyle ||
    !!spec.appearance.skinTone ||
    !!spec.appearance.expression;
  if (hasAppearanceOnly) {
    return { mode: "SELFIE_MODE", reason: "appearance-only change — close-up to show it" };
  }
  if (SELFIE_RX.test(spec.rawUserText)) {
    return { mode: "SELFIE_MODE", reason: "explicit selfie language" };
  }
  return { mode: "PORTRAIT_MODE", reason: "no specific cue — default portrait" };
}

// ---------------------------------------------------------------------------
// Structured description builder
// ---------------------------------------------------------------------------
// Produces a category-organised paragraph that the existing buildModePromptBlock
// uses as the "vibe" field. This is the bit that actually propagates extracted
// attributes into the generator prompt — replacing the previous "dump the raw
// user text in" pattern.

export function buildVisualDescription(spec: VisualSpec): string {
  const parts: string[] = [];

  if (spec.environment.location || spec.environment.timeOfDay || spec.environment.weather) {
    const env: string[] = [];
    if (spec.environment.location) env.push(`set ${prepFor(spec.environment.location)} ${spec.environment.location}`);
    if (spec.environment.timeOfDay) env.push(`at ${spec.environment.timeOfDay}`);
    if (spec.environment.weather) env.push(`with ${spec.environment.weather} weather`);
    parts.push(`Environment: ${env.join(", ")}.`);
  }

  if (spec.pose.bodyPosition) {
    parts.push(`Pose: ${spec.pose.bodyPosition}.`);
  }

  if (spec.clothing.items.length || spec.clothing.accessories.length) {
    const wardrobe: string[] = [];
    if (spec.clothing.items.length) wardrobe.push(`wearing ${spec.clothing.items.join(", ")}`);
    if (spec.clothing.accessories.length)
      wardrobe.push(`with ${spec.clothing.accessories.join(", ")}`);
    parts.push(`Wardrobe: ${wardrobe.join(", ")}.`);
  }

  if (spec.props.vehicles.length || spec.props.objects.length) {
    const props = [...spec.props.vehicles, ...spec.props.objects];
    parts.push(`Props/objects: ${props.join(", ")}.`);
  }

  const appearance: string[] = [];
  if (spec.appearance.hairColour) appearance.push(`${spec.appearance.hairColour} hair`);
  if (spec.appearance.hairstyle) appearance.push(`${spec.appearance.hairstyle} style`);
  if (spec.appearance.skinTone) appearance.push(`${spec.appearance.skinTone} skin`);
  if (spec.appearance.expression) appearance.push(`${spec.appearance.expression} expression`);
  if (appearance.length) parts.push(`Appearance: ${appearance.join(", ")}.`);

  if (spec.framing.shotType) {
    parts.push(`Framing: ${spec.framing.shotType.replace("_", " ")} shot.`);
  }

  if (spec.style.medium) {
    parts.push(`Style: ${spec.style.medium}.`);
  }

  // Always include the original user phrasing too — protects against
  // attributes the extractor missed. The structured lines above ANCHOR
  // the prompt; the raw line preserves nuance.
  parts.push(`Original request: ${spec.rawUserText.trim()}`);

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// State merging
// ---------------------------------------------------------------------------
// Wren spec May 2026: when isFollowUp=true, load prior VisualSpec, modify
// only the requested fields, regenerate. Do NOT rebuild from scratch.
//
// Merge semantics:
//   - prior is the canonical state; delta is the new user message's spec
//   - any non-empty delta field OVERWRITES the prior (that's the user's edit)
//   - prior fields that delta did not touch CARRY OVER unchanged
//   - clothing.items and props.objects are REPLACED only if delta has any
//     entries; "add a car" → delta.props.vehicles=[car] should ADD, not
//     replace, so we union vehicles/objects/items/accessories instead of
//     overwriting
//   - imageIntent and intentReason follow the delta (the new user turn
//     decides whether this is still a visual ask)
//   - rawUserText is the delta's text; matchedTriggers concatenated for log

// "different outfit", "change her outfit", "take off the hoodie", "new dress
// instead", "wearing something different" — these replace, they don't add.
// "wedding dress" + prior "dungarees" must NOT yield both.
const CLOTHING_REPLACE_RX =
  /\b(different\s+(outfit|clothing|clothes|top|bottom|dress|shirt|hoodie|jacket|skirt|trousers|shoes)|change\s+(her|the|your)\s+(outfit|clothing|clothes|top|dress|shirt|hoodie|jacket|skirt|trousers|shoes)|take\s+off\s+(the|her|his|your)\s+\w+|wearing\s+(something|anything)\s+(different|else)|new\s+\w+\s+instead|swap\s+(out\s+)?(the|her|his|your)\s+\w+|put\s+(her|him|your)\s+in\s+(a|an|the)\s+\w+)\b/i;

export function mergeVisualSpecs(prior: VisualSpec, delta: VisualSpec): VisualSpec {
  const replaceClothing = CLOTHING_REPLACE_RX.test(delta.rawUserText);
  const merged: VisualSpec = {
    rawUserText: delta.rawUserText,
    imageIntent: delta.imageIntent || prior.imageIntent,
    intentReason: delta.intentReason || prior.intentReason,
    isFollowUp: delta.isFollowUp,
    isRetryOrEdit: delta.isRetryOrEdit,
    appearance: {
      hairColour: delta.appearance.hairColour ?? prior.appearance.hairColour,
      hairstyle: delta.appearance.hairstyle ?? prior.appearance.hairstyle,
      skinTone: delta.appearance.skinTone ?? prior.appearance.skinTone,
      expression: delta.appearance.expression ?? prior.appearance.expression,
    },
    clothing: {
      // Replace when the user signals substitution AND the delta has new
      // clothing entries; otherwise union (so "add a scarf" still adds).
      // Delta with no clothing content + replace cue → keep prior (the
      // user said "different outfit" without naming one yet, e.g. as a
      // standalone follow-up).
      items: replaceClothing && delta.clothing.items.length > 0
        ? delta.clothing.items
        : unionStrings(prior.clothing.items, delta.clothing.items),
      accessories: replaceClothing && delta.clothing.accessories.length > 0
        ? delta.clothing.accessories
        : unionStrings(prior.clothing.accessories, delta.clothing.accessories),
    },
    environment: {
      location: delta.environment.location ?? prior.environment.location,
      timeOfDay: delta.environment.timeOfDay ?? prior.environment.timeOfDay,
      weather: delta.environment.weather ?? prior.environment.weather,
    },
    pose: {
      bodyPosition: delta.pose.bodyPosition ?? prior.pose.bodyPosition,
    },
    framing: {
      shotType: delta.framing.shotType ?? prior.framing.shotType,
    },
    props: {
      objects: unionStrings(prior.props.objects, delta.props.objects),
      vehicles: unionStrings(prior.props.vehicles, delta.props.vehicles),
    },
    style: {
      medium: delta.style.medium ?? prior.style.medium,
      isArtworkRequest: delta.style.isArtworkRequest || prior.style.isArtworkRequest,
    },
    matchedTriggers: [
      ...prior.matchedTriggers.map((t) => `prior:${t}`),
      ...delta.matchedTriggers.map((t) => `delta:${t}`),
    ],
  };
  return merged;
}

function unionStrings(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of [...a, ...b]) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Persistence — embed VisualSpec in the stored vibe
// ---------------------------------------------------------------------------
// State persistence without a DB migration: append a [[VSPEC]]<json>[[/VSPEC]]
// suffix to the vibe text that is stored on the assistant message
// (selfieVibe column). The existing encodeStoredVibe(mode, vibe) wraps it
// with the MODE prefix; decodeStoredVibe strips the MODE prefix back off.
// Our marker rides inside the vibe portion intact through both round trips.
//
// On the next user turn, findPriorImageAttempt returns the decoded vibe text
// (the inner string, MODE prefix already stripped). extractVisualSpecFromVibe
// pulls out the JSON, JSON.parse, gives back a VisualSpec to merge into.
//
// If the marker is absent (legacy stored vibes from before this code shipped),
// extractVisualSpecFromVibe returns null and the caller treats the follow-up
// as if no prior spec existed (degrades to send-again with prior vibe text).

// Marker uses braces, NOT brackets, because synthesizeImageActionReply
// runs `description.replace(/\]/g, ")")` before encoding to avoid breaking
// the `[image: MODE | desc]` parser. Brackets in our marker would be
// destroyed silently. Braces survive that sanitiser intact and round-trip
// through encodeStoredVibe → decodeStoredVibe unchanged.
const VSPEC_MARKER_OPEN = "{{VSPEC}}";
const VSPEC_MARKER_CLOSE = "{{/VSPEC}}";
const VSPEC_BLOCK_RX = /\{\{VSPEC\}\}([\s\S]*?)\{\{\/VSPEC\}\}/;

export function encodeVibeWithSpec(description: string, spec: VisualSpec): string {
  // Strip our own internal book-keeping fields before serialising — they're
  // useful for logs at extraction time but bloat the stored row. We keep ALL
  // semantic fields (categories, flags, triggers).
  // matchedTriggers are debug telemetry — useful in modeReason logs at
  // extraction time, but they grow on every merge (mergeVisualSpecs
  // re-prefixes prior entries with "prior:"), and the stored vibe is
  // size-capped (MAX_VIBE_LEN=4000) when it gets POSTed back to
  // /chat/selfie. Drop them from the persisted payload so a long
  // follow-up chain can't bloat past the limit.
  const payload = {
    appearance: spec.appearance,
    clothing: spec.clothing,
    environment: spec.environment,
    pose: spec.pose,
    framing: spec.framing,
    props: spec.props,
    style: spec.style,
  };
  // BASE64 the JSON payload, NOT raw JSON. Why: synthesizeImageActionReply
  // runs `description.replace(/\]/g, ")")` to protect the `[image: MODE | desc]`
  // parser. JSON arrays use `[` and `]` as delimiters, so raw JSON would be
  // corrupted in transit ("items":["dungarees"] → "items":["dungarees)" — no
  // longer parseable). Base64's alphabet (A-Za-z0-9+/=) survives that
  // sanitiser and every other transform along the encodeStoredVibe →
  // decodeStoredVibe pipeline. The marker braces themselves contain no
  // brackets, so they ride through too.
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `${description.trim()} ${VSPEC_MARKER_OPEN}${b64}${VSPEC_MARKER_CLOSE}`;
}

export function extractVisualSpecFromVibe(
  vibe: string | null | undefined,
): { description: string; spec: VisualSpec | null } {
  const text = (vibe ?? "").toString();
  if (!text) return { description: "", spec: null };
  const m = text.match(VSPEC_BLOCK_RX);
  if (!m) return { description: text.trim(), spec: null };
  const description = text.replace(VSPEC_BLOCK_RX, "").trim();
  try {
    // Base64 → utf8 JSON → parsed object. If the payload was a legacy
    // raw-JSON string (from before this code switched to base64), the
    // base64 decode will return garbage and JSON.parse will throw → we
    // fall through to spec=null, which is the correct degraded behaviour.
    const decoded = Buffer.from(m[1] ?? "", "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object") {
      return { description, spec: null };
    }
    // Reconstruct a VisualSpec shape. Defensive defaults for every field so
    // a malformed/older payload doesn't blow up the resolver.
    const spec: VisualSpec = {
      rawUserText: description,
      imageIntent: true,
      intentReason: "rehydrated from prior assistant attempt's stored VSPEC",
      isFollowUp: false,
      isRetryOrEdit: false,
      appearance: parsed.appearance ?? {},
      clothing: {
        items: Array.isArray(parsed.clothing?.items) ? parsed.clothing.items : [],
        accessories: Array.isArray(parsed.clothing?.accessories) ? parsed.clothing.accessories : [],
      },
      environment: parsed.environment ?? {},
      pose: parsed.pose ?? {},
      framing: parsed.framing ?? {},
      props: {
        objects: Array.isArray(parsed.props?.objects) ? parsed.props.objects : [],
        vehicles: Array.isArray(parsed.props?.vehicles) ? parsed.props.vehicles : [],
      },
      style: {
        medium: parsed.style?.medium,
        isArtworkRequest: Boolean(parsed.style?.isArtworkRequest),
      },
      matchedTriggers: Array.isArray(parsed.matchedTriggers) ? parsed.matchedTriggers : [],
    };
    return { description, spec };
  } catch {
    return { description, spec: null };
  }
}

function prepFor(loc: string): string {
  // Heuristic preposition for the location word. Outdoors = "in", surfaces = "on".
  const onSurfaces = new Set([
    "sofa", "couch", "chair", "bed", "bench", "floor", "rug", "carpet", "stage", "throne",
    "tractor", "car", "truck", "bike", "motorbike", "horse", "boat", "train", "bus", "van", "plane", "ladder",
    "bonnet", "hood", "easel", "canvas", "steps", "staircase",
    "rooftop", "balcony", "terrace", "patio",
  ]);
  return onSurfaces.has(loc) ? "on the" : "in the";
}
