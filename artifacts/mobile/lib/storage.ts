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
  /**
   * Relationship Mode — the current frame Ashley operates in. Empty
   * string means undefined and Ashley won't claim a specific mode.
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
  /** Absolute URL of a generated selfie, when one is attached. */
  imageUrl?: string | null;
  /**
   * Visual prompt the server stored when Ashley wanted to take a selfie
   * but the image hadn't been generated yet. While set with a null
   * imageUrl the UI renders a "taking a selfie..." pending bubble.
   * Cleared once the photo arrives.
   */
  selfieVibe?: string | null;
  /** Quoted earlier message attached to a swipe-to-reply. */
  replyTo?: ReplyToRef | null;
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
  relationshipMode: "",
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
