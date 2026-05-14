// =============================================================================
// Intent classifier — pure function, no side effects, no I/O.
//
// PRIMARY filter on the visual pipeline. Every user turn is one of:
//
//   MUTATION    → user is trying to change Ashley's visible state.
//                 The pipeline proceeds: subject → parse → mutate → diff →
//                 (maybe) render.
//   DESCRIPTION → user is narrating, recalling, observing, asking, or
//                 commenting. The pipeline stops here. No state change,
//                 no render.
//
// Default is DESCRIPTION. Under-render is always safer than rendering
// against narration ("you were smiling at me earlier" must not fire an
// image). The classifier is intentionally tolerant of false-negatives
// on MUTATION — those just mean the user has to be a little more
// explicit ("show me you waving") to get the render.
//
// Rules (Wren spec, locked May 2026):
//
// DESCRIPTION wins on ANY of:
//   - question form (`?` or aux-fronted: "is/are/was/were/do/did/...")
//   - past tense ("was waving", "were holding", "had been smiling")
//   - present perfect ("have been", "has been")
//   - past time marker (yesterday, earlier, before, the other day, ...)
//   - copula + attribute ("you look happy", "you seem tired",
//     "you are beautiful")
//
// MUTATION wins on ANY of (only checked after description rules fail):
//   - explicit render-framing verb aimed at Ashley
//     ("imagine you in a red dress", "picture you waving")
//   - explicit imperative verb (make / show / give / wear / hold /
//     put on / take off / add / remove / change / ...)
//   - bare gerund / present participle clause ("holding a frying pan",
//     "waving") — present-tense, no copula
//   - fragment with no finite verb ("blonde hair", "in a forest",
//     "red dress")
//   - follow-up cue ("now ...", "same but ...", "make it ...",
//     "change it to ...")
//
// Order of evaluation is important: description rules run first because
// "imagine yesterday you were waving" is recall framed as imagine — the
// past-tense/time-marker description signals must override the imagine
// MUTATION cue (Wren: "they override DESCRIPTION unless clearly
// past-tense/recall").
// =============================================================================

export type Intent = "MUTATION" | "DESCRIPTION";

export interface IntentClassification {
  intent: Intent;
  reason: string;
}

// ---- Description signals -------------------------------------------------

const QUESTION_END_RX = /\?\s*$/;
const QUESTION_AUX_FRONT_RX =
  /^\s*(is|are|was|were|do|does|did|have|has|had|will|would|could|should|can|may|might|shall|am)\b/i;

const PAST_TENSE_RX =
  /\b(was|were|had\s+been|have\s+been|has\s+been|used\s+to)\b/i;

// "I was waving", "she was holding" — copula + present participle.
const PAST_PROGRESSIVE_RX = /\b(was|were)\s+\w+ing\b/i;

const PAST_TIME_MARKER_RX =
  /\b(yesterday|earlier|before|previously|the\s+other\s+day|last\s+(night|week|month|year|time|year|summer|winter|spring|autumn)|moments?\s+ago|\d+\s+(minutes?|hours?|days?|weeks?|months?|years?)\s+ago|ago|once|when\s+(i|we|you|she|he|they)|back\s+then|in\s+the\s+past)\b/i;

// Copula + attribute / feeling — observation, not mutation.
// "you look happy", "you seem tired", "you are beautiful".
// Important: "you are wearing X" / "you are holding X" must NOT match —
// those have a present participle, which is a mutation pattern. So we
// only fire when the right-hand side is an attribute adjective, not a
// gerund/participle.
const COPULA_VERBS_RX =
  /\b(you|ashley)\s+(look|looks|looked|looking|seem|seems|seemed|seeming|feel|feels|felt|feeling|sound|sounds|sounded|sounding|appear|appears|appeared|appearing)\b/i;

const ATTRIBUTE_ADJECTIVES = [
  "beautiful",
  "happy",
  "sad",
  "tired",
  "gorgeous",
  "cute",
  "pretty",
  "lovely",
  "amazing",
  "stunning",
  "fine",
  "okay",
  "ok",
  "good",
  "great",
  "nice",
  "wonderful",
  "funny",
  "sweet",
  "kind",
  "smart",
  "clever",
  "annoying",
  "angry",
  "upset",
  "excited",
  "nervous",
  "calm",
  "relaxed",
  "stressed",
  "drunk",
  "sober",
  "hot",
  "cold",
  "weird",
  "strange",
  "hungry",
  "thirsty",
  "bored",
  "interesting",
  "boring",
  "quiet",
  "loud",
  "shy",
  "confident",
  "proud",
  "ashamed",
  "embarrassed",
  "worried",
  "scared",
  "brave",
  "young",
  "old",
];

const COPULA_ATTRIBUTE_RX = new RegExp(
  `\\b(you|ashley)\\s+(are|is|am|'re|'s|re|s)\\s+(so\\s+|really\\s+|very\\s+|quite\\s+|a\\s+bit\\s+|kinda\\s+)?(${ATTRIBUTE_ADJECTIVES.join("|")})\\b`,
  "i",
);

// ---- Mutation signals ----------------------------------------------------

// Render-framing verbs aimed at Ashley. These override the soft
// description heuristics — but past-tense/recall still wins because
// description rules are checked first.
const IMAGINE_FRAMING_RX =
  /\b(imagine|picture|visualise|visualize|envision)\s+(yourself|you|ashley)\b/i;

// Bare imagine cue at sentence start — "imagine a red dress",
// "picture standing on a beach". Treat as render-framing for Ashley by
// convention (no other subject mentioned).
const IMAGINE_BARE_RX = /^\s*(imagine|picture|visualise|visualize|envision)\b/i;

// Imperative verbs that explicitly request a visual change. Note "do"
// is intentionally OUT — it doubles as the question auxiliary
// ("do you like..."), and the gesture / pose parser handles the few
// "do a X" cases via the action route ("do a peace sign" → gesture).
const IMPERATIVE_VERBS_RX =
  /^\s*(make|show|give|wear|hold|put\s+on|take\s+off|add|remove|change|swap|switch|turn|set|render|generate|draw|paint|sketch|send|create)\b/i;

// "show me you / her / yourself" framing — explicit ask.
const SHOW_ME_RX =
  /\b(show|send|give|let)\s+(me|us)\b/i;

// Follow-up cues — partial deltas applied to the carried scene.
// "how about" is included as a casual ask framing ("how about you on a
// beach?") that should win MUTATION even when wrapped in a question.
const FOLLOW_UP_CUE_RX =
  /^\s*(now|same\s+but|but\s+with|but|also|and\s+now|except|only|just|make\s+it|change\s+it|swap\s+it|now\s+with|with|in\s+a|on\s+a|wearing|holding|sitting|standing|kneeling|lying|how\s+about|what\s+about)\b/i;

// Bare gerund / present participle clause — "holding a frying pan",
// "waving", "sitting on a car bonnet". Must NOT contain a finite verb
// or copula (those flip into past/copula territory and description
// wins via the earlier checks).
const BARE_GERUND_RX = /^\s*\w+ing\b/i;

const FINITE_VERB_RX =
  /\b(is|are|am|was|were|be|been|being|do|does|did|have|has|had|will|would|could|should|can|may|might|shall|'re|'s|'m|'ve|'d|'ll)\b/i;

// Visual content words — anchors that indicate a fragment is describing
// a scene/wardrobe/appearance change rather than a bare conversational
// utterance. Without at least one of these (or a preposition/article)
// "i love you" and "ok cool" would falsely fire as verbless-fragment
// MUTATION. The pipeline would still no-op them downstream (subject =
// SELF), but the cleaner thing is to never claim MUTATION on them.
const PLACE_PREPOSITION_RX =
  /\b(in|on|with|at|by|under|beside|near|behind|inside|outside|over|beneath|atop|next\s+to|in\s+front\s+of|on\s+top\s+of|underneath)\b/i;

const ARTICLE_OR_POSSESSIVE_NOUN_RX =
  /\b(a|an|the|your|my|her|his|their|our)\s+[a-z]+/i;

const VISUAL_HINT_WORDS = [
  // Colors
  "red", "blue", "green", "yellow", "black", "white", "pink", "purple",
  "orange", "brown", "grey", "gray", "ginger", "blonde", "blond",
  "brunette", "auburn", "silver", "gold", "golden", "navy", "tan",
  "beige", "cream", "ivory", "crimson", "scarlet", "teal", "turquoise",
  // Clothing
  "dress", "hat", "shirt", "pants", "trousers", "jeans", "shoes",
  "boots", "skirt", "suit", "jacket", "coat", "scarf", "gloves",
  "socks", "sweater", "jumper", "hoodie", "tshirt", "tee", "tie",
  "bikini", "swimsuit", "uniform", "robe", "gown", "cape", "cloak",
  "outfit", "dungarees", "kimono", "tutu", "scrubs",
  // Body parts
  "hair", "eyes", "face", "hands", "feet", "legs", "arms", "lips",
  "smile", "skin", "nose", "ears",
  // Locations
  "forest", "beach", "kitchen", "bedroom", "bathroom", "park", "city",
  "street", "home", "garden", "mountain", "ocean", "lake", "river",
  "desert", "field", "meadow", "cafe", "bar", "pub", "restaurant",
  "office", "library", "hospital", "school", "studio", "rooftop",
  "balcony", "porch", "bonnet", "bonnet",
  // Props
  "frying", "pan", "guitar", "cup", "coffee", "book", "phone", "camera",
  "umbrella", "knife", "fork", "spoon", "bottle", "glass", "wine",
  "beer", "pint", "tractor", "car", "bike", "motorbike", "skateboard",
];

const VISUAL_HINT_RX = new RegExp(
  `\\b(${VISUAL_HINT_WORDS.join("|")})\\b`,
  "i",
);

// Fragment with no finite verb — "blonde hair", "in a forest",
// "red dress", "on a beach". Short, descriptive, no verb. Must also
// contain at least one visual signal (preposition of place,
// article+noun, or a known visual hint word) so that bare conversation
// like "i love you" / "ok cool" / "thanks" falls through to DESCRIPTION.
// Public visual-signal probe — used by the visualSpec gate to enforce
// Wren's "diff non-empty" half of the terminal-render contract. An
// abstract MUTATION+ASHLEY ask like "show me your day" or "send me the
// link" has zero visual signal: the diff against the empty world is
// effectively empty and we must NOT render. Inputs that mention any
// visual hint word, place preposition, article+noun, or follow-up
// scene cue carry enough signal to pass the gate. Bare gerund clauses
// also pass — "playing connect four with cheese on your head" has the
// gerund + props.
// Words that end in "ing" but are nouns / non-actionable in our context.
// Used to filter the non-anchored gerund probe so "good morning" doesn't
// fire as a visual signal. Real action verbs ("waving", "holding",
// "playing", "balancing", "sitting", "lying") all pass.
const NON_VERB_GERUND_NOUNS = new Set([
  "morning",
  "evening",
  "ceiling",
  "feeling",
  "feelings",
  "meeting",
  "wedding",
  "string",
  "thing",
  "anything",
  "everything",
  "something",
  "nothing",
  "king",
  "ring",
  "sing",
  "thing",
  "wing",
  "bring",
  "during",
  "spring",
  "swing",
  "young",
  "long",
  "wrong",
  "song",
  "strong",
  "warning",
  "hearing",
  "tuning",
  "tooling",
  "logging",
]);

const NON_ANCHORED_GERUND_RX = /\b([a-z]{3,}ing)\b/gi;

function hasActionGerund(input: string): boolean {
  for (const match of input.toLowerCase().matchAll(NON_ANCHORED_GERUND_RX)) {
    const word = match[1] ?? "";
    if (word.length < 5) continue;
    if (NON_VERB_GERUND_NOUNS.has(word)) continue;
    return true;
  }
  return false;
}

export function hasVisualSignal(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  // Visual hint nouns (clothing, body parts, locations, props, colours).
  if (VISUAL_HINT_RX.test(trimmed)) return true;
  // Bare or non-anchored action gerund — "waving", "holding a paintbrush",
  // "playing connect four", "balancing cheese". Excludes nominal "ing"
  // words like "morning"/"feeling" via the blocklist above.
  if (BARE_GERUND_RX.test(trimmed) && !FINITE_VERB_RX.test(trimmed)) {
    return true;
  }
  if (hasActionGerund(trimmed)) return true;
  // Imagine framing always passes — "imagine you in a red dress" must render.
  if (IMAGINE_FRAMING_RX.test(trimmed) || IMAGINE_BARE_RX.test(trimmed)) {
    return true;
  }
  return false;
}

function isFragmentNoFiniteVerb(input: string): boolean {
  const tokens = input.trim().split(/\s+/);
  if (tokens.length === 0 || tokens.length > 12) return false;
  if (FINITE_VERB_RX.test(input)) return false;
  if (
    !PLACE_PREPOSITION_RX.test(input) &&
    !ARTICLE_OR_POSSESSIVE_NOUN_RX.test(input) &&
    !VISUAL_HINT_RX.test(input)
  ) {
    return false;
  }
  return /[a-z]/i.test(input);
}

// ---- Public entry --------------------------------------------------------

export function classifyIntent(rawInput: string): IntentClassification {
  const input = rawInput.trim();
  if (input.length === 0) {
    return { intent: "DESCRIPTION", reason: "empty input" };
  }

  // ----- DESCRIPTION rules (checked first) -----
  // Question form is DESCRIPTION UNLESS the clause also carries a clear
  // mutation cue (imperative verb, show-me framing, imagine framing, or
  // a follow-up cue). Wren writes casual asks like "Show me sitting on
  // the bonnet?" with a question mark — those are still requests.
  // Wren May 2026 hardening: bare gerund and verbless visual fragments must
  // also defeat the question-form rule. Casual asks like "playing connect
  // four with cheese on your head?" or "you in a red dress?" are render
  // requests, not narration.
  const hasMutationFraming =
    IMPERATIVE_VERBS_RX.test(input) ||
    SHOW_ME_RX.test(input) ||
    IMAGINE_FRAMING_RX.test(input) ||
    IMAGINE_BARE_RX.test(input) ||
    FOLLOW_UP_CUE_RX.test(input) ||
    (BARE_GERUND_RX.test(input) && !FINITE_VERB_RX.test(input)) ||
    isFragmentNoFiniteVerb(input);
  if (QUESTION_END_RX.test(input) && !hasMutationFraming) {
    return { intent: "DESCRIPTION", reason: "question form (trailing ?)" };
  }
  if (QUESTION_AUX_FRONT_RX.test(input) && !hasMutationFraming) {
    return {
      intent: "DESCRIPTION",
      reason: "question form (aux-fronted: is/are/was/were/...)",
    };
  }
  if (PAST_PROGRESSIVE_RX.test(input)) {
    return {
      intent: "DESCRIPTION",
      reason: "past progressive (was/were + ...ing) — narration",
    };
  }
  if (PAST_TENSE_RX.test(input)) {
    return {
      intent: "DESCRIPTION",
      reason: "past / present-perfect tense — narration or recall",
    };
  }
  if (PAST_TIME_MARKER_RX.test(input)) {
    return {
      intent: "DESCRIPTION",
      reason: "past time marker (yesterday/earlier/the other day/...)",
    };
  }
  if (COPULA_VERBS_RX.test(input) || COPULA_ATTRIBUTE_RX.test(input)) {
    return {
      intent: "DESCRIPTION",
      reason: "copula + attribute (you look/seem/are X) — observation",
    };
  }

  // ----- MUTATION rules -----
  if (IMAGINE_FRAMING_RX.test(input) || IMAGINE_BARE_RX.test(input)) {
    return {
      intent: "MUTATION",
      reason: "render-framing verb (imagine/picture/visualise) — explicit ask",
    };
  }
  if (IMPERATIVE_VERBS_RX.test(input)) {
    return {
      intent: "MUTATION",
      reason: "explicit imperative verb (make/show/wear/hold/...)",
    };
  }
  if (SHOW_ME_RX.test(input)) {
    return {
      intent: "MUTATION",
      reason: "show-me framing — explicit ask",
    };
  }
  if (FOLLOW_UP_CUE_RX.test(input)) {
    return {
      intent: "MUTATION",
      reason:
        "follow-up cue (now/same but/wearing/holding/...) — scene delta",
    };
  }
  if (BARE_GERUND_RX.test(input) && !FINITE_VERB_RX.test(input)) {
    return {
      intent: "MUTATION",
      reason: "bare gerund clause (holding/waving/sitting) — present action",
    };
  }
  if (isFragmentNoFiniteVerb(input)) {
    return {
      intent: "MUTATION",
      reason: "verbless fragment (blonde hair / in a forest / red dress)",
    };
  }

  // ----- Default -----
  return {
    intent: "DESCRIPTION",
    reason: "no positive mutation signal — defaulting to DESCRIPTION (safe)",
  };
}
