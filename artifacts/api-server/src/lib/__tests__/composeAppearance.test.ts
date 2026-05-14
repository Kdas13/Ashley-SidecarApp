import { describe, expect, it } from "vitest";
import {
  buildVisualDescription,
  composeAppearance,
  encodeVibeWithSpec,
  extractVisualSpec,
  extractVisualSpecFromVibe,
  mergeVisualSpecs,
  scrubVibeForOverrides,
  extractVisualSpecCompound,
} from "../visualSpec.js";
import { synthesizeImageActionReplyFromSpec } from "../imageFollowUp.js";

describe("composeAppearance — Wren May 2026 precedence contract", () => {
  it("USER_EXPLICIT hair colour HARD REPLACES default identity hair colour", () => {
    const spec = extractVisualSpec("Black hair");
    const out = composeAppearance("lavender hair, pale skin", spec);
    expect(out.toLowerCase()).toContain("black hair");
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("acceptance: 'Black hair, no lavender at all' → black hair, zero lavender", () => {
    const spec = extractVisualSpec("Black hair, no lavender at all");
    expect(spec.appearance.hairColour).toBe("black");
    expect(spec.negations).toContain("lavender");

    const out = composeAppearance("lavender hair, pale skin, freckled cheeks", spec);
    expect(out.toLowerCase()).toContain("black hair");
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("negation alone STRIPS matching profile clauses even without a positive replacement", () => {
    const spec = extractVisualSpec("no lavender at all");
    expect(spec.negations).toContain("lavender");

    const out = composeAppearance("lavender hair, pale skin", spec);
    expect(out.toLowerCase()).not.toContain("lavender");
    expect(out.toLowerCase()).toContain("pale skin");
  });

  it("USER_EXPLICIT skin tone replaces profile skin clause", () => {
    const spec = extractVisualSpec("tanned skin");
    const out = composeAppearance("lavender hair, pale skin", spec);
    expect(out.toLowerCase()).toContain("tanned skin");
    expect(out.toLowerCase()).not.toContain("pale skin");
  });

  it("user-explicit slot the profile didn't have gets appended", () => {
    const spec = extractVisualSpec("ginger hair");
    const out = composeAppearance("pale skin", spec);
    expect(out.toLowerCase()).toContain("ginger hair");
    expect(out.toLowerCase()).toContain("pale skin");
  });

  it("no spec at all → returns profile.appearance unchanged", () => {
    const out = composeAppearance("lavender hair, pale skin", null);
    expect(out).toBe("lavender hair, pale skin");
  });

  it("empty profile + user-explicit hair → returns just the user-explicit value", () => {
    const spec = extractVisualSpec("Black hair");
    const out = composeAppearance("", spec);
    expect(out.toLowerCase()).toBe("black hair");
  });

  it("negations and overrides round-trip through encodeVibeWithSpec → extract", () => {
    const spec = extractVisualSpec("Black hair, no lavender at all");
    const encoded = encodeVibeWithSpec("description", spec);
    const { spec: rehydrated } = extractVisualSpecFromVibe(encoded);
    expect(rehydrated).not.toBeNull();
    expect(rehydrated!.appearance.hairColour).toBe("black");
    expect(rehydrated!.negations).toContain("lavender");

    const out = composeAppearance("lavender hair, pale skin", rehydrated);
    expect(out.toLowerCase()).toContain("black hair");
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("mergeVisualSpecs unions negations across turns", () => {
    const turn1 = extractVisualSpec("no lavender at all");
    const turn2 = extractVisualSpec("Black hair");
    const merged = mergeVisualSpecs(turn1, turn2);
    expect(merged.appearance.hairColour).toBe("black");
    expect(merged.negations).toContain("lavender");

    const out = composeAppearance("lavender hair, pale skin", merged);
    expect(out.toLowerCase()).toContain("black hair");
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("user-explicit override wins over a previously negated colour without crash", () => {
    const turn1 = extractVisualSpec("no black at all");
    const turn2 = extractVisualSpec("Black hair");
    const merged = mergeVisualSpecs(turn1, turn2);
    expect(merged.appearance.hairColour).toBe("black");
    const out = composeAppearance("lavender hair", merged);
    expect(out.toLowerCase()).toContain("black hair");
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("negation cue variants: 'without X', 'not X', 'remove the X', 'get rid of X'", () => {
    expect(extractVisualSpec("without lavender").negations).toContain("lavender");
    expect(extractVisualSpec("not lavender").negations).toContain("lavender");
    expect(extractVisualSpec("remove the lavender").negations).toContain("lavender");
    expect(extractVisualSpec("get rid of the lavender").negations).toContain("lavender");
  });

  it("'no idea' / 'no problem' / 'not really' do NOT register as negations (vocab-gated)", () => {
    expect(extractVisualSpec("no idea what you mean").negations).toEqual([]);
    expect(extractVisualSpec("no problem").negations).toEqual([]);
    expect(extractVisualSpec("not really").negations).toEqual([]);
  });

  it("buildVisualDescription scrubs negation phrases AND bare negated tokens from echoed text", () => {
    const spec = extractVisualSpec("Black hair, no lavender at all");
    const desc = buildVisualDescription(spec).toLowerCase();
    expect(desc).toContain("black hair");
    expect(desc).not.toContain("lavender");
    expect(desc).not.toContain("no lavender");
  });

  it("scrubVibeForOverrides strips the profile hair colour from LLM vibe when user overrode it", () => {
    const spec = extractVisualSpec("Black hair, no lavender at all");
    const llmVibe = "selfie of Ashley with her lavender hair tied up, smiling at the camera, lavender locks framing her face";
    const out = scrubVibeForOverrides(llmVibe, "lavender hair, pale skin", spec);
    expect(out.toLowerCase()).not.toContain("lavender");
    expect(out.toLowerCase()).toContain("smiling");
  });

  it("scrubVibeForOverrides strips the negated token even when no positive override is set", () => {
    const spec = extractVisualSpec("no lavender at all");
    const llmVibe = "Ashley with lavender hair, lavender highlights, pale skin";
    const out = scrubVibeForOverrides(llmVibe, "lavender hair", spec);
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("scrubVibeForOverrides leaves the vibe alone when there are no overrides or negations", () => {
    const spec = extractVisualSpec("a selfie please");
    const llmVibe = "Ashley with lavender hair, smiling";
    const out = scrubVibeForOverrides(llmVibe, "lavender hair", spec);
    expect(out).toBe(llmVibe);
  });

  it("scrubVibeForOverrides handles compound forms like 'lavender-tinted' and 'pale lavender'", () => {
    const spec = extractVisualSpec("Black hair");
    const llmVibe = "Ashley with lavender-tinted hair, pale lavender highlights, smiling";
    const out = scrubVibeForOverrides(llmVibe, "lavender hair", spec);
    expect(out.toLowerCase()).not.toContain("lavender");
  });

  it("compound: Wren canonical multi-directive input keeps every directive", () => {
    const input =
      "Ginger hair, no lavender. Black leather biker jacket. Sat on a bar stool at a bar.";
    const spec = extractVisualSpecCompound(input);
    expect(spec.imageIntent).toBe(true);
    expect(spec.appearance.hairColour).toBe("ginger");
    expect(spec.negations).toContain("lavender");
    expect(spec.clothing.items).toContain("jacket");
    expect(spec.environment.location).toBe("bar");
    expect(spec.pose.bodyPosition).toBe("sat");
    expect(spec.rawUserText).toBe(input);
  });

  it("compound: newline-separated directives are each parsed independently", () => {
    const input = "Ginger hair, no lavender\nBlack leather biker jacket\nSat on a bar stool at a bar";
    const spec = extractVisualSpecCompound(input);
    expect(spec.appearance.hairColour).toBe("ginger");
    expect(spec.negations).toContain("lavender");
    expect(spec.clothing.items).toContain("jacket");
    expect(spec.environment.location).toBe("bar");
    expect(spec.pose.bodyPosition).toBe("sat");
  });

  it("compound: later directive on the SAME slot wins (delta semantics)", () => {
    const spec = extractVisualSpecCompound("Ginger hair. Black hair.");
    expect(spec.appearance.hairColour).toBe("black");
  });

  it("compound: array slots union across directives (clothing items)", () => {
    const spec = extractVisualSpecCompound("Black leather jacket. White t-shirt.");
    expect(spec.clothing.items).toEqual(expect.arrayContaining(["jacket", "t-shirt"]));
  });

  it("compound: full original message survives in rawUserText for diffusion anchor", () => {
    const input = "Ginger hair, no lavender. Black leather biker jacket. Sat on a bar stool at a bar.";
    const spec = extractVisualSpecCompound(input);
    const desc = buildVisualDescription(spec);
    expect(desc.toLowerCase()).toContain("black leather biker jacket");
    expect(desc.toLowerCase()).toContain("bar stool");
  });

  it("compound: single-fragment input still falls through to single-pass extractor", () => {
    const spec = extractVisualSpecCompound("Black hair, no lavender at all");
    expect(spec.appearance.hairColour).toBe("black");
    expect(spec.negations).toContain("lavender");
  });

  it("acceptance e2e: synth marker description for the canonical case contains 'black hair' and zero 'lavender'", () => {
    // Mark spec as image-intent so the synth path triggers (the live route
    // sets this via the upstream classifier; we set it directly here so the
    // test pins the contract end-to-end without mocking the classifier).
    const spec = extractVisualSpec("Black hair, no lavender at all");
    spec.imageIntent = true;
    const synth = synthesizeImageActionReplyFromSpec(
      spec,
      "Black hair, no lavender at all",
    );
    expect(synth).not.toBeNull();
    const desc = synth!.description.toLowerCase();
    expect(desc).toContain("black hair");
    expect(desc).not.toContain("lavender");
    expect(desc).not.toContain("no lavender");
  });
});
