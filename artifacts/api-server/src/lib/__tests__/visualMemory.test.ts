import { describe, it, expect } from "vitest";
import {
  detectMissingFields,
  encodeMemoryIdInDescription,
  extractMemoryIdFromVibe,
  findVisualMemoryInText,
  formatMissingFieldsAsk,
  formatVisualMemoryDirective,
  getVisualMemory,
  UNKNOWN,
  type VisualMemoryAnchor,
} from "../visualMemory.js";
import { composeAppearance, extractVisualSpecCompound } from "../visualSpec.js";
import { synthesizeImageActionReplyFromSpec } from "../imageFollowUp.js";

const PROFILE = "Lavender hair (long, wavy), pale skin, hazel-green eyes";

describe("Visual Memory Anchor — pilot date_sofa_001", () => {
  it("seeded store contains date_sofa_001 with the screenshot values", () => {
    const m = getVisualMemory("date_sofa_001");
    expect(m).not.toBeNull();
    expect(m!.label).toBe("the sofa from our date");
    expect(m!.importance).toBe("high");
    const sofa = m!.objects.sofa;
    expect(sofa.color).toBe("dark brown almost black");
    expect(sofa.material).toBe("leather");
    expect(sofa.shape).toBe("two-seater rectangular");
    expect(String(sofa.armrests)).toContain("high armrests");
    expect(String(sofa.cushions)).toContain("comfy soft leather");
    const room = m!.objects.room;
    expect(String(room.lighting)).toContain("dimmed");
    expect(String(room.background)).toContain("stained-glass");
  });

  it("getVisualMemory returns null for unknown ids", () => {
    expect(getVisualMemory("nope_999")).toBeNull();
    expect(getVisualMemory("")).toBeNull();
    expect(getVisualMemory(null)).toBeNull();
  });
});

describe("findVisualMemoryInText — phrasing variants", () => {
  it.each([
    "recreate the sofa from our date",
    "Recreate the sofa from our date please",
    "use the sofa memory",
    "use the sofa memory please",
    "recreate date_sofa_001",
    "date_sofa_001",
    "the sofa from our date",
    "recreate the sofa memory",
  ])("matches: %s", (text) => {
    const m = findVisualMemoryInText(text);
    expect(m).not.toBeNull();
    expect(m!.memoryId).toBe("date_sofa_001");
  });

  it.each([
    "send a selfie",
    "send me a picture",
    "what are you wearing",
    "tell me about the sofa",
    "I bought a new sofa",
  ])("does NOT match: %s", (text) => {
    expect(findVisualMemoryInText(text)).toBeNull();
  });
});

describe("detectMissingFields", () => {
  it("returns empty for the seeded date_sofa_001 (all required fields populated)", () => {
    const m = getVisualMemory("date_sofa_001")!;
    expect(detectMissingFields(m)).toEqual([]);
  });

  it("flags UNKNOWN scalar fields with dotted paths", () => {
    const m: VisualMemoryAnchor = {
      memoryId: "test_001",
      type: "visual_scene_anchor",
      label: "test",
      importance: "low",
      objects: {
        sofa: {
          color: UNKNOWN,
          material: "leather",
          shape: UNKNOWN,
        },
      },
      usage: { allowedFor: ["scene_shot"], requiresExplicitRequest: true },
    };
    const missing = detectMissingFields(m);
    expect(missing).toContain("sofa.color");
    expect(missing).toContain("sofa.shape");
    expect(missing).not.toContain("sofa.material");
  });

  it("treats empty strings as missing", () => {
    const m: VisualMemoryAnchor = {
      memoryId: "test_002",
      type: "visual_scene_anchor",
      label: "test",
      importance: "low",
      objects: { sofa: { color: "", material: "  " } },
      usage: { allowedFor: ["scene_shot"], requiresExplicitRequest: true },
    };
    const missing = detectMissingFields(m);
    expect(missing).toContain("sofa.color");
    expect(missing).toContain("sofa.material");
  });
});

describe("formatVisualMemoryDirective", () => {
  it("emits a hard-constraint directive with all populated fields verbatim", () => {
    const m = getVisualMemory("date_sofa_001")!;
    const out = formatVisualMemoryDirective(m);
    expect(out).toContain("date_sofa_001");
    expect(out).toContain("the sofa from our date");
    expect(out.toLowerCase()).toContain("using these exact remembered details");
    expect(out.toLowerCase()).toContain("do not invent");
    expect(out).toContain("dark brown almost black");
    expect(out).toContain("leather");
    expect(out).toContain("two-seater rectangular");
    expect(out).toContain("high armrests");
    expect(out).toContain("comfy soft leather");
    expect(out).toContain("dimmed-down romantic lighting");
    expect(out).toContain("stained-glass");
    expect(out).toContain("blue and purple");
    // No emojis (Wren contract).
    expect(/[\p{Emoji_Presentation}]/u.test(out)).toBe(false);
  });

  it("skips UNKNOWN fields silently — never invents", () => {
    const m: VisualMemoryAnchor = {
      memoryId: "test_003",
      type: "visual_scene_anchor",
      label: "partial",
      importance: "medium",
      objects: { sofa: { color: "red", material: UNKNOWN, shape: UNKNOWN } },
      usage: { allowedFor: ["scene_shot"], requiresExplicitRequest: true },
    };
    const out = formatVisualMemoryDirective(m);
    expect(out).toContain("color: red");
    expect(out).not.toContain("UNKNOWN");
    expect(out).not.toContain("material:");
    expect(out).not.toContain("shape:");
  });
});

describe("formatMissingFieldsAsk", () => {
  it("acknowledges the memory and lists every gap, no fake certainty", () => {
    const m: VisualMemoryAnchor = {
      memoryId: "test_004",
      type: "visual_scene_anchor",
      label: "the sofa from our date",
      importance: "high",
      objects: { sofa: { color: UNKNOWN, material: UNKNOWN } },
      usage: { allowedFor: ["scene_shot"], requiresExplicitRequest: true },
    };
    const ask = formatMissingFieldsAsk(m, detectMissingFields(m));
    expect(ask).toContain("the sofa from our date");
    expect(ask).toContain("test_004");
    expect(ask.toLowerCase()).toContain("incomplete");
    expect(ask).toContain("- sofa color");
    expect(ask).toContain("- sofa material");
    // Must not pretend to render or describe the scene.
    expect(ask.toLowerCase()).not.toMatch(/\bi see\b|\bi remember\b/);
  });
});

describe("VMEM marker round-trip", () => {
  it("encode + extract recovers the memory id and strips the marker from the description", () => {
    const baseDesc = "Scene description here";
    const encoded = encodeMemoryIdInDescription(baseDesc, "date_sofa_001");
    expect(encoded).toContain("{{VMEM}}");
    expect(encoded).toContain("date_sofa_001");
    expect(encoded).toContain("{{/VMEM}}");
    const { description, memoryId } = extractMemoryIdFromVibe(encoded);
    expect(memoryId).toBe("date_sofa_001");
    expect(description).toBe(baseDesc);
  });

  it("extract on a marker-free vibe returns null memoryId and unchanged description", () => {
    const { description, memoryId } = extractMemoryIdFromVibe("just a normal vibe");
    expect(memoryId).toBeNull();
    expect(description).toBe("just a normal vibe");
  });

  it("encode sanitises memoryId — no injection of arbitrary characters", () => {
    const encoded = encodeMemoryIdInDescription("desc", "evil}}{{/VMEM}}{{VMEM}}other");
    const { memoryId } = extractMemoryIdFromVibe(encoded);
    // Sanitiser strips }} and {{ and / so the recovered id is the safe core.
    expect(memoryId).not.toContain("}}");
    expect(memoryId).not.toContain("{{");
    expect(memoryId).not.toContain("/");
  });
});

describe("synth pipeline carries the memory id through to selfieVibe", () => {
  it("synthesizeImageActionReplyFromSpec with memoryId injects VMEM marker", () => {
    const spec = extractVisualSpecCompound("recreate the sofa from our date");
    spec.imageIntent = true;
    const synth = synthesizeImageActionReplyFromSpec(spec, "recreate the sofa from our date", {
      memoryId: "date_sofa_001",
    });
    expect(synth).not.toBeNull();
    expect(synth!.selfieVibe).toContain("{{VMEM}}date_sofa_001{{/VMEM}}");
    // VSPEC marker still present alongside.
    expect(synth!.selfieVibe).toContain("{{VSPEC}}");
  });

  it("synthesizeImageActionReplyFromSpec WITHOUT memoryId does not inject VMEM", () => {
    const spec = extractVisualSpecCompound("send a selfie at the bar");
    spec.imageIntent = true;
    const synth = synthesizeImageActionReplyFromSpec(spec, "send a selfie at the bar");
    expect(synth).not.toBeNull();
    expect(synth!.selfieVibe).not.toContain("{{VMEM}}");
  });
});

describe("Visual memory anchor does NOT mutate Ashley's identity", () => {
  it("composeAppearance ignores the memory anchor entirely — profile stays lavender", () => {
    // The anchor flow is independent of composeAppearance. Even when an
    // anchor is being injected, profile.appearance must pass through to the
    // identity sentence unchanged unless a separate USER_EXPLICIT spec
    // override is also present.
    const before = PROFILE;
    // Simulate the call shape that generateAshleySelfie makes.
    const out = composeAppearance(PROFILE, null);
    expect(out.toLowerCase()).toContain("lavender hair");
    expect(out.toLowerCase()).not.toContain("blonde");
    expect(out.toLowerCase()).not.toContain("brown hair");
    expect(PROFILE).toBe(before);
  });
});

describe("Anchor request is request-scoped — next default selfie is unaffected", () => {
  it("memory match on call N does not appear in call N+1 (no spec, no anchor)", () => {
    // Call N: anchor request → spec carries memory id.
    const n = findVisualMemoryInText("recreate the sofa from our date");
    expect(n?.memoryId).toBe("date_sofa_001");
    // Call N+1: plain selfie → no anchor.
    const next = findVisualMemoryInText("send me a selfie");
    expect(next).toBeNull();
    // composeAppearance with no spec returns the unmodified profile both times.
    const a = composeAppearance(PROFILE, null);
    const c = composeAppearance(PROFILE, null);
    expect(a).toBe(c);
    expect(a.toLowerCase()).toContain("lavender hair");
  });
});
