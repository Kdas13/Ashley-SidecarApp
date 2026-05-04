import AsyncStorage from "@react-native-async-storage/async-storage";

const DEVICE_ID_KEY = "@ashley/device-id/v1";

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

let cached: string | null = null;
let inflight: Promise<string> | null = null;

/**
 * Return the per-install device id, generating + persisting one on first
 * call. Subsequent calls return the cached value synchronously fast.
 *
 * The id is the user — every authenticated request to api-server carries
 * it as `X-Device-Id` and the server keys all profile / message / memory
 * rows by it. Wiping AsyncStorage therefore creates a fresh "user" on
 * the server side; the old data stays orphaned (no auth, so we can't
 * recover it without the original id).
 */
export async function getOrCreateDeviceId(): Promise<string> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
      if (existing && existing.trim().length >= 8) {
        cached = existing.trim();
        return cached;
      }
    } catch {
      // fall through to generate a fresh id
    }
    const fresh = uuidv4();
    try {
      await AsyncStorage.setItem(DEVICE_ID_KEY, fresh);
    } catch {
      // best-effort — even if persisting fails this session, the cached
      // value will keep this run consistent.
    }
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

const DEVICE_ID_RE = /^[A-Za-z0-9-]+$/;

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
  if (id.length < 8 || id.length > 128 || !DEVICE_ID_RE.test(id)) {
    throw new Error(
      "That doesn't look like a valid Device ID. Paste the full id you copied earlier.",
    );
  }
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  cached = id;
  return id;
}
