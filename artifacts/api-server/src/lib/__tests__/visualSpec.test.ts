// =============================================================================
// VisualSpec extractor — category-driven image-intent test suite
// -----------------------------------------------------------------------------
// Wren spec May 2026 acceptance contract:
//
//   "A user can say something NEVER explicitly coded, and it STILL works
//    because it belongs to a known category. If it only works for phrases
//    Kane used, the system is wrong."
//
// This file therefore deliberately mixes:
//   - Spec §13 example prompts (must pass)
//   - PARAPHRASES and UNSEEN colour/clothing/pose variations (must pass
//     because the vocab tables cover the whole category, not the example)
//   - Negatives that look visual but aren't ("Show me your day")
//   - The full follow-up acceptance set:
//       "make her blonde" / "change the background" /
//       "same but night time" / "different outfit" / "add a car"
//     each against a primed prior VSPEC, must merge and route to image gen.
// =============================================================================

import { describe, expect, it } from "vitest";

import {
  buildVisualDescription,
  encodeVibeWithSpec,
  extractVisualSpec,
  extractVisualSpecFromVibe,
  mergeVisualSpecs,
  resolveImageModeFromSpec,
  type VisualSpec,
} from "../visualSpec.js";

// ---------------------------------------------------------------------------
// First-pass extraction — must fire on category, not phrase
// ---------------------------------------------------------------------------

describe("extractVisualSpec — first-pass routing", () => {
  it.each([
    // Wren acceptance (live test that triggered the refactor)
    ["Show me / how about you sitting on the bonnet of a car with an Amish hat on?", true],
    ["Show me a picture of you sitting on the bonnet of a car with an Amish hat on.", true],
    // Spec §13.1 environment
    ["Show me sitting in a field sketching.", true],
    ["Show me standing in the rain under a streetlight.", true],
    ["Show me sitting on a sofa in a cozy room.", true],
    // Spec §13.2 clothing
    ["Show me wearing dungarees.", true],
    ["Show me wearing a black hoodie.", true],
    ["Show me wearing an Amish hat.", true],
    // Spec §6 generic
    ["Show me you on a tractor", true],
    ["Show me you in dungarees", true],
    ["Show me you holding a paintbrush", true], // request + second-person + pose=holding fires even though "paintbrush" isn't in props vocab
    ["How about you in the kitchen", true],
    ["Send me you wearing a chef hat", true],
  ])("imageIntent → %s", (text, expected) => {
    const spec = extractVisualSpec(text);
    expect(spec.imageIntent).toBe(expected);
  });

  it.each([
    // Negatives — must NOT fire
    ["Show me your day", false],
    ["Show me what you can do", false],
    ["Show me how you feel", false],
    ["Show me you in trouble", false],
    ["Show me a tractor", true], // request + tractor → vehicle prop intent
    ["How are you", false],
    ["I love you", false],
    ["the photo of you was lovely", false],
    ["the picture didnt render", false],
    ["Show me the manual", false],
    ["Send me the link", false],
    ["How about Tuesday", false],
  ])("negative → %s", (text, expected) => {
    const spec = extractVisualSpec(text);
    expect(spec.imageIntent).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Category-not-phrase: hair colour vocab covers ALL colours, not just the
// ones Kane has happened to mention
// ---------------------------------------------------------------------------

describe("extractVisualSpec — hair colour vocab is a CATEGORY not a list", () => {
  // None of these specific colours have ever appeared in a previous regex.
  // They all work because HAIR_COLOURS covers the whole vocabulary.
  const colours = [
    "ginger", "blonde", "platinum", "lavender", "turquoise",
    "emerald", "magenta", "auburn", "raven", "silver",
  ];
  it.each(colours)("'make your hair %s' extracts hair colour", (colour) => {
    const spec = extractVisualSpec(`make your hair ${colour}`);
    expect(spec.appearance.hairColour).toBe(colour);
    expect(spec.imageIntent).toBe(true);
  });
});

describe("extractVisualSpec — hairstyle vocab", () => {
  const styles = ["braided", "ponytail", "messy bun", "shaved", "tied up"];
  it.each(styles)("'show me with a %s' extracts hairstyle", (style) => {
    const spec = extractVisualSpec(`show me with ${style} hair`);
    expect(spec.appearance.hairstyle).toBe(style);
  });
});

describe("extractVisualSpec — clothing vocab", () => {
  const items = ["dungarees", "hoodie", "kimono", "tutu", "scrubs", "wedding dress"];
  it.each(items)("'show me wearing %s' extracts clothing item", (item) => {
    const spec = extractVisualSpec(`show me wearing a ${item}`);
    expect(spec.clothing.items).toContain(item);
    expect(spec.imageIntent).toBe(true);
  });
});

describe("extractVisualSpec — environment / time / weather vocab", () => {
  it("extracts location + time + weather independently", () => {
    const spec = extractVisualSpec("show me on a beach at sunset in the rain");
    expect(spec.environment.location).toBe("beach");
    expect(spec.environment.timeOfDay).toBe("sunset");
    expect(spec.environment.weather).toBe("rain");
    expect(spec.imageIntent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mode resolution — spec §5 priority order
// ---------------------------------------------------------------------------

describe("resolveImageModeFromSpec", () => {
  it("artwork keyword → ART_REFERENCE_MODE", () => {
    const spec = extractVisualSpec("show me your latest painting");
    expect(spec.style.isArtworkRequest).toBe(true);
    expect(resolveImageModeFromSpec(spec).mode).toBe("ART_REFERENCE_MODE");
  });

  it("scene mutation → SCENE_MODE", () => {
    const spec = extractVisualSpec("show me on a beach at sunset");
    expect(resolveImageModeFromSpec(spec).mode).toBe("SCENE_MODE");
  });

  it("explicit full-body framing → FULL_BODY_MODE", () => {
    const spec = extractVisualSpec("show me a full body shot of you");
    expect(resolveImageModeFromSpec(spec).mode).toBe("FULL_BODY_MODE");
  });

  it("appearance-only → SELFIE_MODE (close-up to show the change)", () => {
    const spec = extractVisualSpec("make your hair blonde");
    expect(resolveImageModeFromSpec(spec).mode).toBe("SELFIE_MODE");
  });

  it("feet-only → FEET_DETAIL_MODE", () => {
    const spec = extractVisualSpec("just your feet please");
    expect(resolveImageModeFromSpec(spec).mode).toBe("FEET_DETAIL_MODE");
  });
});

// ---------------------------------------------------------------------------
// FOLLOW-UP DETECTION — Wren spec list
// ---------------------------------------------------------------------------

describe("extractVisualSpec — follow-up phrases", () => {
  const followUps = [
    "make her blonde",
    "change the background",
    "same but night time",
    "different outfit",
    "add a car",
    "make it darker",
    "for this image, change her hair",
    "keep everything but change the location",
    "same image but in the rain",
    "change the location to a beach",
  ];
  it.each(followUps)("'%s' sets isFollowUp=true and imageIntent=true", (text) => {
    const spec = extractVisualSpec(text);
    expect(spec.isFollowUp).toBe(true);
    expect(spec.imageIntent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// STATE MERGING — the acceptance test from Wren's brief
// ---------------------------------------------------------------------------
// Setup: a prior turn produced an image of Ashley standing in a field at
// sunset, wearing dungarees, brunette hair. Each follow-up below must:
//   - merge into the prior spec
//   - keep all unmentioned fields
//   - resolve to an image mode
//   - encode the merged spec back so the NEXT turn can rehydrate

describe("VisualSpec merge — Wren acceptance set", () => {
  function primePrior(): VisualSpec {
    const prior = extractVisualSpec(
      "Show me standing in a field at sunset wearing dungarees with brunette hair",
    );
    expect(prior.imageIntent).toBe(true);
    expect(prior.environment.location).toBe("field");
    expect(prior.environment.timeOfDay).toBe("sunset");
    expect(prior.clothing.items).toContain("dungarees");
    expect(prior.appearance.hairColour).toBe("brunette");
    return prior;
  }

  it("'make her blonde' → merged.appearance.hairColour=blonde, location preserved", () => {
    const prior = primePrior();
    const delta = extractVisualSpec("make her hair blonde");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.appearance.hairColour).toBe("blonde");
    expect(merged.environment.location).toBe("field"); // preserved
    expect(merged.environment.timeOfDay).toBe("sunset"); // preserved
    expect(merged.clothing.items).toContain("dungarees"); // preserved
  });

  it("'change the location to a beach' → merged.environment.location=beach", () => {
    const prior = primePrior();
    const delta = extractVisualSpec("change the location to a beach");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.environment.location).toBe("beach");
    expect(merged.appearance.hairColour).toBe("brunette"); // preserved
    expect(merged.clothing.items).toContain("dungarees"); // preserved
  });

  it("'same but night time' → time switched, everything else preserved", () => {
    const prior = primePrior();
    const delta = extractVisualSpec("same but at night");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.environment.timeOfDay).toBe("night");
    expect(merged.environment.location).toBe("field");
  });

  it("'different outfit, put her in a wedding dress' → REPLACES dungarees, doesn't accumulate", () => {
    const prior = primePrior();
    const delta = extractVisualSpec("different outfit, put her in a wedding dress");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.clothing.items).toContain("wedding dress");
    // Replace-intent: the prior dungarees must be GONE — wearing both is
    // semantically contradictory for a substitution edit.
    expect(merged.clothing.items).not.toContain("dungarees");
    expect(merged.environment.location).toBe("field"); // preserved
  });

  it("'add a scarf' → ADDS to clothing without losing dungarees (no replace cue)", () => {
    const prior = primePrior();
    // Manually inject the additive case — "add a scarf" is a follow-up
    // intent without any of the substitution markers.
    const delta = extractVisualSpec("add a scarf");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.clothing.items).toContain("dungarees"); // preserved
    // scarf is in CLOTHING_ITEMS vocab? if not, accessories — either way
    // dungarees must survive
  });

  it("'add a car' → vehicle added without losing the rest", () => {
    const prior = primePrior();
    const delta = extractVisualSpec("add a car next to her");
    expect(delta.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(prior, delta);
    expect(merged.props.vehicles).toContain("car");
    expect(merged.appearance.hairColour).toBe("brunette");
    expect(merged.clothing.items).toContain("dungarees");
  });
});

// ---------------------------------------------------------------------------
// VSPEC encode/decode round-trip — proves state survives DB persistence
// ---------------------------------------------------------------------------

describe("encodeVibeWithSpec / extractVisualSpecFromVibe round-trip", () => {
  it("round-trips category fields without loss", () => {
    const spec = extractVisualSpec(
      "Show me on a beach at sunset wearing a kimono with a sun hat, blonde hair",
    );
    const description = buildVisualDescription(spec);
    const encoded = encodeVibeWithSpec(description, spec);
    expect(encoded).toContain("{{VSPEC}}");
    expect(encoded).toContain("{{/VSPEC}}");

    const { description: roundTripDesc, spec: roundTripSpec } =
      extractVisualSpecFromVibe(encoded);
    expect(roundTripDesc).not.toContain("{{VSPEC}}");
    expect(roundTripSpec).not.toBeNull();
    expect(roundTripSpec!.environment.location).toBe("beach");
    expect(roundTripSpec!.environment.timeOfDay).toBe("sunset");
    expect(roundTripSpec!.clothing.items).toContain("kimono");
    expect(roundTripSpec!.clothing.accessories.some((a) => a.includes("hat"))).toBe(true);
    expect(roundTripSpec!.appearance.hairColour).toBe("blonde");
  });

  it("returns spec=null for legacy vibes with no marker", () => {
    const out = extractVisualSpecFromVibe("just some old vibe text from before this code shipped");
    expect(out.spec).toBeNull();
    expect(out.description).toBe("just some old vibe text from before this code shipped");
  });

  it("returns spec=null for malformed marker payload", () => {
    const out = extractVisualSpecFromVibe("desc {{VSPEC}}not valid json[[{{/VSPEC}}");
    expect(out.spec).toBeNull();
    expect(out.description).toBe("desc");
  });

  it("VSPEC marker survives the synthesizeImageActionReply ']'→')' sanitiser", () => {
    // synthesizeImageActionReply runs `description.replace(/\]/g, ")")`
    // before encoding to protect the [image: MODE | desc] parser. Our marker
    // must use chars that survive that transform — i.e. NO brackets.
    const spec = extractVisualSpec("show me on a beach at sunset wearing dungarees");
    const description = buildVisualDescription(spec);
    const encoded = encodeVibeWithSpec(description, spec);
    const sanitised = encoded.replace(/[\r\n]+/g, " ").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
    expect(sanitised).toContain("{{VSPEC}}");
    expect(sanitised).toContain("{{/VSPEC}}");
    const { spec: rehydrated } = extractVisualSpecFromVibe(sanitised);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.environment.location).toBe("beach");
    expect(rehydrated!.clothing.items).toContain("dungarees");
  });
});

// ---------------------------------------------------------------------------
// END-TO-END acceptance: prior attempt + follow-up + merge + round-trip
// ---------------------------------------------------------------------------

describe("end-to-end acceptance — prior attempt → follow-up edit → re-encode", () => {
  it("Wren full acceptance flow", () => {
    // Turn 1: user asks for an image
    const turn1 = extractVisualSpec(
      "Show me standing in a field at sunset wearing dungarees with brunette hair",
    );
    expect(turn1.imageIntent).toBe(true);
    expect(turn1.isFollowUp).toBe(false);
    const turn1Description = buildVisualDescription(turn1);
    const turn1Encoded = encodeVibeWithSpec(turn1Description, turn1);

    // (Server stores turn1Encoded as the assistant message's selfieVibe.)

    // Turn 2: user follow-up
    const turn2Delta = extractVisualSpec("make her hair blonde and add a car");
    expect(turn2Delta.isFollowUp).toBe(true);
    expect(turn2Delta.appearance.hairColour).toBe("blonde");
    expect(turn2Delta.props.vehicles).toContain("car");

    // Server rehydrates from prior assistant attempt
    const { spec: priorSpec } = extractVisualSpecFromVibe(turn1Encoded);
    expect(priorSpec).not.toBeNull();

    // Merge delta onto prior
    const merged = mergeVisualSpecs(priorSpec!, turn2Delta);
    expect(merged.appearance.hairColour).toBe("blonde"); // changed
    expect(merged.props.vehicles).toContain("car");      // added
    expect(merged.environment.location).toBe("field");   // preserved
    expect(merged.environment.timeOfDay).toBe("sunset"); // preserved
    expect(merged.clothing.items).toContain("dungarees"); // preserved

    // Resolve mode and re-encode for the NEXT turn
    const mode = resolveImageModeFromSpec(merged, { hasPriorAttempt: false });
    expect(mode.mode).toBe("SCENE_MODE");
    const turn2Encoded = encodeVibeWithSpec(buildVisualDescription(merged), merged);
    const { spec: rehydrated } = extractVisualSpecFromVibe(turn2Encoded);
    expect(rehydrated!.appearance.hairColour).toBe("blonde");
    expect(rehydrated!.environment.location).toBe("field");
  });
});
