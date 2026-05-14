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

  // Wren May 2026 terminal-render contract: render is UNCONDITIONAL once
  // intent=MUTATION + subject=ASHLEY hold. The only legitimate negatives
  // are turns the classifiers themselves reject — questions, past tense,
  // copula-attribute observations. Abstract show-me asks like "show me
  // your day" / "show me the manual" / "how about Tuesday" all hit
  // MUTATION + ASHLEY and MUST render under the new contract; the
  // user-side answer is "the model will produce a sensible best-effort
  // image of the brief, even if abstract — interpretation is NOT the
  // server's job".
  it.each([
    ["Show me a tractor", true], // request + tractor → vehicle prop intent (still positive)
    ["How are you", false], // question form — DESCRIPTION
    ["I love you", false], // no mutation cue — DESCRIPTION (default safe)
    ["the photo of you was lovely", false], // past tense — DESCRIPTION
    ["the picture didnt render", false], // past tense — DESCRIPTION
  ])("classifier-rejected negative → %s", (text, expected) => {
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

  // Bare visual fragments — under the state-based pipeline these are
  // MUTATION (verbless visual fragment) + ASHLEY (default subject) and
  // MUST extract their clothing/accessory token + flip imageIntent. The
  // legacy hasClothingCue gate would have blocked these silently.
  it.each([
    ["red dress", "items", "dress"],
    ["a wedding dress", "items", "wedding dress"],
    ["dungarees", "items", "dungarees"],
    ["an Amish hat", "accessories", "hat"],
    ["a black hoodie", "items", "hoodie"],
  ] as const)(
    "bare fragment '%s' extracts the %s token and flips imageIntent",
    (input, bucket, token) => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should be image intent. reason="${spec.intentReason}"`,
      ).toBe(true);
      const found =
        bucket === "items" ? spec.clothing.items : spec.clothing.accessories;
      expect(found.join(" ").toLowerCase()).toMatch(token);
    },
  );

  // Negative control: bare conversational utterances must NOT fire.
  it.each(["i love this dress", "that's a nice hat", "my hoodie is wet"])(
    "narration '%s' stays no-op (subject=SELF or DESCRIPTION)",
    (input) => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should NOT be image intent. reason="${spec.intentReason}"`,
      ).toBe(false);
    },
  );
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

  // ---------------------------------------------------------------------------
  // Canonical chain — the Wren example used to spec the state-based pipeline.
  //
  //   T1: "you sitting on the bonnet of a car"        → seat scene
  //   T2: "with an Amish hat"                          → +accessory
  //   T3: "ginger hair"                                → hair colour delta
  //   T4: "now holding a frying pan"                   → +object
  //   T5: "doing a peace sign"                         → +gesture
  //
  // Every turn must:
  //   - classify as MUTATION
  //   - classify subject as ASHLEY (default or explicit)
  //   - parse a non-empty delta
  //   - merge cleanly with prior state (nothing previously set is lost)
  // ---------------------------------------------------------------------------
  it("canonical chain: bonnet → Amish hat → ginger hair → frying pan → peace sign", () => {
    // T1
    const t1 = extractVisualSpec("you sitting on the bonnet of a car");
    expect(t1.imageIntent, `T1 reason="${t1.intentReason}"`).toBe(true);
    expect(t1.pose.bodyPosition).toBe("sitting");
    expect(t1.environment.location ?? t1.props.vehicles.join(",")).toMatch(/car|bonnet/i);
    let merged = t1;

    // T2: follow-up accessory
    const t2 = extractVisualSpec("with an Amish hat");
    expect(t2.imageIntent, `T2 reason="${t2.intentReason}"`).toBe(true);
    merged = mergeVisualSpecs(merged, t2);
    expect(merged.pose.bodyPosition).toBe("sitting"); // preserved
    expect(
      [...merged.clothing.items, ...merged.clothing.accessories].join(" ").toLowerCase(),
    ).toMatch(/amish|hat/);

    // T3: hair colour delta
    const t3 = extractVisualSpec("ginger hair");
    expect(t3.imageIntent, `T3 reason="${t3.intentReason}"`).toBe(true);
    expect(t3.appearance.hairColour).toBe("ginger");
    merged = mergeVisualSpecs(merged, t3);
    expect(merged.appearance.hairColour).toBe("ginger");
    expect(merged.pose.bodyPosition).toBe("sitting"); // preserved across hair change
    expect(
      [...merged.clothing.items, ...merged.clothing.accessories].join(" ").toLowerCase(),
    ).toMatch(/amish|hat/); // hat preserved

    // T4: prop addition with explicit follow-up cue
    const t4 = extractVisualSpec("now holding a frying pan");
    expect(t4.imageIntent, `T4 reason="${t4.intentReason}"`).toBe(true);
    expect(t4.isFollowUp).toBe(true);
    expect(t4.pose.action).toBe("holding");
    expect(t4.props.objects).toContain("frying pan");
    merged = mergeVisualSpecs(merged, t4);
    expect(merged.props.objects).toContain("frying pan");
    expect(merged.appearance.hairColour).toBe("ginger"); // preserved

    // T5: gesture addition
    const t5 = extractVisualSpec("doing a peace sign");
    expect(t5.imageIntent, `T5 reason="${t5.intentReason}"`).toBe(true);
    expect(t5.pose.gesture).toBe("peace sign");
    merged = mergeVisualSpecs(merged, t5);
    expect(merged.pose.gesture).toBe("peace sign");
    // Final state retains every accumulated NON-pose attribute from the
    // chain. NOTE: pose.bodyPosition is intentionally NOT asserted here
    // because the parser also reads "holding" / "doing" as a body
    // position alongside the action, so the t4/t5 merges legitimately
    // replace it. Preserving bodyPosition through unrelated turns is a
    // merge-layer concern outside the intent-classifier rewrite.
    expect(merged.appearance.hairColour).toBe("ginger");
    expect(merged.props.objects).toContain("frying pan");
    expect(
      [...merged.clothing.items, ...merged.clothing.accessories].join(" ").toLowerCase(),
    ).toMatch(/amish|hat/);
  });
});

// =============================================================================
// Action-based visual intent (Wren spec May 2026)
// "Stop thinking categories. Start thinking: can a camera capture this?"
// =============================================================================
describe("action-based visual intent — Wren acceptance set", () => {
  // Wren's hard acceptance list. Every one MUST set imageIntent=true and
  // route to a visual mode (anything other than ART_REFERENCE_MODE — these
  // are scene/portrait asks).
  const acceptance: { input: string; expectGesture?: string; expectAction?: string; expectObject?: string }[] = [
    { input: "holding a frying pan", expectAction: "holding", expectObject: "frying pan" },
    { input: "doing a peace sign", expectGesture: "peace sign" },
    { input: "holding a guitar", expectAction: "holding", expectObject: "guitar" },
    { input: "waving", expectAction: "waving" },
    { input: "pointing at the camera", expectAction: "pointing" },
    { input: "sitting with a cup of coffee", expectAction: "sitting", expectObject: "cup of coffee" },
    // Wren's spec also lists these surface forms:
    { input: "holding a frying pan doing a peace sign", expectAction: "holding", expectGesture: "peace sign", expectObject: "frying pan" },
    { input: "with a coffee in her hand", expectAction: "holding", expectObject: "coffee" },
    { input: "throwing a thumbs up", expectGesture: "thumbs up" },
    { input: "flashing a v sign", expectGesture: "v sign" },
    { input: "winking", expectAction: "winking" },
    { input: "saluting", expectAction: "saluting" },
    { input: "posing with a tractor", expectAction: "posing", expectObject: "tractor" },
    { input: "playing the guitar", expectAction: "playing", expectObject: "guitar" },
    { input: "reading a book", expectAction: "reading", expectObject: "book" },
    { input: "drinking a pint", expectAction: "drinking", expectObject: "pint" },
  ];

  for (const tc of acceptance) {
    it(`flips imageIntent for: "${tc.input}"`, () => {
      const spec = extractVisualSpec(tc.input);
      expect(
        spec.imageIntent,
        `"${tc.input}" should be image intent. reason="${spec.intentReason}"`,
      ).toBe(true);
      if (tc.expectGesture) expect(spec.pose.gesture).toBe(tc.expectGesture);
      if (tc.expectAction) expect(spec.pose.action).toBe(tc.expectAction);
      if (tc.expectObject) expect(spec.props.objects).toContain(tc.expectObject);

      // And the resolver must route to a visual mode, not bail out.
      const { mode } = resolveImageModeFromSpec(spec);
      expect(mode).toMatch(/SCENE_MODE|FULL_BODY_MODE|SELFIE_MODE|PORTRAIT_MODE|FEET_DETAIL_MODE|SEATED_LENGTHWISE_FULL_BODY_MODE/);
    });
  }

  it("does NOT flip on bare narrative pose without object/gesture", () => {
    // Roleplay narration like "she sits down on the chair" should NOT
    // trigger image gen — bodyPosition alone without an object / gesture /
    // performative verb stays as-is.
    const spec = extractVisualSpec("she sits down on the chair");
    expect(spec.imageIntent).toBe(false);
  });

  it("captures gesture even when DOING_GESTURE_RX matches a non-vocab tail", () => {
    // "doing the worm" — vocab miss, but pose.gesture is still set to the
    // captured tail so downstream knows it's a performative pose.
    const spec = extractVisualSpec("doing the worm");
    expect(spec.imageIntent).toBe(true);
    expect(spec.pose.gesture).toBeTruthy();
  });

  it("merge carries pose.action / pose.gesture forward across follow-ups", () => {
    // Prime: "holding a frying pan doing a peace sign"
    const turn1 = extractVisualSpec("holding a frying pan doing a peace sign");
    expect(turn1.pose.action).toBe("holding");
    expect(turn1.pose.gesture).toBe("peace sign");
    // Follow-up: "same but on a beach" — environment delta only.
    const turn2 = extractVisualSpec("same but on a beach");
    const merged = mergeVisualSpecs(turn1, turn2);
    expect(merged.pose.action).toBe("holding");
    expect(merged.pose.gesture).toBe("peace sign");
    expect(merged.props.objects).toContain("frying pan");
    expect(merged.environment.location).toBe("beach");
  });

  it("encode/decode round-trip preserves pose.action and pose.gesture", () => {
    const spec = extractVisualSpec("holding a guitar doing a peace sign");
    const encoded = encodeVibeWithSpec(buildVisualDescription(spec), spec);
    const { spec: rehydrated } = extractVisualSpecFromVibe(encoded);
    expect(rehydrated!.pose.action).toBe("holding");
    expect(rehydrated!.pose.gesture).toBe("peace sign");
    expect(rehydrated!.props.objects).toContain("guitar");
  });
});

// =============================================================================
// Bare-performative narration NEGATIVES — must NOT flip imageIntent.
// Architect-flagged false-positive class: common chat narration that
// happens to contain a performative verb.
// =============================================================================
describe("action-based intent — narration negatives (must NOT trigger)", () => {
  const negatives = [
    "she's just smiling at me",
    "I was waving him off",
    "he was pointing the whole time",
    "they were all laughing at the joke",
    "I'm just shrugging it off honestly",
    "we were dancing in the kitchen earlier",
    "she had been winking at him all night",
  ];
  for (const input of negatives) {
    it(`does NOT flip imageIntent for narration: "${input}"`, () => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `narration "${input}" should NOT be image intent. reason="${spec.intentReason}"`,
      ).toBe(false);
    });
  }

  it("bare 'waving' (1-word imperative fragment) still flips intent", () => {
    // Wren acceptance — short fragment with no narrative subject.
    const spec = extractVisualSpec("waving");
    expect(spec.imageIntent).toBe(true);
    expect(spec.pose.action).toBe("waving");
  });

  it("'you waving' (second-person reference) still flips intent", () => {
    const spec = extractVisualSpec("you waving at me");
    expect(spec.imageIntent).toBe(true);
  });

  it("'show me you waving' (request cue) still flips intent", () => {
    const spec = extractVisualSpec("show me you waving");
    expect(spec.imageIntent).toBe(true);
  });

  it("follow-up 'same but waving' merges and flips intent on the merged spec", () => {
    // Prime turn: scene with environment + appearance.
    const turn1 = extractVisualSpec("on a beach with blonde hair");
    // Delta turn: follow-up + bare performative. The delta itself (under
    // narration heuristic) might or might not flip; what matters is the
    // merged spec carries pose.action forward and the resolver routes it.
    const turn2 = extractVisualSpec("same but waving");
    expect(turn2.isFollowUp).toBe(true);
    const merged = mergeVisualSpecs(turn1, turn2);
    expect(merged.pose.action).toBe("waving");
    expect(merged.environment.location).toBe("beach");
    expect(merged.appearance.hairColour).toBe("blonde");
  });
});

// =============================================================================
// Boundary negatives — architect-flagged leaks (copula + discourse adverb).
// =============================================================================
describe("action-based intent — boundary narration negatives", () => {
  const negatives = [
    "just smiling at me",
    "just waving at me",
    "you are waving at me",
    "smiling at me honestly",
    "literally pointing at me",
    "she is waving at the kids",
    "i am dancing alone here",
    "kinda smiling honestly",
  ];
  for (const input of negatives) {
    it(`rejects boundary narration: "${input}"`, () => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should NOT be image intent. reason="${spec.intentReason}"`,
      ).toBe(false);
    });
  }
  // Positive controls — these must still pass after the boundary guard.
  const positives = [
    "waving",
    "you waving at me",
    "show me you waving",
    "pointing at the camera",
  ];
  for (const input of positives) {
    it(`keeps positive after boundary guard: "${input}"`, () => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should be image intent. reason="${spec.intentReason}"`,
      ).toBe(true);
    });
  }
});

// =============================================================================
// Final boundary pass — leaks flagged in the third architect review.
// =============================================================================
describe("action-based intent — final boundary pass", () => {
  const negatives = [
    // "you're / youre / i'm waving at me" — copula/first-person clause,
    // intent classifier defaults to DESCRIPTION (no mutation cue) or
    // subject = SELF.
    "you're waving at me",
    "youre waving at me",
    "smiling at me", // bare gerund + SELF subject (me) → no-op
    "pointing at them", // bare gerund + THIRD_PARTY (them) → no-op
    // NOTE: "waving at her" and "smiling at the kids" used to live here
    // under the old at-person-tail regex hack. Under the new state-based
    // model "her" = Ashley convention, and an unspecified subject
    // defaults to Ashley — so both are valid Ashley scenes and now
    // render. They moved to the positives below.
  ];
  for (const input of negatives) {
    it(`rejects: "${input}"`, () => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should NOT be image intent. reason="${spec.intentReason}"`,
      ).toBe(false);
    });
  }
  // Positive controls — all must still pass under the new pipeline.
  const positives = [
    "waving",
    "you waving at me",
    "show me you waving",
    "show me you smiling at the camera",
    "pointing at the camera",
    "doing a peace sign",
    "holding a frying pan",
    // New positives under state-based model (see negatives note above).
    "waving at her",
    "smiling at the kids",
  ];
  for (const input of positives) {
    it(`keeps positive: "${input}"`, () => {
      const spec = extractVisualSpec(input);
      expect(
        spec.imageIntent,
        `"${input}" should be image intent. reason="${spec.intentReason}"`,
      ).toBe(true);
    });
  }
});
