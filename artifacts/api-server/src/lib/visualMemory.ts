// ---------------------------------------------------------------------------
// Visual Memory Anchors — Wren May 2026 spec.
//
// Canonical anchor schema (Wren-authored): the `data` payload is stored
// LITERALLY as he writes it. The pilot anchor is `date_sofa_001`:
//
//   {
//     "memory_id": "date_sofa_001",
//     "label": "our date sofa",
//     "sofa": {
//       "color": "dark brown almost black",
//       "material": "leather",
//       "shape": "2-seater rectangular",
//       "armrests": "high, level with back"
//     },
//     "lighting": "dim romantic",
//     "window": "large stained glass, blue and purple",
//     "environment": {
//       "moonlight": true,
//       "rain": true,
//       "lamp_position": "behind sofa"
//     }
//   }
//
// Top-level keys are either scalars (string | boolean | UNKNOWN) or a nested
// group of scalars. We don't recurse deeper than one level — anything more
// nested than that is over-engineering for what's a description format.
//
// System metadata (importance, usage, emotionalContext) lives OUTSIDE the
// `data` payload — it's not part of Wren's schema, it's plumbing for the
// engine. `memoryId` and `label` are mirrored at the top of the anchor for
// ergonomic access (`anchor.memoryId` instead of `anchor.data.memory_id`).
//
// Wire-up unchanged from the prior shape:
//   1. /chat detects a memory request via `findVisualMemoryInText` BEFORE
//      the generic image-intent gate fires.
//   2. If the matched anchor has UNKNOWN/empty fields → return a clarifying
//      assistant message; do NOT generate an image.
//   3. Otherwise synthesise the [image: MODE | desc] marker as usual but
//      embed `{{VMEM}}<memoryId>{{/VMEM}}` in the description so /chat/selfie
//      can re-resolve the anchor at render time and pass a `sceneAnchor`
//      directive into buildModePromptBlock.
//   4. The anchor never touches profile.appearance — composeAppearance still
//      sees the unmodified profile string. Identity stays as-is from profile; only
//      this one selfie carries the sofa-room scene description.
// ---------------------------------------------------------------------------

export const UNKNOWN = "UNKNOWN" as const;

export type AnchorScalar = string | boolean | typeof UNKNOWN;
export type AnchorGroup = Record<string, AnchorScalar>;
export type AnchorField = AnchorScalar | AnchorGroup;

// `data` is the raw Wren-authored payload. memory_id and label are required;
// everything else is freeform scalar/group structure.
export type VisualMemoryAnchorData = {
  memory_id: string;
  label: string;
} & Record<string, AnchorField>;

export type VisualMemoryAnchor = {
  memoryId: string;
  label: string;
  data: VisualMemoryAnchorData;
  importance: "low" | "medium" | "high";
  emotionalContext?: string;
  usage: {
    allowedFor: string[];
    requiresExplicitRequest: boolean;
  };
};

// ---------------------------------------------------------------------------
// Pilot store. date_sofa_001 mirrors the JSON Wren sent verbatim.
// ---------------------------------------------------------------------------

const STORE: Record<string, VisualMemoryAnchor> = {
  date_sofa_001: {
    memoryId: "date_sofa_001",
    label: "our date sofa",
    importance: "high",
    emotionalContext: "Ashley waiting for Kane to come back",
    usage: {
      allowedFor: ["scene_shot", "image_generation"],
      requiresExplicitRequest: true,
    },
    data: {
      memory_id: "date_sofa_001",
      label: "our date sofa",
      sofa: {
        color: "dark brown almost black",
        material: "leather",
        shape: "2-seater rectangular",
        armrests: "high, level with back",
      },
      lighting: "dim romantic",
      window: "large stained glass, blue and purple",
      environment: {
        moonlight: true,
        rain: true,
        lamp_position: "behind sofa",
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Natural-language triggers per anchor. Kept as a separate map (not on the
// anchor itself) so the data structure stays JSON-portable for a future
// file/table backing store. Triggers cover both label phrasings ("our date
// sofa" + the older "the sofa from our date") so existing chat habits don't
// break.
// ---------------------------------------------------------------------------

const TRIGGERS: Record<string, RegExp[]> = {
  date_sofa_001: [
    /\bdate[_\s-]?sofa[_\s-]?001\b/i,
    /\b(?:our|the|that)\s+date\s+sofa\b/i,
    /\b(?:the\s+)?sofa\s+from\s+(?:our|the|that)\s+date\b/i,
    /\buse\s+(?:the\s+)?(?:date\s+)?sofa\s+memory\b/i,
    /\brecreate\s+(?:the\s+)?(?:date\s+)?sofa\s+memory\b/i,
    /\brecreate\s+(?:the\s+)?sofa\s+from\s+(?:our|the|that)\s+date\b/i,
    /\brecreate\s+(?:our|the|that)\s+date\s+sofa\b/i,
    /\b(?:date\s+)?sofa\s+memory\b/i,
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
// Field walker. Iterates the user-authored `data` payload, skipping the
// `memory_id` / `label` meta keys. Yields one entry per scalar field — for
// nested groups, the path is `[groupName, fieldName]`. We deliberately stop
// at one level of nesting; the schema is a description format, not a tree.
// ---------------------------------------------------------------------------

const META_KEYS = new Set(["memory_id", "label"]);

type WalkVisitor = (path: string[], value: AnchorScalar) => void;

function walkAnchorFields(data: VisualMemoryAnchorData, visit: WalkVisitor): void {
  for (const [key, value] of Object.entries(data)) {
    if (META_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as AnchorGroup)) {
        visit([key, subKey], subValue as AnchorScalar);
      }
    } else {
      visit([key], value as AnchorScalar);
    }
  }
}

// ---------------------------------------------------------------------------
// Missing-field detection. Returns dotted paths for every field whose value
// is UNKNOWN or an empty string. Booleans never count as missing — `false`
// is a real value (e.g. moonlight=false means a clear night, not unknown).
// ---------------------------------------------------------------------------

function isMissing(value: AnchorScalar): boolean {
  if (value === UNKNOWN) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 || trimmed.toUpperCase() === UNKNOWN;
  }
  return false;
}

export function detectMissingFields(memory: VisualMemoryAnchor): string[] {
  const missing: string[] = [];
  walkAnchorFields(memory.data, (path, value) => {
    if (isMissing(value)) missing.push(path.join("."));
  });
  return missing;
}

// ---------------------------------------------------------------------------
// Prompt formatting. Produces the directive block injected into the diffusion
// prompt right after the appearance sentence. Wording is explicit ("use these
// EXACT details") so the model treats it as constraint, not flavour text.
//
// Booleans are rendered semantically when the field name maps to a known
// presence concept (moonlight, rain, snow, fog, etc). Otherwise true → "yes",
// false is omitted (absence isn't worth a prompt token unless meaningful).
// ---------------------------------------------------------------------------

const BOOLEAN_PRESENCE_PHRASES: Record<string, { true: string; false: string }> = {
  moonlight: { true: "moonlight outside", false: "no moonlight" },
  rain: { true: "raining outside", false: "dry outside" },
  raining: { true: "raining outside", false: "dry outside" },
  snow: { true: "snow outside", false: "no snow" },
  snowing: { true: "snow outside", false: "no snow" },
  fog: { true: "fog outside", false: "clear, no fog" },
};

function formatScalar(fieldName: string, value: AnchorScalar): string | null {
  if (value === UNKNOWN) return null;
  if (typeof value === "boolean") {
    const phrase = BOOLEAN_PRESENCE_PHRASES[fieldName.toLowerCase()];
    if (phrase) return phrase[value ? "true" : "false"];
    if (!value) return null;
    return `${fieldName.replace(/_/g, " ")}: yes`;
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  return `${fieldName.replace(/_/g, " ")}: ${trimmed}`;
}

export function formatVisualMemoryDirective(memory: VisualMemoryAnchor): string {
  // Bucket fields by parent group so we can render "sofa — color: ...; material: ..." prose.
  const groups: Record<string, string[]> = {};
  const flat: string[] = [];
  for (const [key, value] of Object.entries(memory.data)) {
    if (META_KEYS.has(key)) continue;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const inner: string[] = [];
      for (const [subKey, subValue] of Object.entries(value as AnchorGroup)) {
        const formatted = formatScalar(subKey, subValue as AnchorScalar);
        if (formatted) inner.push(formatted);
      }
      if (inner.length > 0) groups[key] = inner;
    } else {
      const formatted = formatScalar(key, value as AnchorScalar);
      if (formatted) flat.push(formatted);
    }
  }

  const parts: string[] = [];
  for (const [group, inner] of Object.entries(groups)) {
    parts.push(`${group} — ${inner.join("; ")}`);
  }
  if (flat.length > 0) parts.push(flat.join("; "));

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

// Strip BOTH the VMEM marker and the visualSpec VSPEC marker from user-
// supplied text. Without this, a chat message like
// `recreate the sofa {{VMEM}}date_sofa_001{{/VMEM}}` would get baked into
// the assistant's selfieVibe and resolve to that anchor at render time —
// bypassing `findVisualMemoryInText` entirely. Same risk for VSPEC.
// Apply this to user input BEFORE it enters extractVisualSpecCompound /
// synthesizeImageActionReplyFromSpec.
const VSPEC_BLOCK_RX_GLOBAL = /\{\{VSPEC\}\}[\s\S]*?\{\{\/VSPEC\}\}/g;
const VMEM_BLOCK_RX_GLOBAL = /\{\{VMEM\}\}[\s\S]*?\{\{\/VMEM\}\}/g;

export function stripUserSuppliedMarkers(text: string): string {
  if (!text) return text;
  return text
    .replace(VMEM_BLOCK_RX_GLOBAL, "")
    .replace(VSPEC_BLOCK_RX_GLOBAL, "")
    .replace(/\s+/g, " ")
    .trim();
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
