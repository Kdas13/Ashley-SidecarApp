// ---------------------------------------------------------------------------
// VoiceOrchestrationService.ts — P1-4: 8-stage voice orchestration pipeline.
//
// Entry points (called from routes/voice-call.ts and index.ts):
//   startOrchestration(session, ws)  — starts zombie cleanup for the session
//   handleSpeechInterim(session, t, ws) — Stage 2: intent pre-classification
//   handleSpeechFinal(session, t, uid, ws) — Stages 3-7: full turn pipeline
//   handleReconnect(session, ws)     — Stage 8B: reconnect acknowledgment
//   abortCurrentOutputs(session)     — shared abort helper
//
// Does NOT import from routes/voice-call.ts — avoids circular dependency.
// Silence monitor and farewell logic remain in routes/voice-call.ts.
// ---------------------------------------------------------------------------

import { db, messagesTable, callSummariesTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { streamChatText, generateChatText } from "./textLLM.js";
import { streamSpeechElevenLabs } from "./elevenlabsStream.js";
import * as registry from "./VoiceSessionRegistry.js";
import type { VoiceSession, WsLike } from "./VoiceSessionRegistry.js";
import { PersistentSessionStateGuard } from "./PersistentSessionStateGuard.js";
import { classify, isDirectQuestion } from "./VoiceIntentClassifier.js";
import type { CommandType } from "./VoiceIntentClassifier.js";
import { VoiceContextAssembler } from "./VoiceContextAssembler.js";
import { getClipBuffer, hasClip } from "./AudioClipRegistry.js";
import type { ClipName } from "./AudioClipRegistry.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VOICE_MAX_TOKENS                = 1_024;
const FIRST_TOKEN_WATCHDOG_MS         = 8_000;
const MAX_TURN_BUDGET_MS              = 45_000;
const ROLLING_AUDIO_BUFFER_MAX_BYTES  = 960_000;
const CONCURRENT_TTS_POOL_LIMIT       = 2;
const TTS_POOL_RETRY_MS               = 50;
const ZOMBIE_CLEANUP_INTERVAL_MS      = 15_000;
const ZOMBIE_TIMEOUT_MS               = 90_000;

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

// One cleanup interval per session (keyed by sessionId).
const zombieHandles = new Map<string, NodeJS.Timeout>();

// Global TTS concurrency pool.
let ttsInFlight = 0;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function stripMarkdown(text: string): string {
  return text
    .replace(/\*[^*\n]+\*/g, "")
    .replace(/_[^_\n]+_/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^[-–•]\s+/gm, "")
    .replace(/^\d+\.\s+/gm, "")
    .replace(/\*+/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Extract the first complete sentence from buffer. Returns null if none. */
function extractSentence(buf: string): { sentence: string; remainder: string } | null {
  const m = /^([\s\S]+?[.!?])(?:\s+)([\s\S]*)$/.exec(buf);
  if (!m) return null;
  return { sentence: m[1].trim(), remainder: m[2] };
}

async function waitForTtsSlot(): Promise<void> {
  while (ttsInFlight >= CONCURRENT_TTS_POOL_LIMIT) {
    await new Promise<void>((r) => setTimeout(r, TTS_POOL_RETRY_MS));
  }
  ttsInFlight++;
}

function releaseTtsSlot(): void {
  ttsInFlight = Math.max(0, ttsInFlight - 1);
}

function appendToRollingBuffer(session: VoiceSession, chunk: Buffer): void {
  const combined = Buffer.concat([session.rollingAudioBuffer, chunk]);
  if (combined.byteLength > ROLLING_AUDIO_BUFFER_MAX_BYTES) {
    // Keep the tail (most recent audio).
    session.rollingAudioBuffer = combined.slice(
      combined.byteLength - ROLLING_AUDIO_BUFFER_MAX_BYTES,
    );
  } else {
    session.rollingAudioBuffer = combined;
  }
}

/** Persist a message row fire-and-forget. Errors are logged but never thrown. */
function persistMessage(
  deviceId: string,
  role: string,
  content: string,
  createdAt: Date,
): void {
  void (async () => {
    try {
      await db.insert(messagesTable).values({
        id: crypto.randomUUID(),
        deviceId,
        role,
        content,
        status: "complete",
        source: "voice_call",
        createdAt,
      });
    } catch (err) {
      logger.error({ err, deviceId, role }, "VoiceOrch: persistMessage failed");
    }
  })();
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

/**
 * Send a pre-generated audio clip if available, otherwise synthesise the
 * fallback text via ElevenLabs. Both paths are best-effort — errors logged,
 * not thrown.
 *
 * kind: "main"      — treated as part of the main conversation turn lifecycle
 *                     (tts_done opens the mic via the safety path).  Use for
 *                     error-recovery clips (say-that-again, call-dropped).
 * kind: "auxiliary" — isolated from the main lifecycle; client plays audio
 *                     through a separate path that does not touch
 *                     ttsServerDoneRef / responseEndReceivedRef / phase.
 *                     Use for mid-turn filler clips (thinking watchdog).
 *
 * This function never touches session.currentSpeechId — it uses a locally-
 * scoped clipSpeechId so the main turn's speechId ownership is undisturbed.
 */
async function speakClipOrText(
  session: VoiceSession,
  clipName: ClipName,
  fallbackText: string,
  kind: "main" | "auxiliary" = "auxiliary",
): Promise<void> {
  if (!session.ws) return;
  if (
    session.state === "closed" ||
    session.state === "failed" ||
    session.state === "closing"
  )
    return;

  // Locally-scoped ID — never written to session.currentSpeechId.
  // The main turn's speechId ownership is completely undisturbed.
  const clipSpeechId = crypto.randomUUID();

  // speech_start tells the client a new audio unit is starting and what kind
  // it is. kind="auxiliary" → client routes to its isolated aux player and does
  // not reset any main lifecycle refs. kind="main" → normal lifecycle reset.
  try {
    session.ws.send(JSON.stringify({
      type:                "speech_start",
      kind,
      speechId:             clipSpeechId,
      sessionId:            session.sessionId,
      connectionGeneration: session.connectionGeneration,
      sequenceNumber:       registry.incrementSequence(session),
      timestamp:            Date.now(),
    }));
  } catch {
    return;
  }

  let sentChunks = 0;

  if (hasClip(clipName)) {
    try {
      session.ws.send(getClipBuffer(clipName));
      sentChunks = 1;
    } catch (err) {
      logger.warn({ err, clipName }, "VoiceOrch: failed to send clip buffer");
    }
  } else {
    // Text TTS fallback.
    try {
      for await (const chunk of streamSpeechElevenLabs(fallbackText)) {
        if (!session.ws) break;
        try {
          session.ws.send(chunk);
          sentChunks++;
        } catch {
          break;
        }
      }
    } catch {
      // ignore TTS errors for fallback clips
    }
  }

  // sentence_end flushes the client's chunk buffer so the clip plays promptly
  // rather than sitting buffered until the next boundary signal.
  if (sentChunks > 0 && session.ws) {
    try {
      session.ws.send(JSON.stringify({
        type:      "sentence_end",
        kind,
        speechId:  clipSpeechId,
        timestamp: Date.now(),
      }));
    } catch {}
  }

  // tts_done signals end of this audio unit.
  // For kind="main": client sets ttsServerDoneRef=true and opens mic via safety path.
  // For kind="auxiliary": client ignores for main lifecycle, restores context to "main".
  if (session.ws) {
    try {
      session.ws.send(JSON.stringify({
        type:                "tts_done",
        kind,
        speechId:             clipSpeechId,
        sessionId:            session.sessionId,
        connectionGeneration: session.connectionGeneration,
        sequenceNumber:       registry.incrementSequence(session),
        timestamp:            Date.now(),
      }));
    } catch {}
  }
}

/**
 * Stream one TTS sentence to the client and append audio to rolling buffer.
 * Respects speechId ownership — breaks out if cancelled mid-stream.
 */
async function flushSentenceToTTS(
  session: VoiceSession,
  speechId: string,
  sentence: string,
): Promise<void> {
  if (!sentence || session.currentSpeechId !== speechId || !session.ws) return;

  await waitForTtsSlot();
  let sentChunks = 0;
  try {
    for await (const chunk of streamSpeechElevenLabs(sentence)) {
      if (session.currentSpeechId !== speechId || !session.ws) break;
      appendToRollingBuffer(session, chunk);
      try {
        session.ws.send(chunk);
        sentChunks++;
      } catch {
        break;
      }
    }
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      logger.warn(
        { err, sessionId: session.sessionId },
        "VoiceOrch: TTS sentence failed — skipping",
      );
    }
  } finally {
    releaseTtsSlot();
  }

  // Signal sentence boundary so the client can play each sentence as it
  // completes rather than buffering the full turn.
  if (sentChunks > 0 && session.currentSpeechId === speechId && session.ws) {
    try {
      session.ws.send(
        JSON.stringify({ type: "sentence_end", kind: "main", speechId, timestamp: Date.now() }),
      );
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

export function abortCurrentOutputs(session: VoiceSession): void {
  session.llmStreamActive = false;
  registry.cancelCurrentTurn(session, "orchestration_abort");
  session.currentSpeechId = null;
  if (
    session.state !== "closed" &&
    session.state !== "failed" &&
    session.state !== "closing"
  ) {
    session.state = "listening";
  }
}

/**
 * Called when the client sends { type: "playback_confirmed" }.
 * Gated on responseComplete — ignores stale confirmations sent before
 * response_end was received by the client. Sends tts_done and processes
 * any queued utterance.
 */
export function handlePlaybackConfirmed(session: VoiceSession): void {
  if (!session.responseComplete) {
    logger.warn(
      { sessionId: session.sessionId },
      "VoiceOrch: playback_confirmed received before response_end — ignoring",
    );
    return;
  }

  if (!session.awaitingPlaybackConfirm) {
    logger.warn(
      { sessionId: session.sessionId },
      "VoiceOrch: unexpected playback_confirmed — not awaiting confirmation",
    );
    return;
  }

  // Clear the safety timeout.
  if (session.playbackConfirmTimeout) {
    clearTimeout(session.playbackConfirmTimeout);
    session.playbackConfirmTimeout = null;
  }

  session.awaitingPlaybackConfirm = false;
  session.responseComplete = false;

  // Now send tts_done — client has confirmed audio has finished playing.
  const seqDone = registry.incrementSequence(session);
  try {
    session.ws?.send(
      JSON.stringify({
        type:                "tts_done",
        kind:                "main",
        speechId:             session.currentSpeechId,
        responseText:         session.currentResponseText,
        sessionId:            session.sessionId,
        connectionGeneration: session.connectionGeneration,
        sequenceNumber:       seqDone,
        timestamp:            Date.now(),
      }),
    );
  } catch {}

  session.currentSpeechId = null;
  session.state = "listening";

  logger.info(
    { sessionId: session.sessionId },
    "VoiceOrch: playback confirmed — tts_done sent — session listening",
  );

  // Process any queued utterance that arrived during playback.
  if (session.pendingUtterance && session.pendingUtteranceId) {
    const u = session.pendingUtterance;
    const uid = session.pendingUtteranceId;
    session.pendingUtterance = null;
    session.pendingUtteranceId = null;
    void handleSpeechFinal(session, u, uid).catch((err) => {
      logger.error({ err, sessionId: session.sessionId }, "VoiceOrch: queued utterance failed");
    });
  }
}

// ---------------------------------------------------------------------------
// Interruption (Stage 8A)
// ---------------------------------------------------------------------------

function handleInterruption(session: VoiceSession): void {
  session.wasInterrupted    = true;
  session.interruptedAt     = session.currentResponseText.length;
  session.remainingResponse = session.currentResponseText.slice(session.interruptedAt);
  abortCurrentOutputs(session);
  try {
    session.ws?.send(JSON.stringify({ type: "STOP_AUDIO_PLAYBACK_IMMEDIATE" }));
  } catch {}
  logger.info(
    { sessionId: session.sessionId },
    "VoiceOrch: interruption handled",
  );
}

// ---------------------------------------------------------------------------
// Command + Repeat handlers
// ---------------------------------------------------------------------------

async function handleCommand(
  session: VoiceSession,
  command: CommandType,
): Promise<void> {
  switch (command) {
    case "stop":
      abortCurrentOutputs(session);
      break;

    case "end_call":
      abortCurrentOutputs(session);
      try {
        session.ws?.send(
          JSON.stringify({ type: "CALL_TERMINATED_BY_COMMAND" }),
        );
      } catch {}
      registry.finalise(session.sessionId, "user_command_end");
      break;

    case "go_quiet":
      session.passiveMode = true;
      logger.info({ sessionId: session.sessionId }, "VoiceOrch: passive mode ON");
      break;
  }
}

async function handleRepeatRequest(session: VoiceSession): Promise<void> {
  if (session.wasInterrupted || session.rollingAudioBuffer.byteLength === 0) {
    await speakClipOrText(
      session,
      "say-that-again",
      "Sorry, say that again?",
      "main",
    );
    return;
  }
  // Replay last TTS audio.
  try {
    session.ws?.send(session.rollingAudioBuffer);
  } catch (err) {
    logger.warn({ err, sessionId: session.sessionId }, "VoiceOrch: repeat replay failed");
    await speakClipOrText(session, "say-that-again", "Sorry, say that again?", "main");
  }
}

// ---------------------------------------------------------------------------
// Core LLM + sentence-boundary TTS pipeline
// ---------------------------------------------------------------------------

async function runLLMAndTTSPipeline(
  session: VoiceSession,
  utterance: string,
  isDirectQuestion: boolean,
): Promise<void> {
  const turnId   = crypto.randomUUID();
  const speechId = crypto.randomUUID();

  // Capture interruption state before resetting.
  const wasInterrupted    = session.wasInterrupted;
  const remainingResponse = session.remainingResponse;

  session.currentTurnId       = turnId;
  session.currentResponseId   = crypto.randomUUID();
  session.currentResponseText = "";
  session.llmStreamActive     = true;
  session.state               = "llm_pending";
  session.wasInterrupted      = false;
  session.remainingResponse   = null;
  session.interruptedAt       = null;
  session.responseComplete    = false;

  // P1-1: persist turn start.
  PersistentSessionStateGuard.queue({
    sessionId:            session.sessionId,
    deviceId:             session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state:                session.state,
    currentTurnId:        session.currentTurnId,
    currentResponseId:    session.currentResponseId,
    callStartTime:        session.callStartTime,
    updatedAt:            new Date(),
  });

  // ── Stage 5: Context Assembly ──────────────────────────────────────────
  let ctx: { systemPrompt: string; messages: { role: "user" | "assistant"; content: string }[] };
  try {
    ctx = await VoiceContextAssembler.assemble({
      sessionId:       session.sessionId,
      deviceId:        session.deviceId,
      callStartTime:   session.callStartTime,
      currentUtterance: utterance,
      reconnectCount:  session.reconnectAttempts,
      isDirectQuestion,
      wasInterrupted,
      remainingResponse,
      passiveMode:     session.passiveMode,
    });
    session.consecutiveContextFailures = 0;
  } catch (err) {
    session.consecutiveContextFailures++;
    logger.error(
      { err, sessionId: session.sessionId, turnId },
      "VoiceOrch: context assembly failed",
    );
    session.llmStreamActive = false;
    session.state           = "listening";

    if (session.consecutiveContextFailures >= 2) {
      try {
        session.ws?.send(
          JSON.stringify({ type: "call_ended", reason: "context_load_failed" }),
        );
      } catch {}
      registry.finalise(session.sessionId, "context_load_failed");
    } else {
      await speakClipOrText(
        session,
        "say-that-again",
        "Sorry, I lost my thread for a second. Try that again?",
        "main",
      );
    }
    return;
  }

  // ── Send speech_start ──────────────────────────────────────────────────
  session.currentSpeechId = speechId;
  session.state           = "tts_streaming";

  const seqStart = registry.incrementSequence(session);
  try {
    session.ws?.send(
      JSON.stringify({
        type:                "speech_start",
        kind:                "main",
        speechId,
        sessionId:            session.sessionId,
        connectionGeneration: session.connectionGeneration,
        sequenceNumber:       seqStart,
        timestamp:            Date.now(),
      }),
    );
  } catch (err) {
    logger.warn({ err, sessionId: session.sessionId }, "VoiceOrch: failed to send speech_start");
    session.llmStreamActive = false;
    session.state           = "listening";
    session.currentSpeechId = null;
    return;
  }

  // ── Stage 6: LLM streaming with watchdogs ──────────────────────────────
  const controller = new AbortController();
  session.currentAbortController = controller;

  let firstTokenReceived         = false;
  let firstTokenWatchdog: NodeJS.Timeout | null = null;

  const hardBudget = setTimeout(() => {
    if (session.currentAbortController === controller) {
      logger.warn({ sessionId: session.sessionId, turnId }, "VoiceOrch: hard budget exceeded — aborting");
      registry.cancelCurrentTurn(session, "hard_budget_exceeded");
      session.llmStreamActive = false;

      // Notify the client immediately so it re-enters listening state rather
      // than hanging indefinitely while the LLM stream drains its abort.
      if (session.currentSpeechId === speechId) {
        const seqBudget = registry.incrementSequence(session);
        try {
          session.ws?.send(
            JSON.stringify({
              type:                "tts_done",
              kind:                "main",
              speechId,
              responseText:         session.currentResponseText ?? "",
              sessionId:            session.sessionId,
              connectionGeneration: session.connectionGeneration,
              sequenceNumber:       seqBudget,
              timestamp:            Date.now(),
              reason:               "budget_exceeded",
            }),
          );
        } catch {}
        session.currentSpeechId = null;
      }
    }
  }, MAX_TURN_BUDGET_MS);

  firstTokenWatchdog = setTimeout(() => {
    if (!firstTokenReceived && session.currentTurnId === turnId) {
      logger.info({ sessionId: session.sessionId, turnId }, "VoiceOrch: first-token watchdog — playing thinking clip");
      void speakClipOrText(session, "thinking", "Hang on, I'm thinking...", "auxiliary");
    }
  }, FIRST_TOKEN_WATCHDOG_MS);

  let sentenceBuffer = "";

  try {
    const stream = streamChatText({
      system:        ctx.systemPrompt,
      messages:      ctx.messages,
      maxTokens:     VOICE_MAX_TOKENS,
      forceProvider: "gemini",
      signal:        controller.signal,
    });

    for await (const chunk of stream) {
      // Bail if the turn was cancelled (interrupt or abort).
      if (session.currentTurnId !== turnId || !session.llmStreamActive) break;

      if (!firstTokenReceived) {
        firstTokenReceived = true;
        if (firstTokenWatchdog) {
          clearTimeout(firstTokenWatchdog);
          firstTokenWatchdog = null;
        }
      }

      session.currentResponseText += chunk;
      sentenceBuffer              += chunk;

      // Stage 7: flush complete sentences to TTS as they arrive.
      let extracted = extractSentence(sentenceBuffer);
      while (extracted) {
        if (session.currentSpeechId !== speechId) break;
        const { sentence, remainder } = extracted;
        sentenceBuffer = remainder;
        const clean = stripMarkdown(sentence);
        if (clean) {
          await flushSentenceToTTS(session, speechId, clean);
        }
        extracted = extractSentence(sentenceBuffer);
      }
    }

    // Flush any trailing partial sentence.
    const trail = sentenceBuffer.trim();
    if (trail && session.currentSpeechId === speechId) {
      await flushSentenceToTTS(session, speechId, stripMarkdown(trail));
    }
  } catch (err: unknown) {
    // Treat both the Web standard AbortError and the Anthropic SDK's
    // APIUserAbortError as expected cancellations (budget exceeded, interrupt).
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "APIUserAbortError");
    if (!isAbort) {
      logger.error({ err, sessionId: session.sessionId, turnId }, "VoiceOrch: LLM stream error");
      await speakClipOrText(
        session,
        "say-that-again",
        "Sorry, I've lost my train of thought. What were you saying?",
        "main",
      );
    }
  } finally {
    clearTimeout(hardBudget);
    if (firstTokenWatchdog) clearTimeout(firstTokenWatchdog);
    if (session.currentAbortController === controller) {
      session.currentAbortController = null;
    }
    session.llmStreamActive = false;
  }

  // ── Send response_end — explicit signal that all TTS chunks are dispatched ──
  // This is the authoritative "all audio sent" signal. The client MUST NOT
  // send playback_confirmed until it has received this. Replaces the old
  // implicit inference from queue drain state (the root cause of Issue 1).
  if (session.currentSpeechId === speechId) {
    session.responseComplete = true;
    const seqEnd = registry.incrementSequence(session);
    try {
      session.ws?.send(
        JSON.stringify({
          type:                "response_end",
          kind:                "main",
          speechId,
          responseText:         session.currentResponseText,
          sessionId:            session.sessionId,
          connectionGeneration: session.connectionGeneration,
          sequenceNumber:       seqEnd,
          timestamp:            Date.now(),
        }),
      );
    } catch (err) {
      logger.warn({ err, sessionId: session.sessionId }, "VoiceOrch: failed to send response_end");
    }

    session.awaitingPlaybackConfirm = true;

    // Safety timeout: starts alongside response_end. If playback_confirmed
    // does not arrive within 15 seconds, reset to listening to prevent hang.
    if (session.playbackConfirmTimeout) {
      clearTimeout(session.playbackConfirmTimeout);
    }
    session.playbackConfirmTimeout = setTimeout(() => {
      if (session.awaitingPlaybackConfirm && session.currentSpeechId === speechId) {
        logger.warn(
          { sessionId: session.sessionId },
          "VoiceOrch: playback_confirmed not received within 15s — resetting to listening",
        );
        session.awaitingPlaybackConfirm = false;
        session.responseComplete = false;
        session.playbackConfirmTimeout = null;
        session.currentSpeechId = null;
        session.state = "listening";

        // If a speech_final arrived during the wait, process it now.
        if (session.pendingUtterance && session.pendingUtteranceId) {
          const u = session.pendingUtterance;
          const uid = session.pendingUtteranceId;
          session.pendingUtterance = null;
          session.pendingUtteranceId = null;
          void handleSpeechFinal(session, u, uid).catch((err) => {
            logger.error({ err, sessionId: session.sessionId }, "VoiceOrch: pending utterance from safety timeout failed");
          });
        }
      }
    }, 15_000);
  }

  // Store last response for REPEAT_REQUEST.
  session.lastResponseBuffer = session.currentResponseText;

  // Persist assistant row (fire-and-forget).
  if (session.currentResponseText.trim() && !session.completedTurnIds.has(turnId)) {
    session.completedTurnIds.add(turnId);
    persistMessage(session.deviceId, "ashley", session.currentResponseText, new Date());
  }

  session.state         = "listening";
  session.currentTurnId = null;
  session.currentResponseId = null;
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Start zombie cleanup for a session. Called once per connection (new or
 * reclaimed). The interval self-clears when the session leaves the registry.
 */
export function startOrchestration(session: VoiceSession, ws: WsLike): void {
  // Clear any stale handle for this session (e.g., rapid reconnect).
  const existing = zombieHandles.get(session.sessionId);
  if (existing) clearInterval(existing);

  const handle = setInterval(() => {
    const live = registry.findBySessionId(session.sessionId);
    if (!live) {
      clearInterval(handle);
      zombieHandles.delete(session.sessionId);
      return;
    }

    const elapsed = Date.now() - live.lastActiveHeartbeatAt.getTime();
    if (elapsed > ZOMBIE_TIMEOUT_MS) {
      logger.warn(
        { sessionId: live.sessionId, elapsedMs: elapsed },
        "VoiceOrch: zombie session detected — closing",
      );
      try {
        ws.close();
      } catch {}
      registry.finalise(live.sessionId, "zombie_cleanup");
      clearInterval(handle);
      zombieHandles.delete(live.sessionId);
    }
  }, ZOMBIE_CLEANUP_INTERVAL_MS);

  zombieHandles.set(session.sessionId, handle);
}

/**
 * Stage 2: Handle a speech_interim message.
 * Runs intent pre-classification; sends set_silence_threshold to client if
 * a direct question is detected. Does NOT trigger LLM or TTS.
 */
export function handleSpeechInterim(
  session: VoiceSession,
  transcript: string,
  ws: WsLike,
): void {
  // Update heartbeat.
  session.lastActiveHeartbeatAt = new Date();

  // Stage 8A: interruption check.
  if (session.llmStreamActive || session.state === "tts_streaming") {
    handleInterruption(session);
  }

  const result = classify(transcript.trim());

  if (result.category === "DIRECT_QUESTION" && !session.intentDetected) {
    session.intentDetected   = true;
    session.silenceThreshold = 800;
    try {
      ws.send(JSON.stringify({ type: "set_silence_threshold", ms: 800 }));
    } catch {}
  }
}

/**
 * Stage 3-7: Handle a speech_final message — the full turn pipeline.
 * Called from handleVoiceTurn in routes/voice-call.ts.
 */
export async function handleSpeechFinal(
  session: VoiceSession,
  transcript: string,
  utteranceId: string,
): Promise<void> {
  // Update heartbeat.
  session.lastActiveHeartbeatAt = new Date();

  // Playback guard: if awaiting client playback confirmation, queue this
  // utterance and return. Only one utterance queued at a time — if a second
  // arrives, it replaces the first (Kane is still speaking, keep the latest).
  if (session.awaitingPlaybackConfirm) {
    logger.info(
      { sessionId: session.sessionId, utteranceId },
      "VoiceOrch: speech_final queued — awaiting playback_confirmed",
    );
    session.pendingUtterance = transcript;
    session.pendingUtteranceId = utteranceId;
    return;
  }

  // Stage 8A: interruption check.
  if (session.llmStreamActive || session.state === "tts_streaming") {
    handleInterruption(session);
  }

  // Stage 3: normalise.
  const utterance = transcript.replace(/\s+/g, " ").trim();
  if (!utterance) {
    session.intentDetected   = false;
    session.silenceThreshold = 3500;
    return;
  }

  // Reset turn detection state.
  session.intentDetected   = false;
  session.silenceThreshold = 3500;

  // Stage 4: classify.
  const result = classify(utterance);

  if (result.category === "EMPTY") return;

  if (result.category === "COMMAND") {
    await handleCommand(session, result.command!);
    return;
  }

  if (result.category === "REPEAT_REQUEST") {
    await handleRepeatRequest(session);
    return;
  }

  // Passive mode gate.
  if (session.passiveMode) {
    if (result.category === "CONVERSATIONAL") {
      logger.info(
        { sessionId: session.sessionId },
        "VoiceOrch: passive mode — CONVERSATIONAL discarded",
      );
      return;
    }
    if (result.category === "DIRECT_QUESTION") {
      session.passiveMode = false;
    }
  }

  // Send intent-based silence threshold to client BEFORE starting the LLM
  // pipeline so it is applied to the NEXT listen window (after Ashley speaks).
  if (isDirectQuestion(utterance)) {
    try {
      session.ws?.send(JSON.stringify({ type: "set_silence_threshold", ms: 800 }));
    } catch { /* ignore send failures */ }
  }

  // Persist user utterance (fire-and-forget) before LLM call.
  // Dedup guard: suppress writes within 500ms of the previous to backstop echo turns.
  const nowMs = Date.now();
  if (
    session.lastUserMessageAt !== null &&
    nowMs - session.lastUserMessageAt.getTime() < 500
  ) {
    logger.warn(
      { sessionId: session.sessionId },
      "VoiceOrch: rapid user message write (<500ms) — possible echo turn, skipping persist",
    );
  } else {
    session.lastUserMessageAt = new Date();
    persistMessage(session.deviceId, "user", utterance, new Date());
  }

  // Stages 5-7: context → LLM → TTS.
  await runLLMAndTTSPipeline(
    session,
    utterance,
    result.category === "DIRECT_QUESTION",
  );
}

/**
 * Stage 8B: Reconnect acknowledgment.
 * Called from index.ts after a session is successfully reclaimed.
 * Plays a natural reconnect acknowledgment using call summary context if
 * available, otherwise plays the pre-generated 'call-dropped' clip.
 */
export async function handleReconnect(
  session: VoiceSession,
  ws: WsLike,
): Promise<void> {
  // Update heartbeat.
  session.lastActiveHeartbeatAt = new Date();

  // Look for a committed summary for this session.
  let summaryText: string | null = null;
  let topic: string | null = null;
  try {
    const rows = await db
      .select({
        summaryText: callSummariesTable.summaryText,
        topic:       callSummariesTable.topic,
      })
      .from(callSummariesTable)
      .where(
        and(
          eq(callSummariesTable.sessionId, session.sessionId),
          eq(callSummariesTable.status, "committed"),
        ),
      )
      .orderBy(desc(callSummariesTable.createdAt))
      .limit(1);

    if (rows.length > 0) {
      summaryText = rows[0].summaryText;
      topic       = rows[0].topic ?? null;
    }
  } catch (err) {
    logger.warn({ err, sessionId: session.sessionId }, "VoiceOrch: handleReconnect — summary query failed");
  }

  if (!summaryText) {
    // No summary — play the pre-generated clip.
    await speakClipOrText(
      session,
      "call-dropped",
      "Sorry about that — looks like we dropped. Where were we?",
      "main",
    );
    return;
  }

  // Generate a natural reconnect acknowledgment via LLM.
  const topicRef  = topic ?? "our conversation";
  const systemPrompt =
    `You are Ashley, a personal AI companion in the middle of a voice call. ` +
    `The call just dropped and has reconnected. Acknowledge this naturally and warmly — ` +
    `something like "oh sorry, looks like I lost signal — where were we? We were talking about ${topicRef}..." ` +
    `Use the summary below to orient yourself. Be natural, not robotic. One or two sentences only. ` +
    `Summary of the call so far: ${summaryText}`;

  try {
    const controller = new AbortController();
    session.currentAbortController = controller;

    const stream = streamChatText({
      system:        systemPrompt,
      messages:      [],
      maxTokens:     256,
      forceProvider: "anthropic",
      signal:        controller.signal,
    });

    let reconnectText = "";
    for await (const chunk of stream) {
      reconnectText += chunk;
    }

    if (reconnectText.trim()) {
      const speechId = crypto.randomUUID();
      session.currentSpeechId = speechId;

      const seqStart = registry.incrementSequence(session);
      try {
        ws.send(
          JSON.stringify({
            type:                "speech_start",
            kind:                "main",
            speechId,
            sessionId:            session.sessionId,
            connectionGeneration: session.connectionGeneration,
            sequenceNumber:       seqStart,
            timestamp:            Date.now(),
          }),
        );
      } catch {}

      await flushSentenceToTTS(session, speechId, stripMarkdown(reconnectText));

      if (session.currentSpeechId === speechId) {
        const seqDone = registry.incrementSequence(session);
        try {
          ws.send(
            JSON.stringify({
              type:                "tts_done",
              kind:                "main",
              speechId,
              sessionId:            session.sessionId,
              connectionGeneration: session.connectionGeneration,
              sequenceNumber:       seqDone,
              timestamp:            Date.now(),
            }),
          );
        } catch {}
        session.currentSpeechId = null;
      }
    } else {
      await speakClipOrText(session, "call-dropped", "Sorry about that — looks like we dropped. Where were we?", "main");
    }
  } catch (err) {
    logger.warn({ err, sessionId: session.sessionId }, "VoiceOrch: handleReconnect LLM failed — falling back to clip");
    await speakClipOrText(session, "call-dropped", "Sorry about that — looks like we dropped. Where were we?", "main");
  } finally {
    if (session.currentAbortController) {
      session.currentAbortController = null;
    }
    session.state = "listening";
  }
}
