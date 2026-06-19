// ---------------------------------------------------------------------------
// voice-call.ts — Voice call utilities and turn pipeline entry point.
//
// Owns: loadVoiceContext, VOICE_MODE_ADDENDUM, stripMarkdown, speakFallback,
//       speakFarewell, startSilenceMonitor, handleVoiceTurn.
//
// P1-4: handleVoiceTurn now delegates to VoiceOrchestrationService.
//        All pipeline logic (intent, context, LLM, TTS, interruption) lives
//        in VoiceOrchestrationService. This file retains silence-lifecycle
//        helpers (speakFallback, speakFarewell, startSilenceMonitor) because
//        they are called from the silence timer, not from the turn pipeline.
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
import { eq, desc } from "drizzle-orm";
import { getOrCreateProfileFor } from "../lib/profile";
import { buildSystemPrompt } from "../lib/ashleyCoreSpec";
import { streamSpeechElevenLabs } from "../lib/elevenlabsStream";
import * as registry from "../lib/VoiceSessionRegistry";
import type { VoiceSession } from "../lib/VoiceSessionRegistry";
import * as VoiceOrchestrationService from "../lib/VoiceOrchestrationService";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors HISTORY_WINDOW from chat.ts — must stay in sync. */
const HISTORY_WINDOW = 80;

// Silence lifecycle thresholds (1I)
const SILENCE_POLL_MS   =  5_000; // check every 5 seconds
const SILENCE_WARN_MS   = 30_000; // speak "still there?" after 30s
const SILENCE_END_MS    = 60_000; // farewell TTS + call_ended + finalise after 60s
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
// NOT modified by P1-4 per brief.
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
// speakFallback — send a short spoken fallback to the client using the full
// response lifecycle. Used for the silence lifecycle ("Still there?") and
// context-load failures outside the main turn pipeline.
//
// Uses the same response_end → playback_confirmed → tts_done lifecycle as the
// main LLM pipeline. No direct tts_done bypass.
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
  session.responseComplete = false;

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
    // Flush the client's chunk buffer so the audio plays immediately.
    try {
      session.ws.send(
        JSON.stringify({ type: "sentence_end", speechId, timestamp: Date.now() }),
      );
    } catch {}

    // Send response_end — all audio dispatched. Client must confirm before
    // mic opens. Same lifecycle as the main LLM pipeline.
    session.responseComplete = true;
    session.awaitingPlaybackConfirm = true;
    const seqEnd = registry.incrementSequence(session);
    try {
      session.ws.send(
        JSON.stringify({
          type: "response_end",
          speechId,
          sessionId: session.sessionId,
          connectionGeneration: session.connectionGeneration,
          sequenceNumber: seqEnd,
          timestamp: Date.now(),
        }),
      );
    } catch {}

    // Safety timeout: if playback_confirmed never arrives, reset to listening.
    if (session.playbackConfirmTimeout) clearTimeout(session.playbackConfirmTimeout);
    session.playbackConfirmTimeout = setTimeout(() => {
      if (session.awaitingPlaybackConfirm && session.currentSpeechId === speechId) {
        logger.warn(
          { deviceId: session.deviceId },
          "voice: speakFallback safety timeout — resetting to listening",
        );
        session.awaitingPlaybackConfirm = false;
        session.responseComplete = false;
        session.playbackConfirmTimeout = null;
        session.currentSpeechId = null;
        session.state = "listening";

        if (session.pendingUtterance && session.pendingUtteranceId) {
          const u = session.pendingUtterance;
          const uid = session.pendingUtteranceId;
          session.pendingUtterance = null;
          session.pendingUtteranceId = null;
          void VoiceOrchestrationService.handleSpeechFinal(session, u, uid).catch((err) => {
            logger.error(
              { err, deviceId: session.deviceId },
              "voice: fallback safety timeout pending utterance failed",
            );
          });
        }
      }
    }, 15_000);

    // session.currentSpeechId stays set until playback_confirmed arrives via
    // handlePlaybackConfirmed(). Do NOT clear it here.
  } else {
    // No chunks sent or turn cancelled — clean up immediately.
    session.currentSpeechId = null;
  }
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
    session.silenceTimer = null;

    if (
      session.state === "closed" ||
      session.state === "failed" ||
      session.state === "closing"
    ) {
      return;
    }

    if (
      (session.state === "listening" || session.state === "active") &&
      !session.awaitingPlaybackConfirm
    ) {
      const ref = session.lastAudioReceivedAt ?? session.callStartTime;
      const silenceMs = Date.now() - ref.getTime();

      if (silenceMs >= SILENCE_FORCE_MS) {
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

    session.silenceTimer = setTimeout(tick, SILENCE_POLL_MS);
  }

  session.silenceTimer = setTimeout(tick, SILENCE_POLL_MS);
  logger.info({ deviceId: session.deviceId }, "voice: silence monitor started");
}

// ---------------------------------------------------------------------------
// handleVoiceTurn — P1-4: thin delegation entry point.
//
// All pipeline logic (intent classification, context assembly, LLM streaming,
// sentence-boundary TTS, interruption handling, rolling audio buffer) now
// lives in VoiceOrchestrationService. This function is the stable interface
// called from index.ts on speech_final acceptance.
// ---------------------------------------------------------------------------
export async function handleVoiceTurn(
  session: VoiceSession,
  transcript: string,
  utteranceId: string,
): Promise<void> {
  await VoiceOrchestrationService.handleSpeechFinal(
    session,
    transcript,
    utteranceId,
  );
}
