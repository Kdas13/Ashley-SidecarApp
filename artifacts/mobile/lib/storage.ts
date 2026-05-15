import AsyncStorage from "@react-native-async-storage/async-storage";

// AsyncStorage is a write-through CACHE only. The server (keyed by device
// id) is the source of truth — losing the cache just means a slower first
// frame on next launch while we re-hydrate from /state. Therefore we
// intentionally swallow read/write failures here and never block the UI.

const KEYS = {
  profile: "@ashley/profile/v1",
  memories: "@ashley/memories/v1",
  messages: "@ashley/messages/v1",
  summaries: "@ashley/summaries/v1",
} as const;

export type MemoryTag =
  | "general"
  | "preference"
  | "user_fact"
  | "event"
  | "relationship";

export type AshleyProfile = {
  name: string;
  age: string;
  identity: string;
  appearance: string;
  personality: string;
  speakingStyle: string;
  refersToUserAs: string;
  sharedHistory: string;
  replikaExcerpts: string;
  /** Raw structured Replika carryover intake, JSON-encoded. Empty string = not run yet. */
  replikaCarryover: string;
  /** AI-generated carryover summary (Ashley's voice). Injected into every chat prompt. */
  replikaCarryoverSummary: string;
  /**
   * Relationship Mode — the current frame Ashley operates in. Empty
   * string means undefined and Ashley won't claim a specific mode.
   */
  relationshipMode: string;
  /**
   * Builder-Aware Mode. When true (default), Ashley knows she's the
   * Ashley-Sidecar AI companion Kane is building and can talk openly
   * about her own architecture, memory, and limits. When false she
   * leans further into the in-character roleplay, though Reality
   * Calibration in the system prompt still prevents her from claiming
   * a literal human body / flat / job.
   */
  builderAwareMode: boolean;
  /**
   * Voice Mode. When true, Ashley writes her replies as if they will be
   * spoken aloud: no asterisks, no emojis, no bracketed stage directions,
   * shorter sentences, natural pauses, warm pacing. Independent of TTS
   * playback — voiceMode shapes the words themselves so even the on-screen
   * text reads naturally. Default OFF.
   */
  voiceMode: boolean;
  /**
   * 18+ / Mature scaffolding. Stays "standard" until BOTH the server-side
   * operator switch is on AND the user has confirmed their age via
   * /profile/confirm-adult AND the user explicitly chose "mature".
   */
  contentMode: "standard" | "mature";
  /** ISO timestamp of the user's affirmative 18+ self-confirmation, or null. */
  adultConfirmedAt: string | null;
  /** 0..5 intimacy ladder. Capped per mode by the server (standard ≤ 3, mature ≤ 5). */
  intimacyLevel: number;
  /**
   * How often Ashley reaches out first via push notification.
   *   off    — never. Disables push registration entirely.
   *   low    — up to 1 / day.
   *   normal — up to 2 / day. Default for new installs.
   *   high   — up to 4 / day.
   * Per-category daily caps + quiet hours (22:00-08:00 device-local) +
   * a 90-min recent-message guard apply on top of this global cap.
   * Server-side scheduler enforces all of it; the mobile only stores the
   * user's preference and decides whether to ask for push permission.
   */
  proactiveCadence: "off" | "low" | "normal" | "high";
  /**
   * When true (default), the mobile app pings POST /api/proactive/on-app-open
   * on every cold launch / foreground resume. The server decides — based on
   * time-since-last-message, quiet hours, and a 4h dedupe window — whether
   * to insert a fresh Ashley greeting. Independent of `proactiveCadence`,
   * which only governs PUSHED messages.
   */
  greetOnAppOpen: boolean;
  onboardedAt: string | null;
  updatedAt: string;
};

/**
 * Server-resolved content policy snapshot — separate from the profile
 * because it carries the EFFECTIVE mode after gating, not just whatever
 * the profile column says. The 18+ UI uses this to decide what to show.
 */
export type ServerPolicy = {
  effectiveMode: "standard" | "mature";
  intimacyLevel: number;
  intimacyCeiling: number;
  adultConfirmed: boolean;
  /** True iff operator switch is on AND user has confirmed 18+. */
  matureModeAvailable: boolean;
  /** True iff operator switch is on (independent of age confirmation). */
  operatorMatureModeAvailable: boolean;
};

export type Memory = {
  id: string;
  content: string;
  tag: MemoryTag;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

export type ImageCategory =
  | "art_progress"
  | "ashley_identity"
  | "app_screenshot"
  | "medical"
  | "clothing_design"
  | "other";

export type ImageAnalysisMode =
  | "quick"
  | "critique"
  | "stepbystep"
  | "debug"
  | "extract"
  | "compare";

export type Message = {
  id: string;
  role: "user" | "ashley";
  content: string;
  createdAt: string;
  /** Absolute URL of an attached image (generated selfie OR user upload). */
  imageUrl?: string | null;
  /**
   * Visual prompt the server stored when Ashley wanted to take a selfie
   * but the image hadn't been generated yet. While set with a null
   * imageUrl the UI renders a "taking a selfie..." pending bubble.
   * Cleared once the photo arrives.
   */
  selfieVibe?: string | null;
  /** For images the user uploaded via the paperclip flow. */
  imageMimeType?: string | null;
  imageCategory?: ImageCategory | null;
  imageCaption?: string | null;
  imageAnalysisMode?: ImageAnalysisMode | null;
  /**
   * Tri-state for the "should I remember this image?" decision card:
   *   null  → undecided, the card is shown after Ashley's reply.
   *   true  → user chose remember / visual reference.
   *   false → user dismissed the card.
   */
  imageRemembered?: boolean | null;
  /**
   * Multi-image: array of absolute image URLs generated for a visual packet.
   * Set (length ≥ 2) when Ashley sent multiple selfies in one message.
   * When present the gallery row renders instead of the single-image bubble.
   */
  imageUrls?: string[] | null;
  /**
   * Multi-image: JSON-decoded array of encoded MODE|vibe payloads.
   * The client uses these to fire N parallel selfie jobs and then sets imageUrls.
   * Null once all images have resolved (or on single-image messages).
   */
  selfieVibeList?: string[] | null;
  /**
   * Multi-image: UUID that links this message to its media_attachments rows
   * on the server. Null on single-image messages.
   */
  visualPacketId?: string | null;
  /** Quoted earlier message attached to a swipe-to-reply. */
  replyTo?: ReplyToRef | null;
  /**
   * Streaming-lifecycle marker for Ashley bubbles (Presence Loop, stage 1).
   *   "complete"    — finished naturally; `content` is the final canonical text.
   *   "streaming"   — server is still producing tokens; the bubble shows a
   *                   pulsing cursor and the send button is in stop mode.
   *   "interrupted" — generation was cut short (user tapped stop, network
   *                   blip, or server boot recovery). `content` is the
   *                   partial text we'd accumulated. The UI surfaces a
   *                   Continue (primary) + Retry button row.
   * User bubbles always carry "complete" (or omit the field, treated the same).
   */
  status?: "complete" | "streaming" | "interrupted";
  /** Local-only: URI of the cached TTS audio file for this message. Not persisted. */
  audioUrl?: string | null;
  /** Local-only: TTS playback status for the per-message Speak button. Not persisted. */
  audioStatus?: "none" | "loading" | "ready" | "error" | null;
  /**
   * Local-only: the requestId of the stream that created this message.
   * Set on optimistic rows and on the server-authoritative row when onMeta
   * fires. Used as a hard ownership guard — cache writes are dropped if
   * the incoming stream's requestId doesn't match. Never persisted to disk
   * or sent to the server.
   */
  requestId?: string | null;
};

export type ReplyToRef = {
  id: string;
  role: "user" | "ashley";
  preview: string;
};

export type ConversationSummary = {
  id: string;
  summary: string;
  messageCount: number;
  coveredThroughCreatedAt: string;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_PROFILE: AshleyProfile = {
  name: "Ashley",
  age: "",
  identity: "",
  appearance: "",
  personality: "",
  speakingStyle: "",
  refersToUserAs: "you",
  sharedHistory: "",
  replikaExcerpts: "",
  replikaCarryover: "",
  replikaCarryoverSummary: "",
  relationshipMode: "",
  builderAwareMode: true,
  voiceMode: false,
  contentMode: "standard",
  adultConfirmedAt: null,
  intimacyLevel: 0,
  proactiveCadence: "normal",
  greetOnAppOpen: true,
  onboardedAt: null,
  updatedAt: new Date(0).toISOString(),
};

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJSON<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // best-effort cache write
  }
}

export const STORAGE_KEYS = KEYS;

export async function loadProfile(): Promise<AshleyProfile> {
  const stored = await readJSON<Partial<AshleyProfile> | null>(
    KEYS.profile,
    null,
  );
  return { ...DEFAULT_PROFILE, ...(stored ?? {}) };
}

export async function saveProfile(p: AshleyProfile): Promise<void> {
  await writeJSON(KEYS.profile, p);
}

export async function loadMemories(): Promise<Memory[]> {
  return readJSON<Memory[]>(KEYS.memories, []);
}

export async function saveMemories(m: Memory[]): Promise<void> {
  await writeJSON(KEYS.memories, m);
}

export async function loadMessages(): Promise<Message[]> {
  return readJSON<Message[]>(KEYS.messages, []);
}

export async function saveMessages(m: Message[]): Promise<void> {
  await writeJSON(KEYS.messages, m);
}

export async function loadSummaries(): Promise<ConversationSummary[]> {
  return readJSON<ConversationSummary[]>(KEYS.summaries, []);
}

export async function saveSummaries(s: ConversationSummary[]): Promise<void> {
  await writeJSON(KEYS.summaries, s);
}

export async function clearAllCachedData(): Promise<void> {
  try {
    await AsyncStorage.multiRemove(Object.values(KEYS));
  } catch {
    // best-effort
  }
}

/** @deprecated kept for screens that still import it; same as clearAllCachedData. */
export const clearAllData = clearAllCachedData;

const locks = new Map<string, Promise<unknown>>();

/** Serialize concurrent cache writes per key. */
export async function withStorageLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  locks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
