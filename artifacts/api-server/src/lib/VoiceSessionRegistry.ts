// ---------------------------------------------------------------------------
// VoiceSessionRegistry — Phase 1 voice call session state manager.
//
// All voice session state lives here. Nothing lives in route closures.
// This file has NO Express or WS imports so it can be unit-tested in
// isolation. The ws socket is typed as WsLike (a minimal duck-type).
//
// Lifecycle log events (append-only per session):
//   CALL_CREATED, CALL_RECOVERING, CALL_RECONNECTED, TRANSCRIPT_FINAL,
//   CONTEXT_LOADED, CLAUDE_STARTED, CLAUDE_FINISHED, TTS_STARTED,
//   TTS_FINISHED, CALL_ENDED
// ---------------------------------------------------------------------------

// Minimal duck-type for the WebSocket — avoids importing 'ws' here so the
// file stays testable without Express/WS in scope.
export interface WsLike {
  send(data: string | Buffer): void;
  close(): void;
}

export type VoiceSessionState =
  | "active"
  | "listening"
  | "llm_pending"
  | "tts_streaming"
  | "interrupted_cleanup"
  | "recovering"
  | "closing"
  | "closed"
  | "failed";

export interface VoiceSession {
  // Identity
  sessionId: string;
  deviceId: string;
  connectionGeneration: number;
  sequenceNumber: number;

  // State
  state: VoiceSessionState;
  ws: WsLike | null;

  // Ownership tracking (F12, F13, F14, F15)
  currentSpeechId: string | null;
  currentTurnId: string | null;
  currentResponseId: string | null;
  currentAbortController: AbortController | null;
  processedUtteranceIds: Set<string>;
  completedTurnIds: Set<string>; // idempotency protection

  // Timing
  callStartTime: Date;
  lastAudioReceivedAt: Date | null;
  silenceWarningSent: boolean; // reset only on real user audio

  // Cost tracking (F19)
  totalTokensUsed: number;
  totalTtsChars: number;
  reconnectAttempts: number;

  // Context failure tracking (Checkpoint 1D)
  consecutiveContextFailures: number;

  // Recovery (F11)
  recoveryTimer: NodeJS.Timeout | null;

  // Lifecycle logs
  log: Array<{ event: string; ts: Date; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Storage — module-level maps (singleton per process).
// ---------------------------------------------------------------------------
const sessionsBySessionId = new Map<string, VoiceSession>();
const sessionIdByDeviceId = new Map<string, string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  return crypto.randomUUID();
}

function appendLog(
  session: VoiceSession,
  event: string,
  detail?: string,
): void {
  session.log.push({ event, ts: new Date(), detail });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new session for a freshly connected device. Stores in both maps.
 * Logs CALL_CREATED.
 */
export function create(deviceId: string, ws: WsLike): VoiceSession {
  const session: VoiceSession = {
    sessionId: generateSessionId(),
    deviceId,
    connectionGeneration: 1,
    sequenceNumber: 0,

    state: "active",
    ws,

    currentSpeechId: null,
    currentTurnId: null,
    currentResponseId: null,
    currentAbortController: null,
    processedUtteranceIds: new Set(),
    completedTurnIds: new Set(),

    callStartTime: new Date(),
    lastAudioReceivedAt: null,
    silenceWarningSent: false,

    totalTokensUsed: 0,
    totalTtsChars: 0,
    reconnectAttempts: 0,
    consecutiveContextFailures: 0,

    recoveryTimer: null,

    log: [],
  };

  sessionsBySessionId.set(session.sessionId, session);
  sessionIdByDeviceId.set(deviceId, session.sessionId);

  appendLog(session, "CALL_CREATED", `deviceId=${deviceId}`);
  return session;
}

/**
 * Look up a session by deviceId. Returns null if none exists.
 */
export function findByDeviceId(deviceId: string): VoiceSession | null {
  const sessionId = sessionIdByDeviceId.get(deviceId);
  if (!sessionId) return null;
  return sessionsBySessionId.get(sessionId) ?? null;
}

/**
 * Look up a session by sessionId. Returns null if none exists.
 */
export function findBySessionId(sessionId: string): VoiceSession | null {
  return sessionsBySessionId.get(sessionId) ?? null;
}

/**
 * Attempt to reclaim a recovering session for a reconnecting device.
 * Returns the reclaimed session, or null if no recovering session found.
 *
 * ATOMIC: clears recovery timer, increments connectionGeneration, sets
 * state to "active", and attaches the new WS — all before returning.
 * Logs CALL_RECONNECTED.
 */
export function reclaimSession(
  deviceId: string,
  ws: WsLike,
): VoiceSession | null {
  const session = findByDeviceId(deviceId);
  if (!session || session.state !== "recovering") return null;

  // Atomically clear timer + increment generation + attach new ws.
  if (session.recoveryTimer !== null) {
    clearTimeout(session.recoveryTimer);
    session.recoveryTimer = null;
  }
  session.connectionGeneration += 1;
  session.state = "active";
  session.ws = ws;
  session.reconnectAttempts += 1;

  appendLog(
    session,
    "CALL_RECONNECTED",
    `gen=${session.connectionGeneration} reconnects=${session.reconnectAttempts}`,
  );
  return session;
}

/**
 * Mark a session as recovering after a WebSocket disconnect.
 * Starts a 60-second timer that calls finalise() if no reconnect arrives.
 * The timer re-checks state AND connectionGeneration before finalising
 * so a concurrent reclaimSession() wins the race cleanly.
 * Logs CALL_RECOVERING.
 */
export function markRecovering(sessionId: string): void {
  const session = sessionsBySessionId.get(sessionId);
  if (!session) return;

  session.state = "recovering";
  session.ws = null;

  // Snapshot the generation at the time we start the timer.
  const generationAtStart = session.connectionGeneration;

  if (session.recoveryTimer !== null) {
    clearTimeout(session.recoveryTimer);
  }

  session.recoveryTimer = setTimeout(() => {
    const current = sessionsBySessionId.get(sessionId);
    if (!current) return;
    // Only finalise if state is still "recovering" AND generation hasn't
    // changed (i.e. reclaimSession() hasn't already run).
    if (
      current.state === "recovering" &&
      current.connectionGeneration === generationAtStart
    ) {
      finalise(sessionId, "recovery_timeout");
    }
  }, 60_000);

  appendLog(session, "CALL_RECOVERING", `gen=${session.connectionGeneration}`);
}

/**
 * Permanently close and remove a session.
 * Clears the recovery timer, removes from both maps, and logs CALL_ENDED.
 * Safe to call multiple times (idempotent via map removal).
 */
export function finalise(sessionId: string, reason: string): void {
  const session = sessionsBySessionId.get(sessionId);
  if (!session) return;

  session.state = "closed";

  if (session.recoveryTimer !== null) {
    clearTimeout(session.recoveryTimer);
    session.recoveryTimer = null;
  }

  sessionsBySessionId.delete(sessionId);
  sessionIdByDeviceId.delete(session.deviceId);

  appendLog(session, "CALL_ENDED", `reason=${reason}`);
}

/**
 * Increment and return the session's sequence number.
 */
export function incrementSequence(session: VoiceSession): number {
  session.sequenceNumber += 1;
  return session.sequenceNumber;
}

/**
 * Validate that an incoming message belongs to the current session
 * generation. Returns false (and logs) for stale messages without throwing.
 */
export function validateMessage(
  session: VoiceSession,
  msg: { sessionId: string; connectionGeneration: number },
): boolean {
  if (msg.sessionId !== session.sessionId) {
    appendLog(
      session,
      "VALIDATE_FAIL",
      `sessionId mismatch: got=${msg.sessionId}`,
    );
    return false;
  }
  if (msg.connectionGeneration < session.connectionGeneration) {
    appendLog(
      session,
      "VALIDATE_STALE",
      `gen: got=${msg.connectionGeneration} current=${session.connectionGeneration}`,
    );
    return false;
  }
  return true;
}

/**
 * Cancel the current in-flight turn atomically and idempotently.
 * Safe to call multiple times — clears ownership fields and aborts the
 * AbortController if one is set. Never throws.
 */
export function cancelCurrentTurn(
  session: VoiceSession,
  reason: string,
): void {
  const hadTurn = session.currentTurnId !== null;

  // Clear ownership fields first so any concurrent callbacks that check
  // them see null before the AbortController fires.
  session.currentSpeechId = null;
  session.currentTurnId = null;
  session.currentResponseId = null;

  // Abort any active controller. AbortController.abort() is safe to call
  // multiple times; the second call is a no-op.
  if (session.currentAbortController !== null) {
    try {
      session.currentAbortController.abort();
    } catch {
      // abort() never throws in practice, but guard anyway.
    }
    session.currentAbortController = null;
  }

  if (hadTurn) {
    appendLog(session, "TURN_CANCELLED", `reason=${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Convenience: export the registry as a namespace-style object so callers
// can do: import * as registry from "./VoiceSessionRegistry"
// ---------------------------------------------------------------------------
export const registry = {
  create,
  findByDeviceId,
  findBySessionId,
  reclaimSession,
  markRecovering,
  finalise,
  incrementSequence,
  validateMessage,
  cancelCurrentTurn,
};
