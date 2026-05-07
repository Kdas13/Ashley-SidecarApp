// =============================================================================
// Push registration status — observable snapshot for the profile screen.
// -----------------------------------------------------------------------------
// `pushRegistration.ts` updates this snapshot at each step so the UI can
// surface what actually happened on the device without needing `adb logcat`.
// Module-level state + subscribe/getSnapshot makes it usable from
// React.useSyncExternalStore.
// =============================================================================

import { useSyncExternalStore } from "react";

export type PushStatus = {
  /** `Device.isDevice` from expo-device (null = not yet checked). */
  isDevice: boolean | null;
  /** Final OS notification permission ("granted" | "denied" | …). */
  permission: string | null;
  /** EAS projectId resolved from app config (null = not found). */
  projectId: string | null;
  /** Whether `getExpoPushTokenAsync` succeeded. */
  tokenStatus: "ok" | "fail" | null;
  /** The token itself (truncated for display elsewhere). */
  token: string | null;
  /** Result of the POST /api/devices/push-token call. */
  uploadStatus: "ok" | "fail" | null;
  /** Last error message from any step (token fetch OR upload). */
  lastError: string | null;
  /** Wall-clock ISO when the snapshot was last touched. */
  updatedAt: string | null;
};

const EMPTY: PushStatus = {
  isDevice: null,
  permission: null,
  projectId: null,
  tokenStatus: null,
  token: null,
  uploadStatus: null,
  lastError: null,
  updatedAt: null,
};

let snapshot: PushStatus = EMPTY;
const subscribers = new Set<() => void>();

export function getPushStatus(): PushStatus {
  return snapshot;
}

export function setPushStatus(patch: Partial<PushStatus>): void {
  snapshot = {
    ...snapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  for (const fn of subscribers) fn();
}

export function resetPushStatus(): void {
  snapshot = { ...EMPTY };
  for (const fn of subscribers) fn();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function usePushStatus(): PushStatus {
  return useSyncExternalStore(subscribe, getPushStatus, getPushStatus);
}
