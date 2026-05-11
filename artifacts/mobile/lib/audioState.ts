// ---------------------------------------------------------------------------
// Shared audio lifecycle state tracker.
//
// Module-level (not React) so voiceOutput.ts, voiceInput.ts, and chat.tsx
// can all read/write it without prop-drilling or context indirection.
//
// `useAudioState()` is the React hook for components that need to re-render
// when state changes. Everything else uses `patchAudioState` / `getAudioState`
// directly.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";

export type MicPermission = "unknown" | "granted" | "denied";
export type AudioFocus = "none" | "recording" | "playback";

export type AudioStateSnapshot = {
  ttsReady: boolean;
  ttsSpeaking: boolean;
  sttReady: boolean;
  sttListening: boolean;
  micPermission: MicPermission;
  audioFocusState: AudioFocus;
  lastTtsStartedAt: number | null;
  lastTtsFinishedAt: number | null;
  lastSttStartedAt: number | null;
  lastSttStoppedAt: number | null;
  lastAudioError: string | null;
  lastRecoveryAttemptAt: number | null;
  recoveryCount: number;
  lastRecoveryReason: string | null;
};

const INITIAL_STATE: AudioStateSnapshot = {
  ttsReady: true,
  ttsSpeaking: false,
  sttReady: true,
  sttListening: false,
  micPermission: "unknown",
  audioFocusState: "none",
  lastTtsStartedAt: null,
  lastTtsFinishedAt: null,
  lastSttStartedAt: null,
  lastSttStoppedAt: null,
  lastAudioError: null,
  lastRecoveryAttemptAt: null,
  recoveryCount: 0,
  lastRecoveryReason: null,
};

let _state: AudioStateSnapshot = { ...INITIAL_STATE };
const _listeners = new Set<(s: AudioStateSnapshot) => void>();

export function getAudioState(): AudioStateSnapshot {
  return _state;
}

export function patchAudioState(patch: Partial<AudioStateSnapshot>): void {
  _state = { ..._state, ...patch };
  for (const fn of _listeners) fn(_state);
}

export function resetAudioState(): void {
  _state = { ...INITIAL_STATE, recoveryCount: _state.recoveryCount };
  for (const fn of _listeners) fn(_state);
}

function subscribe(fn: (s: AudioStateSnapshot) => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/** React hook — re-renders the component on every audio state change. */
export function useAudioState(): AudioStateSnapshot {
  const [snap, setSnap] = useState<AudioStateSnapshot>(_state);
  useEffect(() => subscribe(setSnap), []);
  return snap;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

/** Log a structured audio event to the console with a visible prefix. */
export function audioLog(tag: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`[Audio][${tag}]`, JSON.stringify(extra));
  } else {
    console.log(`[Audio][${tag}]`);
  }
}

/**
 * Log an audio error, set lastAudioError, and log the current snapshot
 * so every failure leaves a breadcrumb.
 */
export function audioError(
  fn: string,
  err: unknown,
  extra?: Record<string, unknown>,
): void {
  const msg = err instanceof Error ? err.message : String(err);
  const snap = getAudioState();
  console.log(`[Audio][ERROR][${fn}]`, msg, extra ?? "", {
    ttsReady: snap.ttsReady,
    ttsSpeaking: snap.ttsSpeaking,
    sttReady: snap.sttReady,
    sttListening: snap.sttListening,
    audioFocusState: snap.audioFocusState,
    recoveryCount: snap.recoveryCount,
  });
  patchAudioState({ lastAudioError: `${fn}: ${msg}` });
}
