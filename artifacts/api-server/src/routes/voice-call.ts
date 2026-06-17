// ---------------------------------------------------------------------------
// voice-call.ts — Phase 1 voice call turn pipeline.
//
// Owns: loadVoiceContext, VOICE_MODE_ADDENDUM, stripMarkdown, handleVoiceTurn.
//
// Checkpoint coverage:
//   1D — context reload + Claude call (this file)
//   1E — ElevenLabs streaming (wired into handleVoiceTurn in 1E)
//   1F — per-turn DB write (wired in 1F)
//   1G — interrupt handling (wired in 1G)
//
// TRAP 2: no session state in route closures — all state in VoiceSessionRegistry.
// TRAP 4: ANTHROPIC_CHAT_MODEL is never hardcoded — forceProvider resolves it.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import {
  messagesTable,
  memoriesTable,
  conversationSummariesTable,
} from "@workspace/db";
import { PersistentSessionStateGuard } from "../lib/PersistentSessionStateGuard";
import { eq, desc } from "drizzle-orm";
import { getOrCreateProfileFor } from "../lib/profile";
import { buildSystemPrompt } from "../lib/ashleyCoreSpec";
import { streamChatText, type LLMMessage } from "../lib/textLLM";
import { streamSpeechElevenLabs } from "../lib/elevenlabsStream";
import * as registry from "../lib/VoiceSessionRegistry";
import type { VoiceSession } from "../lib/VoiceSessionRegistry";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors HISTORY_WINDOW from chat.ts — must stay in sync. */
const HISTORY_WINDOW = 80;

/** Max tokens for a voice reply. Intentionally small — voice turns are brief. */
const VOICE_MAX_TOKENS = 1024;

/** Claude is aborted after this many ms with a spoken fallback. */
const CLAUDE_TIMEOUT_MS = 30_000;

// Silence lifecycle thresholds (1I)
const SILENCE_POLL_MS   =  5_000; // check every 5 seconds
const SILENCE_WARN_MS   = 30_000; // speak "still there?" after 30s
const SILENCE_END_MS    = 60_000; // farewell + finalise after 60s
const SILENCE_FORCE_MS  = 90_000; // failsafe force-close (no TTS)

// ---------------------------------------------------------------------------
// Voice mode addendum — appended to every voice turn system prompt.
// ---------------------------------------------------------------------------
export const VOICE_MODE_ADDENDUM = `
## Voice Call Mode
This is a live voice call. The user is speaking; you speak back via
text-to-speech.
- Keep each reply to 1-3 sentences unless the question requires more.
- No markdown. No bullet points. No asterisks. No numbered lists.
- Do not narrate actions in asterisks (*smiles*, *laughs*).
- Speak naturally — full sentences, not fragments.
- Do not mention you are an AI or that this is a voice call unless the
  user raises it.
`.trim();

// ---------------------------------------------------------------------------
// loadVoiceContext — replicates the exact Promise.all pattern from chat.ts.
// Context is loaded fresh on EVERY turn — never cached at call start.
// ---------------------------------------------------------------------------
export async function loadVoiceContext(deviceId: string) {
  const profile = await getOrCreateProfileFor(deviceId);

  const [memories, summaries, history] = await Promise.all([
    db
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.deviceId, deviceId)),
    db
      .select()
      .from(conversationSummariesTable)
      .where(eq(conversationSummariesTable.deviceId, deviceId)),
    // Most-recent HISTORY_WINDOW messages; reversed below to chronological order.
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.deviceId, deviceId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(HISTORY_WINDOW),
  ]);

  history.reverse(); // newest-last for the Claude prompt
  return { profile, memories, summaries, history };
}

// ---------------------------------------------------------------------------
// stripMarkdown — removes markdown syntax before sending text to TTS.
// ---------------------------------------------------------------------------
export function stripMarkdown(text: string): string {
  return (
    text
      // Stage directions: *smiles*, _nods_, etc.
      .replace(/\*[^*\n]+\*/g, "")
      .replace(/_[^_\n]+_/g, "")
      // Heading pound signs
      .replace(/^#{1,6}\s+/gm, "")
      // Bullet list hyphens / dashes at line start
      .replace(/^[-–•]\s+/gm, "")
      // Numbered lists
      .replace(/^\d+\.\s+/gm, "")
      // Remaining stray asterisks (bold/italic remnants)
      .replace(/\*+/g, "")
      // Collapse excess blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// speakFallback — send a short spoken fallback to the client using the TTS
// ownership protocol. Used for Claude timeout, Claude error, and context
// load failure. Safe to call after cancelCurrentTurn (currentSpeechId is
// null at that point — we assign our own speechId for the fallback).
// ---------------------------------------------------------------------------
async function speakFallback(
  session: VoiceSession,
  text: string,
): Promise<void> {
  if (
    session.state === "closed" ||
    session.state === "failed" ||
    session.state === "closing"
  )
    return;
  if (!session.ws) return;

  const speechId = crypto.randomUUID();
  session.currentSpeechId = speechId;

  const seqStart = registry.incrementSequence(session);
  try {
    session.ws.send(
      JSON.stringify({
        type: "speech_start",
        speechId,
        sessionId: session.sessionId,
        connectionGeneration: session.connectionGeneration,
        sequenceNumber: seqStart,
        timestamp: Date.now(),
      }),
    );
  } catch {
    session.currentSpeechId = null;
    return;
  }

  let sentChunks = 0;
  try {
    for await (const chunk of streamSpeechElevenLabs(text)) {
      if (session.currentSpeechId !== speechId) break;
      try {
        session.ws.send(chunk);
        sentChunks++;
      } catch {
        break;
      }
    }
  } catch {
    // ignore TTS errors for fallback messages
  }

  if (sentChunks > 0 && session.currentSpeechId === speechId) {
    const seqDone = registry.incrementSequence(session);
    try {
      session.ws.send(
        JSON.stringify({
          type: "tts_done",
          speechId,
          sessionId: session.sessionId,
          connectionGeneration: session.connectionGeneration,
          sequenceNumber: seqDone,
          timestamp: Date.now(),
        }),
      );
    } catch {}
  }

  session.currentSpeechId = null;
}

// ---------------------------------------------------------------------------
// speakFarewell — spoken goodbye + call_ended frame + session finalise.
// Called by the silence monitor on the 60s timeout.
// ---------------------------------------------------------------------------
async function speakFarewell(session: VoiceSession): Promise<void> {
  await speakFallback(
    session,
    "I'll let you go — call me back when you're ready.",
  );
  try {
    session.ws?.send(
      JSON.stringify({ type: "call_ended", reason: "silence_timeout" }),
    );
  } catch {}
  registry.finalise(session.sessionId, "silence_timeout");
}

// ---------------------------------------------------------------------------
// startSilenceMonitor — starts a recurring 5-second poll that enforces the
// silence lifecycle:
//
//   0–30s  listening, no audio  →  nothing
//   30s                         →  "still there?" (once only)
//   60s  (warning already sent) →  farewell TTS + call_ended + finalise
//   90s  (failsafe)             →  force-close without TTS
//
// The poll pauses automatically when state ≠ "listening" (the tick fires but
// does not measure silence while Claude or TTS is active). The timer is
// cancelled by registry.finalise() when the session closes.
//
// Must be called once per session from index.ts after call_connected is sent.
// ---------------------------------------------------------------------------
export function startSilenceMonitor(session: VoiceSession): void {
  // Clear any existing monitor (shouldn't happen, but safe).
  if (session.silenceTimer !== null) {
    clearTimeout(session.silenceTimer);
    session.silenceTimer = null;
  }

  function tick(): void {
    // Clear the handle so finalise() can tell the tick has started.
    // At the end of tick we check for null to decide whether to reschedule.
    session.silenceTimer = null;

    // Stop if the session is already gone.
    if (
      session.state === "closed" ||
      session.state === "failed" ||
      session.state === "closing"
    ) {
      return;
    }

    if (session.state === "listening" || session.state === "active") {
      // Reference: last real audio, or call start if no audio yet.
      const ref = session.lastAudioReceivedAt ?? session.callStartTime;
      const silenceMs = Date.now() - ref.getTime();

      if (silenceMs >= SILENCE_FORCE_MS) {
        // 90s failsafe — force close without TTS.
        logger.warn(
          { deviceId: session.deviceId, silenceMs },
          "voice: silence failsafe (90s) — force closing session",
        );
        try {
          session.ws?.send(
            JSON.stringify({ type: "call_ended", reason: "silence_timeout" }),
          );
        } catch {}
        session.silenceTimer = null;
        registry.finalise(session.sessionId, "silence_timeout_failsafe");
        return;
      }

      if (silenceMs >= SILENCE_END_MS && session.silenceWarningSent) {
        // 60s total silence after warning already sent — speak farewell.
        logger.info(
          { deviceId: session.deviceId, silenceMs },
          "voice: silence 60s — speaking farewell and ending call",
        );
        session.silenceTimer = null;
        void speakFarewell(session).catch((err) => {
          logger.error({ err, deviceId: session.deviceId }, "voice: speakFarewell failed");
          registry.finalise(session.sessionId, "silence_timeout");
        });
        return;
      }

      if (silenceMs >= SILENCE_WARN_MS && !session.silenceWarningSent) {
        // 30s silence — speak the "still there?" warning once.
        logger.info(
          { deviceId: session.deviceId, silenceMs },
          "voice: silence 30s — speaking warning",
        );
        session.silenceWarningSent = true;
        void speakFallback(session, "Still there?").catch((err) => {
          logger.error({ err, deviceId: session.deviceId }, "voice: silence warning TTS failed");
        });
      }
    }

    // All early-return paths above (force-close, farewell) already return before
    // reaching here, so unconditional reschedule is correct. The top of the next
    // tick catches any terminal state that arises between polls.
    session.silenceTimer = setTimeout(tick, SILENCE_POLL_MS);
  }

  session.silenceTimer = setTimeout(tick, SILENCE_POLL_MS);
  logger.info({ deviceId: session.deviceId }, "voice: silence monitor started");
}

// ---------------------------------------------------------------------------
// handleVoiceTurn — the speech_final → context → Claude → TTS pipeline.
//
// Returns { claudeText, stripped } on success, or null if the turn was
// cancelled / failed / produced empty output.
//
// Side effects:
//   - Mutates session.state, session.currentTurnId, etc.
//   - Logs timing milestones to session.log and server logger.
//   - Tracks consecutiveContextFailures; closes session at 2 failures.
//   - TTS (1E) and DB write (1F) are NOT wired here yet — stubs only.
// ---------------------------------------------------------------------------
export async function handleVoiceTurn(
  session: VoiceSession,
  transcript: string,
  utteranceId: string,
): Promise<{ claudeText: string; stripped: string; turnId: string } | null> {
  const turnId = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const turnStart = Date.now();

  // Assign ownership fields before any await so concurrent cancellation sees them.
  session.currentTurnId = turnId;
  session.currentResponseId = responseId;
  session.state = "llm_pending";

  // P1-1: persist turn start.
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: session.state,
    currentTurnId: session.currentTurnId,
    currentResponseId: null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });

  // P1-1: persist response start (both IDs now assigned).
  PersistentSessionStateGuard.queue({
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    connectionGeneration: session.connectionGeneration,
    state: session.state,
    currentTurnId: session.currentTurnId,
    currentResponseId: session.currentResponseId ?? null,
    callStartTime: session.callStartTime,
    updatedAt: new Date(),
  });

  // ── 0. Persist user row immediately on speech_final acceptance ─────────────
  // Captured before the first await so the timestamp is accurate even if
  // Claude takes many seconds to reply. Source="voice_call" on all rows.
  const utteranceTimestamp = new Date();
  void (async () => {
    try {
      await db.insert(messagesTable).values({
        id: crypto.randomUUID(),
        deviceId: session.deviceId,
        role: "user",
        content: transcript,
        status: "complete",
        source: "voice_call",
        createdAt: utteranceTimestamp,
      });
      logger.info(
        { deviceId: session.deviceId, turnId, utteranceId },
        "voice: user row persisted",
      );
    } catch (err) {
      logger.error({ err, deviceId: session.deviceId, turnId }, "voice: user row DB write failed — call continues");
    }
  })();

  // ── 1. Load context ────────────────────────────────────────────────────────
  const contextStart = Date.now();
  let contextResult: Awaited<ReturnType<typeof loadVoiceContext>>;

  try {
    contextResult = await loadVoiceContext(session.deviceId);
    session.consecutiveContextFailures = 0;
    const contextLoadMs = Date.now() - contextStart;
    session.log.push({
      event: "CONTEXT_LOADED",
      ts: new Date(),
      detail: `contextLoadMs=${contextLoadMs}`,
    });
    logger.info(
      { deviceId: session.deviceId, turnId, contextLoadMs },
      "voice: context loaded",
    );
  } catch (err) {
    session.consecutiveContextFailures += 1;
    logger.error(
      {
        err,
        deviceId: session.deviceId,
        turnId,
        consecutiveContextFailures: session.consecutiveContextFailures,
      },
      "voice: loadVoiceContext failed",
    );
    // Spoken fallback (TTS wired in 1E — log only for now).
    logger.info(
      "voice: [TTS fallback] 'Sorry, I lost my thread for a second. Try that again?'",
    );
    if (session.consecutiveContextFailures >= 2) {
      logger.warn(
        { deviceId: session.deviceId },
        "voice: 2 consecutive context failures — ending call",
      );
      try {
        session.ws?.send(
          JSON.stringify({ type: "call_ended", reason: "context_load_failed" }),
        );
      } catch {
        // ignore send errors
      }
      registry.finalise(session.sessionId, "context_load_failed");
    } else {
      session.state = "listening";
    }
    return null;
  }

  // ── 2. Build system prompt ─────────────────────────────────────────────────
  const { profile, memories, summaries, history } = contextResult;

  // voiceMode is read from profile.voiceMode in buildSystemPrompt.
  // We set it on a shallow copy — never write it back to the DB here.
  const voiceProfile = { ...profile, voiceMode: true };

  const systemPrompt = [
    buildSystemPrompt(voiceProfile, memories, summaries, {
      imageGenerationEnabled: false,
    }),
    VOICE_MODE_ADDENDUM,
  ].join("\n\n");

  // ── 3. Build Claude message array ─────────────────────────────────────────
  const claudeMessages: LLMMessage[] = [
    ...history.map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: transcript },
  ];

  logger.info(
    {
      deviceId: session.deviceId,
      turnId,
      utteranceId,
      historyLen: history.length,
      forceProvider: "anthropic",
    },
    "voice: CLAUDE_STARTED",
  );
  session.log.push({
    event: "CLAUDE_STARTED",
    ts: new Date(),
    detail: `turnId=${turnId} historyLen=${history.length}`,
  });

  // ── 4. Call Claude with 30-second AbortController ─────────────────────────
  const controller = new AbortController();
  session.currentAbortController = controller;

  const timeoutHandle = setTimeout(() => {
    if (session.currentAbortController === controller) {
      registry.cancelCurrentTurn(session, "claude_timeout");
      logger.warn(
        { deviceId: session.deviceId, turnId },
        "voice: Claude timed out — cancelling turn",
      );
      void speakFallback(
        session,
        "Sorry, I'm having trouble thinking right now. Try asking me again.",
      ).catch(() => {});
      session.state = "listening";
    }
  }, CLAUDE_TIMEOUT_MS);

  let claudeText = "";
  const claudeStart = Date.now();

  try {
    const stream = streamChatText({
      system: systemPrompt,
      messages: claudeMessages,
      maxTokens: VOICE_MAX_TOKENS,
      forceProvider: "anthropic",
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      // Drop stale chunks if the turn was cancelled mid-stream.
      if (session.currentTurnId !== turnId) {
        logger.info(
          { deviceId: session.deviceId, turnId },
          "voice: Claude stream abandoned — turn was cancelled",
        );
        return null;
      }
      claudeText += chunk;
    }
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      logger.error({ err, deviceId: session.deviceId, turnId }, "voice: Claude error");
      void speakFallback(
        session,
        "Sorry, I'm having trouble thinking right now. Try asking me again.",
      ).catch(() => {});
    }
    session.state = "listening";
    return null;
  } finally {
    clearTimeout(timeoutHandle);
    // Release the controller reference only if it's still ours.
    if (session.currentAbortController === controller) {
      session.currentAbortController = null;
    }
  }

  const claudeMs = Date.now() - claudeStart;
  session.log.push({
    event: "CLAUDE_FINISHED",
    ts: new Date(),
    detail: `ms=${claudeMs} chars=${claudeText.length}`,
  });
  logger.info(
    { deviceId: session.deviceId, turnId, claudeMs, claudeChars: claudeText.length },
    "voice: CLAUDE_FINISHED",
  );

  // ── 5. Guard: empty Claude output must not reach ElevenLabs ───────────────
  if (!claudeText.trim()) {
    logger.warn(
      { deviceId: session.deviceId, turnId },
      "voice: empty Claude output — skipping TTS",
    );
    session.state = "listening";
    return null;
  }

  // ── 6. Strip markdown before TTS ──────────────────────────────────────────
  const stripped = stripMarkdown(claudeText);

  // ── 7. ElevenLabs streaming with binary frame ownership protocol ───────────
  //
  // speechId uniquely identifies this audio stream so the client can match
  // binary frames to the correct "speech bubble". Per-chunk check discards
  // stale audio if cancelCurrentTurn fires mid-stream.

  const speechId = crypto.randomUUID();
  session.currentSpeechId = speechId;
  session.state = "tts_streaming";
  session.totalTtsChars += stripped.length;

  // New AbortController for TTS — stored so cancelCurrentTurn can abort it.
  const ttsController = new AbortController();
  session.currentAbortController = ttsController;

  const seqStart = registry.incrementSequence(session);
  const speechStartFrame = JSON.stringify({
    type: "speech_start",
    speechId,
    sessionId: session.sessionId,
    connectionGeneration: session.connectionGeneration,
    sequenceNumber: seqStart,
    timestamp: Date.now(),
  });

  session.log.push({ event: "TTS_STARTED", ts: new Date(), detail: `speechId=${speechId} chars=${stripped.length}` });
  logger.info(
    { deviceId: session.deviceId, turnId, speechId, strippedChars: stripped.length },
    "voice: TTS_STARTED",
  );

  try {
    session.ws?.send(speechStartFrame);
  } catch (err) {
    logger.warn({ err, deviceId: session.deviceId }, "voice: failed to send speech_start");
    session.state = "listening";
    session.currentSpeechId = null;
    session.currentAbortController = null;
    return null;
  }

  let sentChunks = 0;
  let ttsFirstChunkMs: number | null = null;
  const ttsStart = Date.now();

  try {
    for await (const chunk of streamSpeechElevenLabs(stripped, ttsController.signal)) {
      // Per-chunk ownership check — discard if turn was cancelled mid-stream.
      if (session.currentSpeechId !== speechId) {
        logger.info(
          { deviceId: session.deviceId, turnId, speechId },
          "voice: stale TTS chunk discarded — speechId mismatch",
        );
        break;
      }

      if (ttsFirstChunkMs === null) {
        ttsFirstChunkMs = Date.now() - ttsStart;
        logger.info(
          { deviceId: session.deviceId, turnId, speechId, ttsFirstChunkMs },
          "voice: ttsFirstChunkMs",
        );
      }

      try {
        session.ws?.send(chunk);
        sentChunks++;
      } catch (sendErr) {
        logger.warn({ err: sendErr, deviceId: session.deviceId }, "voice: TTS chunk send failed");
        break;
      }
    }
  } catch (err: unknown) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    if (!isAbort) {
      logger.error({ err, deviceId: session.deviceId, turnId, speechId }, "voice: ElevenLabs stream error");
    } else {
      logger.info({ deviceId: session.deviceId, turnId, speechId }, "voice: TTS stream aborted");
    }
  } finally {
    if (session.currentAbortController === ttsController) {
      session.currentAbortController = null;
    }
  }

  const ttsTotalMs = Date.now() - ttsStart;
  session.log.push({
    event: "TTS_FINISHED",
    ts: new Date(),
    detail: `speechId=${speechId} chunks=${sentChunks} ms=${ttsTotalMs}`,
  });
  logger.info(
    { deviceId: session.deviceId, turnId, speechId, sentChunks, ttsTotalMs },
    "voice: TTS_FINISHED",
  );

  if (sentChunks === 0) {
    // Zero chunks — ElevenLabs returned nothing or was immediately aborted.
    logger.warn({ deviceId: session.deviceId, speechId }, "voice: tts_failed_no_audio");
    try {
      session.ws?.send(JSON.stringify({ type: "tts_failed_no_audio", speechId }));
    } catch {}
    session.state = "listening";
    session.currentSpeechId = null;
    return null;
  }

  // Send tts_done only if speechId is still ours (not cancelled mid-stream).
  if (session.currentSpeechId === speechId) {
    const seqDone = registry.incrementSequence(session);
    try {
      session.ws?.send(
        JSON.stringify({
          type: "tts_done",
          speechId,
          sessionId: session.sessionId,
          connectionGeneration: session.connectionGeneration,
          sequenceNumber: seqDone,
          timestamp: Date.now(),
        }),
      );
    } catch (err) {
      logger.warn({ err, deviceId: session.deviceId }, "voice: failed to send tts_done");
    }
    session.currentSpeechId = null;
  }

  session.state = "listening";

  // ── 8. Persist assistant row after TTS audio confirmed sent ───────────────
  // Idempotency: completedTurnIds prevents a duplicate write if this code
  // path is somehow reached twice for the same turnId.
  if (sentChunks > 0 && !session.completedTurnIds.has(turnId)) {
    const assistantText = claudeText; // capture in closure
    void (async () => {
      try {
        await db.insert(messagesTable).values({
          id: crypto.randomUUID(),
          deviceId: session.deviceId,
          role: "ashley",
          content: assistantText,
          status: "complete",
          source: "voice_call",
          createdAt: new Date(),
        });
        session.completedTurnIds.add(turnId);
        logger.info(
          { deviceId: session.deviceId, turnId },
          "voice: assistant row persisted",
        );
      } catch (err) {
        logger.error({ err, deviceId: session.deviceId, turnId }, "voice: assistant row DB write failed — call continues");
      }
    })();
  }

  const totalTurnMs = Date.now() - turnStart;
  logger.info(
    {
      deviceId: session.deviceId,
      turnId,
      totalTurnMs,
      ttsFirstChunkMs,
      sentChunks,
    },
    "voice: turn complete",
  );

  return { claudeText, stripped, turnId };
}
