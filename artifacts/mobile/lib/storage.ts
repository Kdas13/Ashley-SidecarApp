import AsyncStorage from "@react-native-async-storage/async-storage";

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
  await AsyncStorage.setItem(key, JSON.stringify(value));
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
    KEYS.profile,
    KEYS.memories,
    KEYS.messages,
    KEYS.summaries,
  ]);
}
