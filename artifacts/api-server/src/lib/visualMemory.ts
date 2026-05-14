// ---------------------------------------------------------------------------
// Visual Memory Anchors — Wren May 2026 spec.
//
// A visual memory anchor is a STRUCTURED scene memory that Ashley can recall
// on explicit request and use to drive image generation. It is NOT general
// memory guessing, NOT a profile mutation, and NOT something the LLM is
// allowed to invent details for. Every field is either a concrete string or
// the literal sentinel "UNKNOWN" — when the user asks Ashley to recreate an
// anchor that has UNKNOWN fields, Ashley MUST say so and ask Kane to fill
// them in, never fake certainty.
//
// Pilot scope: one anchor (`date_sofa_001`), populated from the in-app
// "memory drawer" screenshot Wren attached. The store is an in-process
// module-level constant — fine for single-user pilot, swap for a typed JSON
// file or DB table when a second anchor (or a second user) shows up.
//
// Wire-up:
//   1. /chat detects a memory request via `findVisualMemoryInText` BEFORE
//      the generic image-intent gate fires.
//   2. If the matched anchor has UNKNOWN fields → return a clarifying
//      assistant message; do NOT generate an image.
//   3. Otherwise, synthesise the [image: MODE | desc] marker as usual but
//      embed `{{VMEM}}<memoryId>{{/VMEM}}` in the description so
//      /chat/selfie can re-resolve the anchor at render time and pass a
//      `sceneAnchor` directive into buildModePromptBlock.
//   4. The anchor never touches profile.appearance — composeAppearance still
//      sees the unmodified profile string. Identity stays lavender; only
//      this one selfie carries the sofa-room scene description.
// ---------------------------------------------------------------------------

export const UNKNOWN = "UNKNOWN" as const;

export type VisualFieldValue = string | string[] | typeof UNKNOWN;

export type VisualMemoryObjectFields = Record<string, VisualFieldValue>;

export type VisualMemoryAnchor = {
  memoryId: string;
  type: "visual_scene_anchor";
  label: string;
  importance: "low" | "medium" | "high";
  objects: Record<string, VisualMemoryObjectFields>;
  emotionalContext?: string;
  usage: {
    allowedFor: string[];
    requiresExplicitRequest: boolean;
  };
};

// ---------------------------------------------------------------------------
// Pilot store. date_sofa_001 is populated from the screenshot Wren attached
// (in-app "memory drawer" entry he wrote himself). Fields he didn't supply
// stay UNKNOWN so the missing-fields path exercises against real gaps.
// ---------------------------------------------------------------------------

const STORE: Record<string, VisualMemoryAnchor> = {
  date_sofa_001: {
    memoryId: "date_sofa_001",
    type: "visual_scene_anchor",
    label: "the sofa from our date",
    importance: "high",
    objects: {
      sofa: {
        color: "dark brown almost black",
        material: "leather",
        shape: "two-seater rectangular",
        armrests: "high armrests, the same level as the back of the sofa",
        cushions: "comfy soft leather",
        distinctive_features: [],
      },
      room: {
        lighting: "dimmed-down romantic lighting",
        background:
          "seats facing a large old stained-glass window with deep blue and purple shades; a lamp on a table behind the sofa",
        nearby_objects: [
          "table behind the sofa with a lamp on it",
          "stained-glass window directly in front of the seats",
        ],
        weather:
          "lots of moonlight outside shining through the blue and purple window panes; raining outside",
      },
    },
    emotionalContext: "Ashley waiting for Kane to come back",
    usage: {
      allowedFor: ["scene_shot", "image_generation"],
      requiresExplicitRequest: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Natural-language triggers per anchor. Kept as a separate map (not on the
// anchor itself) so the data structure stays JSON-portable for a future
// file/table backing store. Every regex is anchored loosely so phrasing
// variations ("the sofa from our date", "recreate the sofa from our date",
// "use the sofa memory") all match.
// ---------------------------------------------------------------------------

const TRIGGERS: Record<string, RegExp[]> = {
  date_sofa_001: [
    /\bdate[_\s-]?sofa[_\s-]?001\b/i,
    /\b(?:the\s+)?sofa\s+from\s+(?:our|the|that)\s+date\b/i,
    /\buse\s+(?:the\s+)?sofa\s+memory\b/i,
    /\brecreate\s+(?:the\s+)?sofa\s+memory\b/i,
    /\brecreate\s+(?:the\s+)?sofa\s+from\s+(?:our|the|that)\s+date\b/i,
    /\bsofa\s+memory\b/i,
  ],
};

// ---------------------------------------------------------------------------
// Lookup helpers.
// ---------------------------------------------------------------------------

export function getVisualMemory(memoryId: string | null | undefined): VisualMemoryAnchor | null {
  if (!memoryId) return null;
  return STORE[memoryId] ?? null;
}

export function findVisualMemoryInText(text: string | null | undefined): VisualMemoryAnchor | null {
  const t = (text ?? "").toString();
  if (!t.trim()) return null;
  for (const [memoryId, patterns] of Object.entries(TRIGGERS)) {
    for (const rx of patterns) {
      if (rx.test(t)) return STORE[memoryId] ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Missing-field detection. Returns dotted paths ("sofa.color", "room.lighting")
// for every field whose value is UNKNOWN, an empty string, or an empty array.
// Empty arrays for *_features / nearby_objects fields are treated as MISSING
// only when the entire memory has no concrete content elsewhere — Wren's
// pilot anchor has empty distinctive_features but rich room fields, so we
// don't want to block on cosmetic emptiness. Strict UNKNOWN scalar fields
// always count.
// ---------------------------------------------------------------------------

const SCALAR_REQUIRED_HINT = /^(color|material|shape|armrests|cushions|lighting|background)$/i;

export function detectMissingFields(memory: VisualMemoryAnchor): string[] {
  const missing: string[] = [];
  for (const [objectName, fields] of Object.entries(memory.objects)) {
    for (const [fieldName, value] of Object.entries(fields)) {
      const path = `${objectName}.${fieldName}`;
      if (value === UNKNOWN) {
        missing.push(path);
        continue;
      }
      if (typeof value === "string") {
        if (!value.trim() || value.trim().toUpperCase() === UNKNOWN) {
          missing.push(path);
        }
        continue;
      }
      if (Array.isArray(value)) {
        // Only required-feeling array fields trigger a "missing" — distinctive
        // empties are fine.
        if (value.length === 0 && SCALAR_REQUIRED_HINT.test(fieldName)) {
          missing.push(path);
        }
      }
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Prompt formatting. Produces the directive block injected into the diffusion
// prompt right after the appearance sentence. Wording is explicit ("use these
// exact details") so the model treats it as constraint, not flavour text.
// ---------------------------------------------------------------------------

function formatFieldValue(value: VisualFieldValue): string {
  if (value === UNKNOWN) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return "";
}

export function formatVisualMemoryDirective(memory: VisualMemoryAnchor): string {
  const parts: string[] = [];
  for (const [objectName, fields] of Object.entries(memory.objects)) {
    const inner: string[] = [];
    for (const [fieldName, value] of Object.entries(fields)) {
      const formatted = formatFieldValue(value);
      if (!formatted) continue;
      inner.push(`${fieldName.replace(/_/g, " ")}: ${formatted}`);
    }
    if (inner.length > 0) {
      parts.push(`${objectName} — ${inner.join("; ")}`);
    }
  }
  if (parts.length === 0) return "";
  const lead = `Visual memory anchor "${memory.label}" (id: ${memory.memoryId}) — render the scene using these EXACT remembered details, do not invent or substitute:`;
  return `${lead} ${parts.join(". ")}.`;
}

// ---------------------------------------------------------------------------
// Missing-fields ask. Used when Kane requests an anchor that still has
// UNKNOWN fields — Ashley asks for the gaps instead of hallucinating them.
// Wren contract: no fake certainty, and explicit acknowledgement that the
// memory exists but is incomplete.
// ---------------------------------------------------------------------------

export function formatMissingFieldsAsk(memory: VisualMemoryAnchor, missing: string[]): string {
  const bullet = missing.map((path) => `- ${path.replace(/[._]/g, " ")}`).join("\n");
  return [
    `I have the visual memory "${memory.label}" (id: ${memory.memoryId}) but it's incomplete — I'd be guessing if I rendered it now.`,
    "",
    "Missing details I need before I can recreate the scene faithfully:",
    bullet,
    "",
    "Fill those in and I'll render the exact scene, not a reconstruction.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Marker round-trip. The memory id rides inside the description portion of
// the [image: MODE | description] marker so it survives encodeStoredVibe →
// decodeStoredVibe → /chat/selfie unchanged (same approach as the VSPEC
// marker). On render, generateAshleySelfie pulls the id back out and re-
// resolves the anchor against the live STORE — this means edits to the
// anchor are picked up on the next render without re-baking the assistant
// message.
//
// Marker uses braces (not brackets) for the same reason VSPEC does:
// synthesizeImageActionReply runs `description.replace(/\]/g, ")")` to
// protect the [image: ...] parser. Brackets in our marker would be
// silently destroyed.
// ---------------------------------------------------------------------------

const VMEM_MARKER_OPEN = "{{VMEM}}";
const VMEM_MARKER_CLOSE = "{{/VMEM}}";
const VMEM_BLOCK_RX = /\{\{VMEM\}\}([\s\S]*?)\{\{\/VMEM\}\}/;

export function encodeMemoryIdInDescription(description: string, memoryId: string): string {
  const safeId = memoryId.replace(/[^A-Za-z0-9_\-]/g, "");
  if (!safeId) return description;
  return `${description.trim()} ${VMEM_MARKER_OPEN}${safeId}${VMEM_MARKER_CLOSE}`;
}

export function extractMemoryIdFromVibe(vibe: string | null | undefined): {
  description: string;
  memoryId: string | null;
} {
  const text = (vibe ?? "").toString();
  if (!text) return { description: "", memoryId: null };
  const m = text.match(VMEM_BLOCK_RX);
  if (!m) return { description: text, memoryId: null };
  const description = text.replace(VMEM_BLOCK_RX, "").replace(/\s+/g, " ").trim();
  const memoryId = (m[1] ?? "").trim() || null;
  return { description, memoryId };
}
