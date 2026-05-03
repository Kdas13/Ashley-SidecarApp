import AsyncStorage from "@react-native-async-storage/async-storage";

const KEYS = {
  profile: "@ashley/profile/v1",
  memories: "@ashley/memories/v1",
  messages: "@ashley/messages/v1",
  summaries: "@ashley/summaries/v1",
} as const;

// Shadow keys: every write to one of the keys above is mirrored to its
// shadow. On load, if the primary key is missing or empty but the shadow
// has data, we restore from the shadow. Defends against single-key
// AsyncStorage wipes (which we've observed in Expo Go) without the
// complexity of a full second store.
const SHADOW_KEYS = {
  profile: "@ashley/profile/v1.shadow",
  memories: "@ashley/memories/v1.shadow",
  messages: "@ashley/messages/v1.shadow",
  summaries: "@ashley/summaries/v1.shadow",
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
  /**
   * Relationship Mode — the current frame Ashley operates in. One of the
   * preset modes ("Friend", "Best friend", "Companion", "Romantic partner",
   * "Mentor/coach", "Creative partner") OR a free-form Custom string.
   * Empty string means undefined and Ashley won't claim a specific mode.
   * Changeable any time from the chat header or profile screen. Treated as
   * a CURRENT SETTING, never as a permanent emotional memory.
   */
  relationshipMode: string;
  onboardedAt: string | null;
  updatedAt: string;
};

export type Memory = {
  id: string;
  content: string;
  tag: MemoryTag;
  importance: number;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  role: "user" | "ashley";
  content: string;
  createdAt: string;
  /**
   * When Ashley sends a real selfie, this is set to the absolute URL of the
   * generated image. The text in `content` is the caption (or empty marker
   * fallback like "*sends a photo*").
   */
  imageUrl?: string | null;
  /**
   * The visual prompt Ashley emitted when she wanted to take a selfie. The
   * UI uses this in two ways:
   *   - while `imageUrl` is null and `selfieVibe` is set, render a "taking
   *     a selfie…" pending state for the bubble
   *   - if generation fails, the user can tap retry and we re-issue
   *     `POST /chat/selfie` with the same vibe.
   * Cleared once the photo successfully arrives.
   */
  selfieVibe?: string | null;
  /**
   * When this message was sent as a reply to a specific earlier message,
   * `replyTo` captures a snippet of that message so the bubble can show a
   * quoted-reply header. We only store a small preview (not the full text
   * or id of the original) — the original message stays where it is in the
   * timeline and is not duplicated.
   */
  replyTo?: ReplyToRef | null;
};

/** Lightweight quote of an earlier message attached to a reply. */
export type ReplyToRef = {
  /** Original message id, used by the UI to scroll/highlight on tap (future). */
  id: string;
  /** Author of the quoted message. */
  role: "user" | "ashley";
  /** Trimmed preview of the original message (max ~140 chars). */
  preview: string;
};

// Rolling narrative summary of an older chunk of messages.  Once the live
// chat grows past the in-prompt window, the oldest unsummarized chunk is
// distilled into one of these so Ashley keeps remembering the long tail.
export type ConversationSummary = {
  id: string;
  summary: string;
  messageCount: number;
  // Cursor: messages with createdAt <= this are considered summarized.
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
  relationshipMode: "",
  onboardedAt: null,
  updatedAt: new Date(0).toISOString(),
};

export function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Tracks the last successfully-parsed value per key. Used to gate writes:
// if we ever read raw bytes and fail to parse them, we MUST NOT
// overwrite — that would silently destroy history. Instead we surface an
// error to the caller and back up the corrupt blob.
const lastReadOk = new Map<string, true>();
const readFailureMarker = new Map<string, string>(); // key → backup key used

/**
 * Read a single key's raw bytes and parse them. On parse failure backs up
 * the raw blob to a timestamped key and marks `key` as read-failed so the
 * caller knows not to overwrite it. Returns `undefined` when the key is
 * absent (caller can then try the shadow), or the parsed value, or
 * `undefined` if parsing failed.
 */
async function readOneJSON<T>(key: string): Promise<T | undefined> {
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(key);
  } catch (err) {
    readFailureMarker.set(key, "<getItem-failed>");
    // eslint-disable-next-line no-console
    console.warn(`[storage] getItem failed for ${key}`, err);
    return undefined;
  }
  if (raw === null || raw === undefined) return undefined;
  if (raw === "") {
    readFailureMarker.set(key, "<empty-string>");
    // eslint-disable-next-line no-console
    console.warn(`[storage] empty raw for ${key} — blocking writes`);
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    const backupKey = `${key}::corrupt::${Date.now()}`;
    try {
      await AsyncStorage.setItem(backupKey, raw);
    } catch {
      // best-effort
    }
    readFailureMarker.set(key, backupKey);
    // eslint-disable-next-line no-console
    console.warn(
      `[storage] parse failed for ${key}; corrupt blob saved to ${backupKey}`,
      err,
    );
    return undefined;
  }
}

function isMeaningfullyPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as object).length > 0;
  return true;
}

/**
 * Read with a shadow fallback: if the primary key is missing or returns
 * an empty list/object, try the shadow key. If the shadow has real data,
 * restore the primary from it. This is the line of defense against a
 * single-key AsyncStorage wipe.
 */
async function readJSON<T>(key: string, fallback: T): Promise<T> {
  const shadow = SHADOW_KEYS[key as keyof typeof SHADOW_KEYS];

  const primary = await readOneJSON<T>(key);
  if (isMeaningfullyPresent(primary)) {
    lastReadOk.set(key, true);
    readFailureMarker.delete(key);
    // Make sure the shadow is in sync so it's useful next time.
    if (shadow) {
      try {
        await AsyncStorage.setItem(shadow, JSON.stringify(primary));
      } catch {
        // best-effort
      }
    }
    return primary as T;
  }

  // Primary is missing/empty (or parse-failed). Try the shadow.
  if (shadow) {
    const shadowValue = await readOneJSON<T>(shadow);
    if (isMeaningfullyPresent(shadowValue)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[storage] primary ${key} was empty; restored from shadow ${shadow}`,
      );
      // Restore the primary, but only if the primary read didn't fail —
      // if it failed, we're still blocked from writing it.
      if (!readFailureMarker.has(key)) {
        try {
          await AsyncStorage.setItem(key, JSON.stringify(shadowValue));
          lastReadOk.set(key, true);
        } catch {
          // best-effort
        }
      }
      return shadowValue as T;
    }
  }

  // Both empty (or both failed). Allow writes if the primary itself was
  // genuinely absent (no failure marker set above).
  if (!readFailureMarker.has(key)) {
    lastReadOk.set(key, true);
  }
  // If we got a parsed-but-empty primary (e.g. []), preserve that exact
  // shape; otherwise fall back to the caller's default.
  return primary !== undefined ? (primary as T) : fallback;
}

async function writeJSON<T>(key: string, value: T): Promise<void> {
  // Refuse the write if the last read for this key failed. Otherwise we'd
  // silently overwrite recoverable user data with whatever the in-memory
  // fallback was.
  const blocker = readFailureMarker.get(key);
  if (blocker) {
    throw new Error(
      `Refusing to write ${key}: previous read failed (raw blob backed up to ${blocker}). Restart the app or clear storage to recover.`,
    );
  }
  const serialized = JSON.stringify(value);
  await AsyncStorage.setItem(key, serialized);
  lastReadOk.set(key, true);
  // Mirror to shadow. Best-effort: if the shadow write fails the primary
  // is still saved, so we don't escalate the error.
  const shadow = SHADOW_KEYS[key as keyof typeof SHADOW_KEYS];
  if (shadow) {
    try {
      await AsyncStorage.setItem(shadow, serialized);
    } catch {
      // best-effort — primary write already succeeded
    }
  }
}

const locks = new Map<string, Promise<unknown>>();

/**
 * Serializes async work per storage key so that concurrent
 * read-modify-write mutations cannot lose updates.
 */
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

export const STORAGE_KEYS = KEYS;

export async function loadProfile(): Promise<AshleyProfile> {
  const stored = await readJSON<Partial<AshleyProfile> | null>(KEYS.profile, null);
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

/**
 * Atomically patch a single message in storage by id. Returns the updated
 * message list, or null if no message with that id exists. Used by the
 * background selfie fetch to attach the imageUrl to an already-rendered
 * Ashley bubble without disturbing the rest of the conversation.
 */
export async function patchMessage(
  id: string,
  patch: Partial<Omit<Message, "id">>,
): Promise<Message[] | null> {
  return withStorageLock(KEYS.messages, async () => {
    const all = await readJSON<Message[]>(KEYS.messages, []);
    let touched = false;
    const next = all.map((m) => {
      if (m.id !== id) return m;
      touched = true;
      return { ...m, ...patch };
    });
    if (!touched) return null;
    await writeJSON(KEYS.messages, next);
    return next;
  });
}

export async function loadSummaries(): Promise<ConversationSummary[]> {
  return readJSON<ConversationSummary[]>(KEYS.summaries, []);
}

export async function saveSummaries(s: ConversationSummary[]): Promise<void> {
  await writeJSON(KEYS.summaries, s);
}

export async function clearAllData(): Promise<void> {
  await AsyncStorage.multiRemove([
    ...Object.values(KEYS),
    ...Object.values(SHADOW_KEYS),
  ]);
  // Reset the in-memory read-failure markers so subsequent writes are
  // unblocked — the keys are gone, so a fresh read will see `raw === null`
  // and mark them OK.
  for (const k of Object.values(KEYS)) {
    readFailureMarker.delete(k);
    lastReadOk.set(k, true);
  }
}
