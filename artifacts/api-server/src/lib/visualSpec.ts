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
import { classifyIntent } from "./intentClassifier.js";
import { classifySubject } from "./subjectClassifier.js";

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

// ---------------------------------------------------------------------------
// Action-based visual intent (Wren spec May 2026)
// ---------------------------------------------------------------------------
// "If a sentence describes something a camera can capture, generate an image."
// These are the action signals that flip imageIntent=true ON THEIR OWN —
// no "show me" / "send" request cue required. Stop thinking categories,
// start thinking "can a camera see this?".

// Verbs whose mere presence (even bare, no object) means the user is
// describing a performative/visible state. "waving" alone is camera-worthy;
// "sitting" alone is not (could be roleplay narration).
const PERFORMATIVE_VERBS = [
  "waving", "wave",
  "pointing", "point",
  "winking", "winks", "wink",
  "saluting", "salutes", "salute",
  "shrugging", "shrugs", "shrug",
  "smirking", "smirks", "smirk",
  "smiling", "smiles", "smile",
  "laughing", "laughs", "laugh",
  "blowing a kiss", "blowing kisses", "blows a kiss",
  "kissing the camera", "kisses the camera",
  "posing", "poses", "pose",
  "modelling", "modeling", "models",
  "dancing", "dances", "dance",
  "twirling", "twirls", "twirl",
  "spinning", "spins",
  "jumping", "jumps", "leaps", "leaping",
  "stretching", "stretches", "stretch",
  "yawning", "yawns",
  "crying", "cries",
  "frowning", "frowns",
  "nodding", "nods",
  "clapping", "claps",
];

// Multi-word and single-word gesture names — when these appear (with or
// without an action verb) we treat them as visual intent. Gestures exist
// to be photographed.
const GESTURE_VOCAB = [
  "peace sign", "peace fingers", "v sign", "v-sign", "victory sign",
  "thumbs up", "thumbs-up", "thumb up",
  "thumbs down", "thumbs-down", "thumb down",
  "ok sign", "ok hand", "okay sign",
  "finger gun", "finger guns",
  "finger heart", "finger hearts", "heart hands", "heart hand",
  "double peace", "double peace sign",
  "salute",
  "wink", "winky face",
  "shrug",
  "fist bump", "high five", "high-five",
  "blowing a kiss", "kiss to the camera", "air kiss",
  "rock on", "horns up", "metal horns",
  "pinky promise",
  "shaka",
];

// "holding X" / "with X in (her|his|my|the) hand" / "using X" /
// "carrying X" / "posing with X" / "interacting with X" /
// "sitting/standing/walking with X" — captures the OBJECT X (1-4 word noun
// phrase) into props.objects AND captures the verb into pose.action. This
// is the primary action+object pattern.
// Object-phrase capture: greedy 1-4 word noun phrase. We capture WORDS
// atomically (each `[a-z'\-]+`) instead of arbitrary characters so the
// non-greedy match doesn't bail out at the first inter-word space. The
// trailing lookahead anchors on real clause boundaries (punctuation, end
// of string, OR a stop-word like "doing"/"making"/"and"/"with"/"in"/...).
// Without the stop-word list, "holding a frying pan doing a peace sign"
// would gobble "frying pan doing a" because `\s` satisfies a permissive
// lookahead — the explicit list keeps the object phrase tight.
const NOUN_PHRASE = String.raw`([a-z][a-z'\-]+(?:\s+[a-z][a-z'\-]+){0,3})`;
const NP_BOUNDARY =
  String.raw`(?=\s+(?:doing|making|while|and|but|with|in|on|at|for|to|by|near|behind|under|over|beside|against|inside)\b|[.,!?;:]|$)`;

const ACTION_WITH_OBJECT_RX = new RegExp(
  String.raw`\b(holding|carrying|grasping|clutching|using|wielding|gripping|cradling|hugging|sipping|drinking|eating|reading|writing|painting|playing|strumming|riding|driving|petting|stroking|throwing|catching|kicking|chopping|cooking|stirring|pouring)\s+(?:a|an|the|some|her|his|my|two|three|four|five|several|a\s+few|a\s+couple\s+of|her\s+own|his\s+own|my\s+own)\s+` +
    NOUN_PHRASE +
    NP_BOUNDARY,
  "i",
);

const WITH_X_IN_HAND_RX = new RegExp(
  String.raw`\bwith\s+(?:a|an|the|some|her|his|my)\s+` +
    NOUN_PHRASE +
    String.raw`\s+in\s+(?:her|his|my|the|one|both)\s+hands?\b`,
  "i",
);

const POSING_WITH_RX = new RegExp(
  String.raw`\b(posing|stood|standing|seated|sitting|sat|kneeling|crouching|leaning|walking|jogging|running)\s+with\s+(?:a|an|the|some|her|his|my)\s+` +
    NOUN_PHRASE +
    NP_BOUNDARY,
  "i",
);

// "doing X" / "making X (gesture|sign|face)?" / "doing the X" — captures
// the gesture name. If X matches GESTURE_VOCAB it goes to pose.gesture;
// otherwise it goes to pose.action.
const DOING_GESTURE_RX = new RegExp(
  String.raw`\b(?:doing|making|throwing|flashing|holding\s+up|giving)\s+(?:a|an|the|her|his|my|two)\s+` +
    NOUN_PHRASE +
    String.raw`(?:\s+(?:gesture|sign|face|pose|hand))?` +
    NP_BOUNDARY,
  "i",
);

// NOTE: CAMERA_TARGET_RX and AT_PERSON_RX used to live here as part of
// the legacy grammar-based gate (May 2026 regex era). Both are deleted —
// the state-based pipeline (intentClassifier + subjectClassifier) does
// the routing now. "smiling at me" loses on subject=SELF;
// "waving at her" wins on subject=ASHLEY (her = Ashley convention);
// camera-target phrases just fall out as part of the parsed pose.

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
// NOTE: SECOND_PERSON_RX is gone — subjectClassifier owns the
// "is this clause about Ashley?" decision now.
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
  /(^\s*(now|and\s+now|also|but|same\s+but)\b|\b(try\s+again|same\s+again|again\s+please|do\s+(it|that)\s+again|one\s+more\s+time|run\s+(it|that)\s+again|same\s+(but|thing\s+but|image\s+but|picture\s+but|photo\s+but)|but\s+(wider|change|different|with)|change\s+(it|that|the)|make\s+(it|her|him|your|the)|edit\s+(it|that)|for\s+(this|that)\s+(photo|image|picture)|keep\s+(everything|the\s+rest)\s+but|different\s+(outfit|background|colour|color|hair|pose|setting|scene|location|expression)|add\s+(a|an|the|some)\s+|remove\s+(the|that|her|his)\s+|take\s+off\s+(the|her|his)\s+|put\s+on\s+(a|an|the|her|his)\s+|more\s+(blurry|sharp|wide|cinematic|dramatic|colourful)|less\s+(blurry|sharp|wide|cinematic|dramatic)|no\s+luck|didn'?t\s+work)\b)/i;
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
    /**
     * A camera-capturable action verb extracted from the user's text:
     * "holding", "waving", "pointing", "saluting", "carrying", "using", ...
     * Distinct from bodyPosition (sitting/standing/lying) — action implies
     * the subject is DOING something visible to a camera, which is the
     * action-based image-intent signal per Wren spec May 2026.
     */
    action?: string;
    /**
     * A specific named gesture: "peace sign", "thumbs up", "v sign",
     * "salute", "finger heart", etc. Set when the user says "doing X" /
     * "making X" / bare gesture noun. Strongest single signal that the
     * user wants an image — gestures only exist to be photographed.
     */
    gesture?: string;
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

  /**
   * User-explicit NEGATIVE constraints — single-word appearance/clothing
   * tokens the user said to drop ("no lavender", "no lavender at all",
   * "without lavender", "not lavender", "remove the X"). Diffusion models
   * cannot honour negation phrases at the prompt level, so we use this
   * list to STRIP matching clauses from profile.appearance + the carried
   * spec BEFORE the prompt is composed, rather than emitting "no lavender"
   * to the provider (which would summon lavender). Lower-cased, deduped.
   */
  negations: string[];

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

export function makeEmptySpec(rawUserText = ""): VisualSpec {
  return {
    rawUserText,
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
    negations: [],
    matchedTriggers: [],
  };
}

// ---------------------------------------------------------------------------
// Negation extraction — Wren May 2026 precedence contract.
//
// Diffusion models cannot honour "no X" / "without X" at the prompt level
// (the negation gets ignored and the token tends to summon X). So instead of
// passing negations to the provider, we extract them here and strip matching
// clauses from profile.appearance + the carried spec BEFORE the final prompt
// is composed. The final prompt only contains POSITIVE statements.
//
// Vocab is restricted to known appearance/clothing tokens so freeform user
// text like "no idea what you mean" doesn't accidentally negate "idea".
// ---------------------------------------------------------------------------
const NEGATION_VOCAB: string[] = [
  ...HAIR_COLOURS,
  ...HAIRSTYLES,
  ...SKIN_DESCRIPTORS,
];

// Colour-family expansion (Wren May 2026): when a user negates a colour, the
// neighbouring colours in the same family must also be excluded — otherwise
// "no lavender" still ends up with purple/violet undertones because diffusion
// treats those as adjacent. Keys are the explicit negation; values are the
// implicit-also-negated tokens. Symmetric — listing once per family is fine
// because we expand from any matched member to the whole family.
const COLOUR_FAMILIES: ReadonlyArray<readonly string[]> = [
  ["lavender", "purple", "violet", "lilac", "mauve", "plum", "magenta"],
  ["pink", "rose", "salmon", "coral"],
  ["blonde", "yellow", "golden", "honey blonde", "platinum blonde"],
  ["red", "ginger", "auburn", "copper", "strawberry blonde"],
  ["brown", "brunette", "chestnut", "chocolate", "espresso"],
  ["black", "jet black", "raven", "ebony"],
  ["grey", "gray", "silver", "white", "salt-and-pepper"],
  ["blue", "navy", "teal", "turquoise", "cyan"],
  ["green", "emerald", "olive", "forest"],
];

// "no <token>", "no <token> at all", "without <token>", "not <token>",
// "remove the <token>", "drop the <token>", "lose the <token>", "get rid of
// the <token>". Matches case-insensitively. We capture the token; the
// surrounding cue is the trigger.
function extractNegations(raw: string): string[] {
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const hits = new Set<string>();
  // Sort longest-first so multi-word vocab ("strawberry blonde", "jet black",
  // "messy bun") wins over its single-word prefix.
  const sortedVocab = [...NEGATION_VOCAB].sort((a, b) => b.length - a.length);
  for (const token of sortedVocab) {
    const tokenRx = token.includes(" ") || token.includes("-")
      ? token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : `\\b${token}\\b`;
    // Cue patterns: "no <T>", "no <T> at all", "without <T>", "not <T>",
    // "remove ... <T>", "drop ... <T>", "lose ... <T>", "get rid of ... <T>".
    const rx = new RegExp(
      `\\b(no|without|not|remove(?:\\s+the)?|drop(?:\\s+the)?|lose(?:\\s+the)?|get\\s+rid\\s+of(?:\\s+the)?)\\s+(?:any\\s+|all\\s+|the\\s+|that\\s+)?${tokenRx}\\b`,
      "i",
    );
    if (rx.test(lower)) hits.add(token);
  }
  // Colour-family expansion. If any matched negation falls in a colour
  // family, also negate every other member of that family. Wren spec:
  // "no lavender" must exclude purple/violet/lilac/mauve too — diffusion
  // treats family-adjacent colours as substitutes and leaks them in
  // otherwise. Restricted to vocab tokens we already know are matchable.
  // Expand to every family member regardless of NEGATION_VOCAB membership —
  // downstream consumers (scrubVibeForOverrides, composeAppearance) treat
  // each negation as a free-text token to strip, no vocab dependency. This
  // lets us negate adjacent shades like "mauve" / "magenta" that aren't
  // first-class HAIR_COLOURS but still leak into diffusion output.
  const expansion = new Set<string>();
  for (const hit of hits) {
    for (const family of COLOUR_FAMILIES) {
      if (family.includes(hit)) {
        for (const sibling of family) expansion.add(sibling);
      }
    }
  }
  for (const e of expansion) hits.add(e);
  return Array.from(hits);
}

export function extractVisualSpec(text: string): VisualSpec {
  const raw = (text ?? "").toString();
  const lower = raw.toLowerCase();
  const spec: VisualSpec = makeEmptySpec(raw);
  const matched = spec.matchedTriggers;

  if (!raw.trim()) return spec;

  // Negations — extracted FIRST so we can strip them from positive matches
  // below ("no lavender" must not also register lavender as the hair colour
  // when the same phrase contains the word "hair" elsewhere).
  spec.negations = extractNegations(raw);
  if (spec.negations.length > 0) {
    matched.push(`negations=${spec.negations.join(",")}`);
  }

  // Hair colour: "<colour> hair" / "hair <colour>" / "make ... hair <colour>"
  // / "<colour> ... hair". We only count a colour as a hair-colour when the
  // word "hair" appears in the same message, otherwise "blue jeans" would
  // wrongly become hair colour.
  if (/\bhair\b/i.test(raw)) {
    // Filter the vocab to exclude any token the user explicitly negated
    // this turn ("Black hair, no lavender at all" → must pick "black",
    // not "lavender" — longest-first matching otherwise grabs lavender).
    const negSet = new Set(spec.negations);
    const hairVocab = HAIR_COLOURS.filter((c) => !negSet.has(c));
    const colour = findFirstMatch(lower, hairVocab);
    if (colour) {
      spec.appearance.hairColour = colour;
      matched.push(`appearance.hairColour=${colour}`);
    }
    const styleVocab = HAIRSTYLES.filter((s) => !negSet.has(s));
    const style = findFirstMatch(lower, styleVocab);
    if (style) {
      spec.appearance.hairstyle = style;
      matched.push(`appearance.hairstyle=${style}`);
    }
  }

  // Skin tone — only count when paired with the word "skin" or "complexion"
  // to avoid "pale blue" / "darker shade" false positives.
  if (/\b(skin|complexion)\b/i.test(raw)) {
    const negSet = new Set(spec.negations);
    const skinVocab = SKIN_DESCRIPTORS.filter((s) => !negSet.has(s));
    const tone = findFirstMatch(lower, skinVocab);
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
  // Always extract clothing / accessory vocab when matched. The
  // intent + subject classifiers upstream handle disambiguation between
  // "i love this dress" (intent=MUTATION but subject=SELF → no-op) and
  // "red dress" (verbless-fragment MUTATION + ASHLEY default → render).
  // The old hasClothingCue gate (`wearing|dressed|in...`) used to live
  // here as a leak prevention; it caused bare fragments like "red
  // dress" / "an Amish hat" to be silently dropped under the new
  // pipeline. Removed.
  const clothingHits = findAllMatches(lower, CLOTHING_ITEMS);
  const accessoryHits = findAllMatches(lower, ACCESSORIES);
  if (clothingHits.length) {
    spec.clothing.items = clothingHits;
    matched.push(`clothing.items=[${clothingHits.join(",")}]`);
  }
  if (accessoryHits.length) {
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

  // Pose — bodyPosition (sitting / standing / lying / kneeling / ...)
  const pose = findFirstMatch(lower, POSE_VERBS);
  if (pose) {
    spec.pose.bodyPosition = pose;
    matched.push(`pose.bodyPosition=${pose}`);
  }

  // ---- Action-based extraction (Wren spec May 2026) ----
  // 1) "holding/carrying/using/... <object>" — capture verb as pose.action,
  //    object phrase as props.objects (additive, deduped against existing).
  const objectMatch = raw.match(ACTION_WITH_OBJECT_RX);
  if (objectMatch) {
    const verb = objectMatch[1]!.toLowerCase();
    const objectPhrase = objectMatch[2]!.trim().toLowerCase().replace(/\s+/g, " ");
    spec.pose.action = verb;
    matched.push(`pose.action=${verb}`);
    if (objectPhrase && !spec.props.objects.includes(objectPhrase)) {
      spec.props.objects = [...spec.props.objects, objectPhrase];
      matched.push(`props.objects+=${objectPhrase}`);
    }
  }
  // 2) "with <X> in (her|his|my|the) hand(s)" — same idea, just a different
  //    surface form. Implies pose.action="holding" if not already set.
  const inHandMatch = raw.match(WITH_X_IN_HAND_RX);
  if (inHandMatch) {
    const objectPhrase = inHandMatch[1]!.trim().toLowerCase().replace(/\s+/g, " ");
    if (!spec.pose.action) {
      spec.pose.action = "holding";
      matched.push("pose.action=holding (in-hand cue)");
    }
    if (objectPhrase && !spec.props.objects.includes(objectPhrase)) {
      spec.props.objects = [...spec.props.objects, objectPhrase];
      matched.push(`props.objects+=${objectPhrase}`);
    }
  }
  // 3) "sitting/standing/posing with <object>" — pose verb + object cue.
  //    Acceptance test: "sitting with a cup of coffee".
  const posingMatch = raw.match(POSING_WITH_RX);
  if (posingMatch) {
    const verb = posingMatch[1]!.toLowerCase();
    const objectPhrase = posingMatch[2]!.trim().toLowerCase().replace(/\s+/g, " ");
    if (!spec.pose.bodyPosition) {
      spec.pose.bodyPosition = verb;
      matched.push(`pose.bodyPosition=${verb} (posing-with cue)`);
    }
    if (!spec.pose.action) {
      spec.pose.action = verb;
      matched.push(`pose.action=${verb}`);
    }
    if (objectPhrase && !spec.props.objects.includes(objectPhrase)) {
      spec.props.objects = [...spec.props.objects, objectPhrase];
      matched.push(`props.objects+=${objectPhrase}`);
    }
  }
  // 4) "doing <X>" / "making <X> (sign|gesture)?" — capture gesture name.
  //    Prefer the GESTURE_VOCAB match over the captured tail so we
  //    canonicalise ("doing a peace sign you know" → gesture="peace sign").
  const doingMatch = raw.match(DOING_GESTURE_RX);
  if (doingMatch) {
    const tail = doingMatch[1]!.trim().toLowerCase();
    const vocabHit = findFirstMatch(tail, GESTURE_VOCAB) ?? findFirstMatch(lower, GESTURE_VOCAB);
    const gesture = vocabHit ?? tail;
    spec.pose.gesture = gesture;
    matched.push(`pose.gesture=${gesture}`);
  } else {
    // Bare gesture mention without "doing/making" — "throws a peace sign",
    // "flashes a v sign", "with a thumbs up" — also counts.
    const bareGesture = findFirstMatch(lower, GESTURE_VOCAB);
    if (bareGesture) {
      spec.pose.gesture = bareGesture;
      matched.push(`pose.gesture=${bareGesture}`);
    }
  }
  // 5) Bare performative verb (waving / pointing / winking / saluting / ...)
  //    — these are camera-worthy on their own.
  if (!spec.pose.action) {
    const performative = findFirstMatch(lower, PERFORMATIVE_VERBS);
    if (performative) {
      spec.pose.action = performative;
      matched.push(`pose.action=${performative} (performative)`);
    }
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

  // ---- Image-intent decision (Wren spec May 2026) ----
  //
  // Pipeline: intent → subject → diff → render.
  //
  //   1. Diagnostic suppression — "do you remember that selfie" is
  //      talking ABOUT a previous image, not requesting one. Hard no.
  //   2. classifyIntent: MUTATION vs DESCRIPTION. Default DESCRIPTION.
  //      Past tense, questions, copula+attribute, time markers all win
  //      DESCRIPTION. Bare gerund clauses, imperative verbs, follow-up
  //      cues, verbless visual fragments, and imagine/picture framings
  //      win MUTATION.
  //   3. classifySubject: ASHLEY only proceeds. SELF (talking about
  //      Wren) and THIRD_PARTY (about someone else) are no-ops even if
  //      intent is MUTATION.
  //   4. Mutation extraction + follow-up: imageIntent=true iff the
  //      parser captured a visible delta OR the turn is a follow-up
  //      that will merge with prior state downstream.
  //
  // The grammar-based gates that used to live here (performativeAccepted
  // / hasNarrativeSubject / hasDirectAddress / camera-target / discourse
  // adverbs / at-person tail) are gone. Intent + subject does the work.
  if (IMAGE_DIAGNOSTIC_SUPPRESS_RX.test(raw)) {
    spec.imageIntent = false;
    spec.intentReason =
      "diagnostic phrasing — talking ABOUT a previous image, not requesting one";
    return spec;
  }

  const intent = classifyIntent(raw);
  if (intent.intent === "DESCRIPTION") {
    spec.imageIntent = false;
    spec.intentReason = `intent=DESCRIPTION — ${intent.reason}`;
    return spec;
  }

  const subject = classifySubject(raw);
  if (subject.subject !== "ASHLEY") {
    spec.imageIntent = false;
    spec.intentReason = `intent=MUTATION but subject=${subject.subject} — ${subject.reason}`;
    return spec;
  }

  // Follow-up flag still needed downstream so the merge layer loads the
  // prior VisualSpec from history before applying this delta.
  if (FOLLOW_UP_PHRASES_RX.test(raw)) {
    spec.isFollowUp = true;
    spec.isRetryOrEdit = true;
  }

  // Wren May 2026 terminal-render contract — UNCONDITIONAL.
  //
  //   intent === MUTATION AND subject === ASHLEY AND diffNonEmpty(prev, next)
  //   → renderImage() MUST be called.
  //
  // Cold-turn diff: prev = empty spec, next = this spec with rawUserText
  // populated. By construction we are past the early `!raw.trim()` return
  // so rawUserText is non-empty — diff against the empty prior is
  // therefore non-empty by definition. Image gen is mandatory.
  //
  // Follow-up diff: handled downstream by mergeVisualSpecs in the
  // resolver path (loads prior VisualSpec from history, merges this
  // delta, computes the merged spec). The merge result feeds the same
  // marker pipeline.
  //
  // No visual-signal probe, no keyword filter, no interpretation layer.
  // If the classifiers say MUTATION + ASHLEY, we render. Period.
  spec.imageIntent = true;
  spec.intentReason = `intent=MUTATION subject=ASHLEY diffNonEmpty=true isFollowUp=${spec.isFollowUp} — ${intent.reason}`;
  return spec;
}

// ---------------------------------------------------------------------------
// Diff helpers — Wren May 2026 terminal-render contract
// ---------------------------------------------------------------------------
// `diffVisualSpec(prev, next)` returns the field-by-field changes (used by
// the chat route's "visual-intent: terminal render" log). `diffNonEmpty`
// is the boolean form. Cold-start (no prev) treats every populated field
// in next as a change vs the empty baseline — Wren's contract: if the
// user said anything visual under MUTATION+ASHLEY, that IS a non-empty
// diff against an empty world.

export interface VisualSpecDiff {
  appearance: Record<string, { from: unknown; to: unknown }>;
  clothing: Record<string, { from: unknown; to: unknown }>;
  environment: Record<string, { from: unknown; to: unknown }>;
  pose: Record<string, { from: unknown; to: unknown }>;
  props: Record<string, { from: unknown; to: unknown }>;
  style: Record<string, { from: unknown; to: unknown }>;
  framing: Record<string, { from: unknown; to: unknown }>;
  rawUserTextChanged: boolean;
}

function changedScalar(
  bucket: Record<string, { from: unknown; to: unknown }>,
  key: string,
  from: unknown,
  to: unknown,
): void {
  if ((from ?? null) !== (to ?? null)) bucket[key] = { from, to };
}

function changedArray(
  bucket: Record<string, { from: unknown; to: unknown }>,
  key: string,
  from: ReadonlyArray<string>,
  to: ReadonlyArray<string>,
): void {
  const fromKey = [...from].sort().join("|");
  const toKey = [...to].sort().join("|");
  if (fromKey !== toKey) bucket[key] = { from, to };
}

export function diffVisualSpec(
  prev: VisualSpec | null,
  next: VisualSpec,
): VisualSpecDiff {
  const empty: VisualSpec = makeEmptySpec();
  const p: VisualSpec = prev ?? empty;
  const d: VisualSpecDiff = {
    appearance: {},
    clothing: {},
    environment: {},
    pose: {},
    props: {},
    style: {},
    framing: {},
    rawUserTextChanged: (p.rawUserText ?? "") !== (next.rawUserText ?? ""),
  };
  changedScalar(d.appearance, "hairColour", p.appearance.hairColour, next.appearance.hairColour);
  changedScalar(d.appearance, "hairstyle", p.appearance.hairstyle, next.appearance.hairstyle);
  changedScalar(d.appearance, "skinTone", p.appearance.skinTone, next.appearance.skinTone);
  changedScalar(d.appearance, "expression", p.appearance.expression, next.appearance.expression);
  changedArray(d.clothing, "items", p.clothing.items, next.clothing.items);
  changedArray(d.clothing, "accessories", p.clothing.accessories, next.clothing.accessories);
  changedScalar(d.environment, "location", p.environment.location, next.environment.location);
  changedScalar(d.environment, "timeOfDay", p.environment.timeOfDay, next.environment.timeOfDay);
  changedScalar(d.environment, "weather", p.environment.weather, next.environment.weather);
  changedScalar(d.pose, "bodyPosition", p.pose.bodyPosition, next.pose.bodyPosition);
  changedScalar(d.pose, "action", p.pose.action, next.pose.action);
  changedScalar(d.pose, "gesture", p.pose.gesture, next.pose.gesture);
  changedArray(d.props, "vehicles", p.props.vehicles, next.props.vehicles);
  changedArray(d.props, "objects", p.props.objects, next.props.objects);
  changedScalar(d.style, "medium", p.style.medium, next.style.medium);
  changedScalar(d.style, "isArtworkRequest", p.style.isArtworkRequest, next.style.isArtworkRequest);
  changedScalar(d.framing, "shotType", p.framing.shotType, next.framing.shotType);
  return d;
}

export function diffNonEmpty(
  prev: VisualSpec | null,
  next: VisualSpec,
): boolean {
  const d = diffVisualSpec(prev, next);
  if (d.rawUserTextChanged && (next.rawUserText ?? "").trim().length > 0) {
    return true;
  }
  return (
    Object.keys(d.appearance).length > 0 ||
    Object.keys(d.clothing).length > 0 ||
    Object.keys(d.environment).length > 0 ||
    Object.keys(d.pose).length > 0 ||
    Object.keys(d.props).length > 0 ||
    Object.keys(d.style).length > 0 ||
    Object.keys(d.framing).length > 0
  );
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
    !!spec.pose.action ||
    !!spec.pose.gesture ||
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

/**
 * Compound-directive extractor (Wren May 2026, multi-line input).
 *
 * The single-pass extractor does category-by-category vocab matching across
 * the WHOLE message. That works for "ginger hair" but breaks the second a
 * user stacks directives in one turn:
 *
 *   Ginger hair, no lavender
 *   Black leather biker jacket
 *   Sat on a bar stool at a bar
 *
 * The single-pass parser will still capture *some* slots (hairColour=ginger,
 * negations=[lavender], clothing.items=[jacket], environment.location=bar,
 * pose.bodyPosition=sat), but the rich modifiers ("black leather biker",
 * "bar stool") only survive via the rawUserText "Original request:" line —
 * and that line is one sentence buried under structured slots, so diffusion
 * gives it less weight than a slot-named anchor.
 *
 * This compound pass:
 *   1. Splits the input on hard directive delimiters (newlines and sentence
 *      stops). Commas inside a directive stay (so "ginger hair, no lavender"
 *      stays as one fragment and the negation cue still binds to "lavender").
 *   2. Runs the single-pass extractor on each fragment in isolation, so each
 *      directive's slots are scored without the other directives' tokens
 *      crowding the vocab matchers.
 *   3. Merges per-fragment specs left-to-right via mergeVisualSpecs — that
 *      gives delta-wins for scalar slots (later directive overrides earlier
 *      for the same attribute, which is the right semantics if Wren writes
 *      "Ginger hair. Black hair.") and union for array slots (clothing
 *      items, accessories, props.objects, negations).
 *   4. Restores rawUserText to the FULL original message so the
 *      "Original request:" anchor in buildVisualDescription preserves every
 *      directive verbatim — no detail loss for diffusion to grip.
 *
 * Falls through to the single-pass extractor when the input is one fragment.
 */
export function extractVisualSpecCompound(text: string): VisualSpec {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return extractVisualSpec(text);
  // Split on newlines OR a period followed by whitespace/end. We do NOT
  // split on commas — many single directives contain "X, no Y" cues where
  // the negation needs to bind to its target inside one fragment.
  const fragments = trimmed
    .split(/\n+|\.\s+|\.$/)
    .map((d) => d.trim())
    .filter(Boolean);
  if (fragments.length <= 1) return extractVisualSpec(text);

  let merged: VisualSpec | null = null;
  for (const fragment of fragments) {
    const partial = extractVisualSpec(fragment);
    merged = merged ? mergeVisualSpecs(merged, partial) : partial;
  }
  if (!merged) return extractVisualSpec(text);
  // The merge layer's last-wins on rawUserText would erase earlier
  // directives. Restore the FULL original text so buildVisualDescription's
  // "Original request:" line — and all downstream regex probes that read
  // rawUserText (FEET_ONLY_RX, SEATED_LENGTHWISE_RX, FOLLOW_UP_PHRASES_RX,
  // SELFIE_RX) — see exactly what the user typed.
  merged.rawUserText = trimmed;
  return merged;
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

  // Wren May 2026: emit the user's directives VERBATIM as the leading
  // anchor of the description so diffusion sees the rich modifiers
  // ("black leather biker jacket", "bar stool at a bar") as primary
  // signal, not buried after generic structured slots ("wearing jacket",
  // "set in the bar"). The structured slots that follow are redundancy,
  // not the primary anchor.
  //
  // Per-directive scrubbing keeps each negation phrase localised and
  // stops cross-directive comma orphans (split first, scrub each, rejoin).
  const rawDirectives = (spec.rawUserText ?? "")
    .split(/\n+|\.\s+|\.$/)
    .map((d) => scrubNegationPhrases(d.trim(), spec.negations).trim())
    .filter((d) => d.length > 0);
  // Wren May 2026: sort directives so SCENE-bearing fragments lead and
  // appearance-bearing fragments trail. Diffusion latches hardest on the
  // first sentence inside the brief; if "Ginger hair" leads it crops to
  // a headshot regardless of the wider mode wrapper. Re-running the
  // single-pass extractor per fragment is cheap (vocab regex on ~10 words)
  // and lets us classify without duplicating slot logic.
  const directives = [...rawDirectives].sort((a, b) => {
    const sa = extractVisualSpec(a);
    const sb = extractVisualSpec(b);
    const sceneA =
      !!sa.environment.location ||
      !!sa.environment.timeOfDay ||
      !!sa.environment.weather ||
      !!sa.pose.bodyPosition ||
      !!sa.pose.action ||
      sa.clothing.items.length > 0 ||
      sa.clothing.accessories.length > 0 ||
      sa.props.objects.length > 0 ||
      sa.props.vehicles.length > 0;
    const sceneB =
      !!sb.environment.location ||
      !!sb.environment.timeOfDay ||
      !!sb.environment.weather ||
      !!sb.pose.bodyPosition ||
      !!sb.pose.action ||
      sb.clothing.items.length > 0 ||
      sb.clothing.accessories.length > 0 ||
      sb.props.objects.length > 0 ||
      sb.props.vehicles.length > 0;
    if (sceneA && !sceneB) return -1;
    if (!sceneA && sceneB) return 1;
    return 0;
  });
  if (directives.length > 0) {
    parts.push(`Visual brief: ${directives.join(". ")}.`);
  }

  if (spec.environment.location || spec.environment.timeOfDay || spec.environment.weather) {
    const env: string[] = [];
    if (spec.environment.location) env.push(`set ${prepFor(spec.environment.location)} ${spec.environment.location}`);
    if (spec.environment.timeOfDay) env.push(`at ${spec.environment.timeOfDay}`);
    if (spec.environment.weather) env.push(`with ${spec.environment.weather} weather`);
    parts.push(`Environment: ${env.join(", ")}.`);
  }

  if (spec.pose.bodyPosition || spec.pose.action || spec.pose.gesture) {
    const poseParts: string[] = [];
    if (spec.pose.bodyPosition) poseParts.push(spec.pose.bodyPosition);
    if (spec.pose.action && spec.pose.action !== spec.pose.bodyPosition) {
      poseParts.push(spec.pose.action);
    }
    if (spec.pose.gesture) poseParts.push(`doing a ${spec.pose.gesture}`);
    parts.push(`Pose: ${poseParts.join(", ")}.`);
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
  //
  // CRITICAL: scrub negation phrases from the raw text before echoing it.
  // Diffusion models cannot honour "no X" / "without X" — the negation gets
  // dropped and the token tends to summon X. So if the user said "Black hair,
  // no lavender at all" we strip "no lavender at all" out of the echoed line
  // entirely. The negated token is also stripped from the spec elsewhere
  // (composeAppearance prunes profile.appearance clauses), so the final
  // prompt contains positive statements only.
  const scrubbed = scrubNegationPhrases(spec.rawUserText, spec.negations);
  if (scrubbed.trim().length > 0) {
    parts.push(`Original request: ${scrubbed.trim()}`);
  }

  return parts.join(" ");
}

/**
 * Remove negation cue + token spans from the raw user text so the echoed
 * "Original request:" line never contains the negated token. Mirrors the cue
 * vocabulary used by extractNegations(). Also strips bare occurrences of the
 * negated token if it survives elsewhere in the sentence — diffusion treats
 * any mention as a positive cue regardless of surrounding negation.
 */
function scrubNegationPhrases(raw: string, negations: string[]): string {
  if (!raw) return "";
  if (!negations || negations.length === 0) return raw;
  let out = raw;
  // Sort longest-first so multi-word vocab matches before single-word
  // prefixes.
  const sorted = [...negations].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    const tokenRx = token.includes(" ") || token.includes("-")
      ? token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : `\\b${token}\\b`;
    // 1) Strip the cue + token span (matches extractNegations cues).
    const cueRx = new RegExp(
      `\\b(no|without|not|remove(?:\\s+the)?|drop(?:\\s+the)?|lose(?:\\s+the)?|get\\s+rid\\s+of(?:\\s+the)?)\\s+(?:any\\s+|all\\s+|the\\s+|that\\s+)?${tokenRx}(?:\\s+at\\s+all)?`,
      "gi",
    );
    out = out.replace(cueRx, "");
    // 2) Belt-and-braces: strip any bare surviving mentions of the token.
    const bareRx = new RegExp(tokenRx, "gi");
    out = out.replace(bareRx, "");
  }
  // Tidy whitespace and orphaned punctuation left behind by the removals.
  out = out
    .replace(/\s*,\s*,+/g, ", ")
    // Comma immediately before a sentence stop is the canonical artefact
    // of a stripped negation clause — e.g. "Ginger hair, no lavender." →
    // strip "no lavender" → "Ginger hair, ." Collapse the orphan.
    .replace(/,\s*([.;:])/g, "$1")
    .replace(/^\s*[,;:.\-]+\s*/g, "")
    .replace(/\s*[,;:\-]+\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return out;
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
      action: delta.pose.action ?? prior.pose.action,
      gesture: delta.pose.gesture ?? prior.pose.gesture,
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
    // Negations union — once the user said "no lavender" it stays no
    // lavender for the rest of the session unless they explicitly bring
    // it back ("lavender hair" in a later turn would re-set hairColour
    // via the positive extractor; the user-explicit positive then beats
    // the carried negation in composeAppearance).
    negations: unionStrings(prior.negations ?? [], delta.negations ?? []),
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
    negations: spec.negations,
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
      negations: Array.isArray(parsed.negations) ? parsed.negations : [],
      matchedTriggers: Array.isArray(parsed.matchedTriggers) ? parsed.matchedTriggers : [],
    };
    return { description, spec };
  } catch {
    return { description, spec: null };
  }
}

// ---------------------------------------------------------------------------
// composeAppearance — Wren May 2026 precedence contract.
//
// Resolves the final identity-anchor sentence for the image prompt with strict
// precedence:
//
//   USER_EXPLICIT     (spec.appearance.* set this turn or carried in vibe)
//     >  SESSION_MEMORY (carried via mergeVisualSpecs across turns)
//        >  DEFAULT_IDENTITY (profile.appearance string)
//
// Process:
//   1. Split profile.appearance by comma into clauses.
//   2. Drop any clause containing a negated token (spec.negations).
//   3. Replace per-slot clauses ("X hair", "Y skin", "Z expression") with the
//      user-explicit value when present in spec.appearance — HARD REPLACE,
//      not merge.
//   4. Append any user-explicit slots that profile.appearance didn't carry.
//
// This guarantees the diffusion model never receives contradictory clauses
// like "She has lavender hair." next to "Scene: ... black hair ...".
// ---------------------------------------------------------------------------
function splitTopLevelCommas(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      const trimmed = buf.trim();
      if (trimmed) out.push(trimmed);
      buf = "";
      continue;
    }
    buf += ch;
  }
  const tail = buf.trim();
  if (tail) out.push(tail);
  return out;
}

export function composeAppearance(
  profileAppearance: string | null | undefined,
  spec: VisualSpec | null | undefined,
): string {
  const profile = (profileAppearance ?? "").trim();
  const negations = new Set(
    (spec?.negations ?? []).map((s) => s.toLowerCase().trim()).filter(Boolean),
  );
  const userHair = spec?.appearance?.hairColour?.trim().toLowerCase();
  const userStyle = spec?.appearance?.hairstyle?.trim().toLowerCase();
  const userSkin = spec?.appearance?.skinTone?.trim().toLowerCase();
  const userExpr = spec?.appearance?.expression?.trim().toLowerCase();

  // If user explicitly set a slot, the carried negation for the same value
  // is moot — but if they negated a colour they did NOT replace, the
  // negation still prunes profile clauses.
  //
  // Paren-aware split: a naive `\s*,\s*` split breaks profiles like
  // "Lavender hair (long, wavy), pale skin" into ["Lavender hair (long",
  // "wavy)", "pale skin"] — the parenthetical comma is treated as a clause
  // boundary, fragments are scrubbed independently, and the output ends up
  // with an orphan ")". Track paren depth and only break on top-level
  // commas. Profiles never nest brackets so depth tracking is enough.
  const clauses = splitTopLevelCommas(profile);

  const out: string[] = [];
  let hairReplaced = false;
  let skinReplaced = false;
  let exprReplaced = false;

  for (const clause of clauses) {
    const lower = clause.toLowerCase();

    // Drop clauses that mention any negated token.
    let dropped = false;
    for (const tok of negations) {
      const rx = tok.includes(" ") || tok.includes("-")
        ? new RegExp(tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : new RegExp(`\\b${tok}\\b`, "i");
      if (rx.test(lower)) {
        dropped = true;
        break;
      }
    }
    if (dropped) continue;

    // Hair clause — replace whole clause with the user-explicit value if set.
    if (/\bhair\b/i.test(lower) && (userHair || userStyle)) {
      const parts: string[] = [];
      if (userStyle) parts.push(userStyle);
      if (userHair) parts.push(userHair);
      parts.push("hair");
      out.push(parts.join(" "));
      hairReplaced = true;
      continue;
    }

    // Skin clause.
    if (/\b(skin|complexion)\b/i.test(lower) && userSkin) {
      out.push(`${userSkin} skin`);
      skinReplaced = true;
      continue;
    }

    // Expression clause — rare in profile.appearance, but support it.
    if (/\b(expression|smile|smiling|frown|grin|smirk)\b/i.test(lower) && userExpr) {
      out.push(`${userExpr} expression`);
      exprReplaced = true;
      continue;
    }

    out.push(clause);
  }

  // Append user-explicit slots the profile didn't already carry.
  if ((userHair || userStyle) && !hairReplaced) {
    const parts: string[] = [];
    if (userStyle) parts.push(userStyle);
    if (userHair) parts.push(userHair);
    parts.push("hair");
    out.push(parts.join(" "));
  }
  if (userSkin && !skinReplaced) out.push(`${userSkin} skin`);
  if (userExpr && !exprReplaced) out.push(`${userExpr} expression`);

  return out.join(", ");
}

/**
 * Scrub the LLM-generated vibe text of any colour/style tokens that the user
 * has either explicitly overridden (their new value should be the only colour)
 * or explicitly negated. Required because Ashley's system prompt feeds the
 * LLM `What I look like: <profile.appearance>`, so the LLM happily writes
 * "selfie of Ashley with her lavender hair tied up" into the vibe — and a
 * downstream identity-anchor swap can't beat a model that sees "lavender" in
 * the scene description too. After scrubbing we re-anchor with the composed
 * appearance sentence in buildModePromptBlock.
 *
 * Tokens stripped:
 *   - Every token in spec.negations
 *   - The profile-default hair colour, when spec.appearance.hairColour is set
 *     (a different colour means the default has been replaced)
 *   - The profile-default skin tone, when spec.appearance.skinTone is set
 */
export function scrubVibeForOverrides(
  vibe: string,
  profileAppearance: string | null | undefined,
  spec: VisualSpec | null | undefined,
): string {
  if (!vibe) return "";
  const stripTokens = new Set<string>();
  for (const n of spec?.negations ?? []) {
    if (n) stripTokens.add(n.toLowerCase());
  }
  const profileLower = (profileAppearance ?? "").toLowerCase();
  const userHair = spec?.appearance?.hairColour?.toLowerCase();
  if (userHair) {
    for (const colour of HAIR_COLOURS) {
      if (colour === userHair) continue;
      const rx = colour.includes(" ") || colour.includes("-")
        ? new RegExp(colour.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
        : new RegExp(`\\b${colour}\\b`, "i");
      if (rx.test(profileLower)) stripTokens.add(colour);
    }
  }
  const userSkin = spec?.appearance?.skinTone?.toLowerCase();
  if (userSkin) {
    for (const tone of SKIN_DESCRIPTORS) {
      if (tone === userSkin) continue;
      const rx = new RegExp(`\\b${tone}\\b`, "i");
      if (rx.test(profileLower)) stripTokens.add(tone);
    }
  }
  if (stripTokens.size === 0) return vibe;

  let out = vibe;
  // Sort longest-first so multi-word tokens win over their prefix.
  const sorted = [...stripTokens].sort((a, b) => b.length - a.length);
  for (const token of sorted) {
    const tokenRx = token.includes(" ") || token.includes("-")
      ? token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      : `\\b${token}\\b`;
    // Strip "<token> hair" / "<token> skin" / "<token>-toned" first to avoid
    // leaving an orphan "hair" / "skin" word.
    out = out.replace(new RegExp(`${tokenRx}\\s+(hair|skin|complexion|locks|tresses|undertone|tones?)\\b`, "gi"), "");
    // Strip "<modifier>-<token>" / "<token>-<modifier>" compound forms.
    out = out.replace(new RegExp(`\\b\\w+[- ]${tokenRx}\\b`, "gi"), "");
    out = out.replace(new RegExp(`${tokenRx}[- ]\\w+\\b`, "gi"), "");
    // Bare token last.
    out = out.replace(new RegExp(tokenRx, "gi"), "");
  }
  // Tidy whitespace and orphaned punctuation.
  out = out
    .replace(/\s*,\s*,+/g, ", ")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return out;
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
