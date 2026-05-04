// Voice activity detection (VAD) for the Stage 4 hands-free live
// conversation mode. Pure logic — no React, no expo-audio. Drives off
// dB metering samples produced by useVoiceRecorder's status listener.
//
// Why a pure helper: easy to unit test, and the same classifier is used
// twice in the live session — once on the "real" recorder (to detect
// end-of-turn) and once on the "VAD-only" recorder (to detect barge-in
// during TTS playback).

// dB thresholds. expo-audio's metering is reported on a roughly
// -160..0 dB scale (silence near -160, peak speech around -10). Quiet
// room with mic noise floor sits around -50..-45. These two thresholds
// have a ~5 dB hysteresis gap so we don't oscillate on borderline
// samples.
export const VAD_VOICE_DB = -35;
export const VAD_SILENCE_DB = -40;

// How long a sample must hold above/below threshold before we accept it
// as a real state transition. Voice-start is fast (don't miss the start
// of an utterance); silence-end is deliberately slower so a natural
// mid-sentence pause doesn't end the turn.
export const VAD_VOICE_HOLD_MS = 200;
export const VAD_SILENCE_HOLD_MS = 800;

// State of the underlying acoustic stream from the VAD's perspective.
export type VadState = "silent" | "voiced";

// Result of feeding one metering sample into the classifier.
//   - state: the new (possibly unchanged) state
//   - voiceStartedAt: monotonic timestamp of the most recent silent→voiced
//     transition (null if we have not yet seen voice in this session).
//     Useful so the orchestrator can tell whether silence is "after a
//     voiced turn" (end-of-turn) vs "still leading silence" (no-op).
//   - transition: present only on the sample that caused the change
export type VadSample = {
  state: VadState;
  voiceStartedAt: number | null;
  transition?: "voice-started" | "voice-ended";
};

// Persistent classifier state. Caller owns one of these per recorder.
export type VadCarry = {
  state: VadState;
  // Timestamp of the first sample in the current candidate run. Once a
  // sample crosses the relevant hold threshold we commit the transition
  // and reset.
  candidateSince: number | null;
  // Monotonic timestamp of the most recent confirmed voice-start. Reset
  // on stop(), preserved across silence runs within a turn.
  voiceStartedAt: number | null;
};

export function makeVadCarry(): VadCarry {
  return { state: "silent", candidateSince: null, voiceStartedAt: null };
}

/**
 * Feed one metering sample into the classifier, mutating `carry` and
 * returning the new VadSample. `metering` is in dB; pass `now` from
 * Date.now() (injectable for tests).
 *
 * Behaviour:
 *   - In "silent" state: a sample ≥ VAD_VOICE_DB starts a candidate
 *     run; if held for ≥ VAD_VOICE_HOLD_MS, commit voice-started.
 *   - In "voiced" state: a sample ≤ VAD_SILENCE_DB starts a candidate
 *     run; if held for ≥ VAD_SILENCE_HOLD_MS, commit voice-ended.
 *   - Any sample that breaks the candidate run resets candidateSince.
 *   - undefined / NaN metering is treated as silence (defensive — some
 *     Android builds report no metering on the very first tick).
 */
export function classifySample(
  carry: VadCarry,
  metering: number | undefined | null,
  now: number,
): VadSample {
  const db =
    typeof metering === "number" && Number.isFinite(metering) ? metering : -160;
  if (carry.state === "silent") {
    if (db >= VAD_VOICE_DB) {
      if (carry.candidateSince === null) carry.candidateSince = now;
      if (now - carry.candidateSince >= VAD_VOICE_HOLD_MS) {
        carry.state = "voiced";
        carry.candidateSince = null;
        carry.voiceStartedAt = now;
        return {
          state: "voiced",
          voiceStartedAt: now,
          transition: "voice-started",
        };
      }
    } else {
      carry.candidateSince = null;
    }
    return { state: "silent", voiceStartedAt: carry.voiceStartedAt };
  }
  // voiced
  if (db <= VAD_SILENCE_DB) {
    if (carry.candidateSince === null) carry.candidateSince = now;
    if (now - carry.candidateSince >= VAD_SILENCE_HOLD_MS) {
      carry.state = "silent";
      carry.candidateSince = null;
      // Keep voiceStartedAt around so the caller can attribute the
      // end-of-turn to a specific utterance start.
      return {
        state: "silent",
        voiceStartedAt: carry.voiceStartedAt,
        transition: "voice-ended",
      };
    }
  } else {
    carry.candidateSince = null;
  }
  return { state: "voiced", voiceStartedAt: carry.voiceStartedAt };
}
