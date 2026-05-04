import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystem from "expo-file-system/legacy";

const DEVICE_ID_KEY = "@ashley/device-id/v1";
const DEVICE_ID_FILENAME = "ashley-device-id.v1.txt";

function deviceIdFileUri(): string | null {
  const dir = FileSystem.documentDirectory;
  if (!dir) return null;
  return dir + DEVICE_ID_FILENAME;
}

/**
 * UUID-v4-ish device id. We don't have a crypto-strength RNG in Expo Go
 * across every platform, but `Math.random()` provides ~122 bits of
 * entropy here which is more than enough for collision avoidance across
 * the install base of a personal companion app.
 */
function uuidv4(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

const DEVICE_ID_RE = /^[A-Za-z0-9-]+$/;
function isValidDeviceId(raw: string | null | undefined): raw is string {
  if (!raw) return false;
  const id = raw.trim();
  return id.length >= 8 && id.length <= 128 && DEVICE_ID_RE.test(id);
}

let cached: string | null = null;
let inflight: Promise<string> | null = null;

async function readFromFile(): Promise<string | null> {
  const uri = deviceIdFileUri();
  if (!uri) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return null;
    const txt = await FileSystem.readAsStringAsync(uri);
    const trimmed = txt.trim();
    return isValidDeviceId(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

async function readFromAsyncStorage(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(DEVICE_ID_KEY);
    const trimmed = v?.trim();
    return isValidDeviceId(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

async function persistEverywhere(id: string): Promise<void> {
  // Best-effort dual-write. AsyncStorage is fast/normal; the file in
  // documentDirectory is the durable backup that survives Expo Go
  // wiping its app-private storage between sessions (which is what
  // bit the user repeatedly — every reload generated a brand-new id
  // and orphaned the previous server-side conversation).
  await Promise.allSettled([
    AsyncStorage.setItem(DEVICE_ID_KEY, id),
    (async () => {
      const uri = deviceIdFileUri();
      if (!uri) return;
      await FileSystem.writeAsStringAsync(uri, id);
    })(),
  ]);
}

/**
 * Return the per-install device id, generating + persisting one on first
 * call. Subsequent calls return the cached value synchronously fast.
 *
 * The id is the user — every authenticated request to api-server carries
 * it as `X-Device-Id` and the server keys all profile / message / memory
 * rows by it. We persist to BOTH AsyncStorage and a file in the document
 * directory; whichever one survives wins. This matters because Expo Go
 * occasionally clears AsyncStorage between launches, which would
 * otherwise generate a fresh id and orphan the user's data on every
 * reload.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    // Prefer the file (most durable in Expo Go), then AsyncStorage,
    // then generate fresh.
    const fromFile = await readFromFile();
    if (fromFile) {
      cached = fromFile;
      // Heal AsyncStorage if it was the one that got wiped.
      try {
        await AsyncStorage.setItem(DEVICE_ID_KEY, fromFile);
      } catch {
        // ignore
      }
      return fromFile;
    }
    const fromAS = await readFromAsyncStorage();
    if (fromAS) {
      cached = fromAS;
      // Heal the file backup.
      const uri = deviceIdFileUri();
      if (uri) {
        try {
          await FileSystem.writeAsStringAsync(uri, fromAS);
        } catch {
          // ignore
        }
      }
      return fromAS;
    }
    const fresh = uuidv4();
    await persistEverywhere(fresh);
    cached = fresh;
    return fresh;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** Synchronous accessor for code paths that already awaited init at boot. */
export function getDeviceIdSync(): string {
  if (!cached) {
    throw new Error(
      "Device id not initialized — call getOrCreateDeviceId() at app boot first.",
    );
  }
  return cached;
}

/** True when the device id has been resolved at least once this session. */
export function hasDeviceId(): boolean {
  return cached !== null;
}

/**
 * Override the persisted device id with a user-supplied one. Used by the
 * "Restore from Device ID" flow on the profile screen so a user whose
 * AsyncStorage was wiped (e.g. Expo Go updated overnight) can paste in
 * the id they previously copied and reconnect to all of their existing
 * server-side conversation, memories, and profile.
 *
 * Validates loosely — accepts anything 8-128 chars matching the same
 * charset the server middleware allows. Caller is responsible for
 * invalidating any in-memory React Query caches afterwards.
 */
export async function setDeviceId(rawId: string): Promise<string> {
  const id = rawId.trim();
  if (!isValidDeviceId(id)) {
    throw new Error(
      "That doesn't look like a valid Device ID. Paste the full id you copied earlier.",
    );
  }
  await persistEverywhere(id);
  cached = id;
  return id;
}
