// ---------------------------------------------------------------------------
// VoiceSessionRegistry — Phase 1 voice call session state manager.
//                        P1-3 windowed reconnect counter (Phase 2).
//                        P1-1 + G-1 persistent session state (Phase 2).
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

import { PersistentSessionStateGuard } from "./PersistentSessionStateGuard";
import { CallSummarisationService } from "./CallSummarisationService";
import { db, activeSessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

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

  // P1-3: windowed reconnect tracking
  reconnectTimestamps: Date[];        // ring buffer, max 20 entries
  reconnectAttempts: number;          // diagnostic only — must NOT gate termination
  lastReconnectCause: "clean_close" | "network_drop" | "timeout" | null;

  // Context failure tracking (Checkpoint 1D)
  consecutiveContextFailures: number;

  // Recovery (F11)
  recoveryTimer: NodeJS.Timeout | null;

  // Silence lifecycle (1I)
  silenceTimer: NodeJS.Timeout | null;

  // Lifecycle logs
  log: Array<{ event: string; ts: Date; detail?: string }>;

  // P1-4: orchestration fields
  streamActive: boolean;
  lastActiveHeartbeatAt: Date;

  // Stage 2 — turn detection
  silenceStartedAt: Date | null;
  lastSpeechAt: Date | null;
  intentDetected: boolean;
  silenceThreshold: number;

  // Stage 4 — turn content
  lastResponseBuffer: string | null;
  passiveMode: boolean;

  // Stage 6 — LLM state
  currentResponseText: string;
  llmStreamActive: boolean;

  // Stage 8 — interruption
  wasInterrupted: boolean;
  interruptedAt: number | null;
  remainingResponse: string | null;

  // Stage 7 — audio
  rollingAudioBuffer: Buffer;

  // Stage 7 — playback confirmation handshake
  awaitingPlaybackConfirm: boolean;
  pendingUtterance: string | null;      // queued speech_final during playback
  pendingUtteranceId: string | null;    // utteranceId for the queued item
  playbackConfirmTimeout: NodeJS.Timeout | null;
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

    reconnectTimestamps: [],
    reconnectAttempts: 0,
    lastReconnectCause: null,
    consecutiveContextFailures: 0,

    recoveryTimer: null,
    silenceTimer: null,

    log: [],

    // P1-4: orchestration fields
    streamActive: false,
    lastActiveHeartbeatAt: new Date(),
    silenceStartedAt: null,
    lastSpeechAt: null,
    intentDetected: false,
    silenceThreshold: 3500,
    lastResponseBuffer: null,
    passiveMode: false,
    currentResponseText: "",
    llmStreamActive: false,
    wasInterrupted: false,
    interruptedAt: null,
    remainingResponse: null,
    rollingAudioBuffer: Buffer.alloc(0),
    awaitingPlaybackConfirm: false,
    pendingUtterance: null,
    pendingUtteranceId: null,
    playbackConfirmTimeout: null,
  };

  sessionsBySessionId.set(session.sessionId, session);
  sessionIdByDeviceId.set(deviceId, session.sessionId);

  appendLog(session, "CALL_CREATED", `deviceId=${deviceId}`);

  // P1-1: persist new session to DB (fire-and-forget, chained).
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: session.state,
    currentTurnId: null,
    currentResponseId: null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });

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

  // P1-3: push timestamp into ring buffer, cap at 20 entries.
  session.reconnectTimestamps.push(new Date());
  if (session.reconnectTimestamps.length > 20) {
    session.reconnectTimestamps.shift();
  }
  session.reconnectAttempts += 1; // diagnostic only

  appendLog(
    session,
    "CALL_RECONNECTED",
    `gen=${session.connectionGeneration} reconnects=${session.reconnectAttempts} cause=${session.lastReconnectCause ?? "unknown"}`,
  );

  // P1-1: persist reconnect state.
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: session.state,
    currentTurnId: session.currentTurnId ?? null,
    currentResponseId: session.currentResponseId ?? null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });

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

  // P1-1: persist recovering state.
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: "recovering",
    currentTurnId: session.currentTurnId ?? null,
    currentResponseId: session.currentResponseId ?? null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });
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

  if (session.silenceTimer !== null) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }

  sessionsBySessionId.delete(sessionId);
  sessionIdByDeviceId.delete(session.deviceId);

  appendLog(session, "CALL_ENDED", `reason=${reason}`);

  // P1-2: fire end-of-call summarisation. Must be fire-and-forget — the call
  // pipeline must never block on this. Pass deviceId + callStartTime so the
  // service can fetch turns from messagesTable (turns are not stored on session).
  CallSummarisationService.summariseCall(
    session.sessionId,
    session.deviceId,
    session.callStartTime,
  );

  // P1-1: persist terminal state then clear the chain.
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: "closed",
    currentTurnId: null,
    currentResponseId: null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });
  PersistentSessionStateGuard.clearChain(session.sessionId);
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
// P1-3 — Windowed reconnect rate limiter.
// ---------------------------------------------------------------------------

/**
 * Returns true if the session has exceeded the reconnect rate limit.
 *
 * Limit: 10 reconnects within any rolling 10-minute window.
 * Grace mode: if lastReconnectCause is 'network_drop', allow +5 (limit → 15).
 *
 * reconnectAttempts (lifetime counter) is intentionally NOT used here —
 * it is a diagnostic field only and must never gate termination.
 */
export function isReconnectRateLimited(session: VoiceSession): boolean {
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const cutoff = Date.now() - windowMs;

  const recentCount = session.reconnectTimestamps.filter(
    (ts) => ts.getTime() > cutoff,
  ).length;

  const limit = session.lastReconnectCause === "network_drop" ? 15 : 10;

  return recentCount >= limit;
}

// ---------------------------------------------------------------------------
// P1-1 — Boot recovery: reload 'recovering' sessions from DB into registry.
// ---------------------------------------------------------------------------

/**
 * Called once on server boot.
 * Loads any sessions with state = 'recovering' from DB back into registry.
 * Allows reconnecting clients to reclaim their session normally.
 *
 * P1-3: lastReconnectCause is set to 'network_drop' for all restored sessions
 * so they automatically enter grace mode (limit 15 instead of 10).
 */
export async function restoreRecoveringSessions(): Promise<void> {
  const rows = await db
    .select()
    .from(activeSessionsTable)
    .where(eq(activeSessionsTable.state, "recovering"));

  for (const row of rows) {
    const session: VoiceSession = {
      sessionId: row.sessionId,
      deviceId: row.deviceId,
      connectionGeneration: row.connectionGeneration,
      sequenceNumber: 0,
      state: "recovering",
      ws: null,

      currentSpeechId: null,
      currentTurnId: row.currentTurnId ?? null,
      currentResponseId: row.currentResponseId ?? null,
      currentAbortController: null,
      processedUtteranceIds: new Set(),
      completedTurnIds: new Set(),

      callStartTime: new Date(row.callStartTime),
      lastAudioReceivedAt: null,
      silenceWarningSent: false,

      totalTokensUsed: 0,
      totalTtsChars: 0,

      // P1-3: reset window — old timestamps no longer relevant after restart.
      // Cause set to 'network_drop' → grace mode (limit 15) automatically.
      reconnectTimestamps: [],
      reconnectAttempts: 0,
      lastReconnectCause: "network_drop",

      consecutiveContextFailures: 0,

      recoveryTimer: null,
      silenceTimer: null,

      log: [],

      // P1-4: orchestration fields
      streamActive: false,
      lastActiveHeartbeatAt: new Date(),
      silenceStartedAt: null,
      lastSpeechAt: null,
      intentDetected: false,
      silenceThreshold: 3500,
      lastResponseBuffer: null,
      passiveMode: false,
      currentResponseText: "",
      llmStreamActive: false,
      wasInterrupted: false,
      interruptedAt: null,
      remainingResponse: null,
      rollingAudioBuffer: Buffer.alloc(0),
      awaitingPlaybackConfirm: false,
      pendingUtterance: null,
      pendingUtteranceId: null,
      playbackConfirmTimeout: null,
    };

    sessionsBySessionId.set(session.sessionId, session);
    sessionIdByDeviceId.set(session.deviceId, session.sessionId);

    console.info(
      "[P1-1] Restored recovering session:",
      session.sessionId,
      "deviceId:",
      session.deviceId,
    );
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
  isReconnectRateLimited,
  restoreRecoveringSessions,
  sessionsBySessionId,
  sessionIdByDeviceId,
};
