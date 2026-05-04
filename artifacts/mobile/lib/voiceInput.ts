// ---------------------------------------------------------------------------
// Voice input — Stage 1 of the staged voice plan.
//
// Push-to-talk only. The user holds the mic button, we record audio with
// expo-audio, on release we hand the recording (as base64) to the server's
// Whisper-backed /chat/transcribe endpoint, and the resulting transcript
// is merged into the existing TextInput draft for the user to review and
// send manually. Normal text chat remains the canonical fallback.
//
// Treat voice as PRESENCE, not just audio. Ashley should adapt gently to
// pauses and tone in later stages, but must never claim medical or
// emotional certainty from voice alone — see the future voice-presence
// safety floor in contentPolicy.ts.
//
// Future-stage hook points (DO NOT BUILD YET):
//   • Stage 2 — Streaming STT: chunk the recording in real time and POST
//     partial buffers; surface partial transcripts in the input box.
//   • Stage 3 — TTS replies: pipe Ashley's reply text through a TTS
//     endpoint and play with expo-audio's playback API.
//   • Stage 4 — Live conversation: silence detection (volume metering is
//     already supported by expo-audio's status updates), barge-in
//     (interrupt playback when mic re-opens), turn-taking (state machine
//     around "she's speaking" / "I'm speaking" / "both silent").
//   • Stage 5 — Tone awareness: switch transcribe to verbose_json so the
//     server can carry segment timing + non-verbal markers; gate via the
//     voice-presence safety floor in contentPolicy.ts.
//   • Wire format: when Stage 2+ lands, add `inputMode: "text" | "voice"`
//     to the user-message payload so the prompt builder knows when to
//     append the voice floor block.
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  setAudioModeAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

// Keep push-to-talk clips short. Whisper handles much longer, but a
// 60s ceiling keeps uploads quick on cellular and prevents the user
// accidentally leaving the mic open for minutes.
export const VOICE_MAX_DURATION_MS = 60_000;

export type RecordedAudio = {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
};

export type VoiceRecorderState = "idle" | "recording" | "processing";

export type VoiceRecorder = {
  state: VoiceRecorderState;
  elapsedMs: number;
  /** Request mic permission (no-op if already granted). Returns true if granted. */
  ensurePermission: () => Promise<boolean>;
  /** Begin recording. Caller should have already awaited ensurePermission(). */
  start: () => Promise<void>;
  /**
   * Stop the recording and return the audio. Returns null if there was no
   * active recording or the clip was empty (e.g. user released within
   * a few hundred ms — treat as a "tap, not hold").
   */
  stop: () => Promise<RecordedAudio | null>;
  /** Stop without returning audio. Used to bail out on errors / unmount. */
  cancel: () => Promise<void>;
};

// Anything shorter than this is treated as an accidental tap and discarded
// rather than fired off to the server (which would either return empty
// text or get rejected by the min-content-length check).
const MIN_RECORDING_MS = 350;

export function useVoiceRecorder(): VoiceRecorder {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopTicker = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const ensurePermission = useCallback(async () => {
    const status = await AudioModule.requestRecordingPermissionsAsync();
    return Boolean(status.granted);
  }, []);

  const start = useCallback(async () => {
    // setAudioModeAsync({ allowsRecording: true }) is required on iOS so
    // the audio session is configured for capture; harmless on Android.
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setState("recording");
    stopTicker();
    tickRef.current = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      // Hard auto-stop at the max — UI layer should also disable the
      // button when this fires, but the stop here protects the server.
      if (ms >= VOICE_MAX_DURATION_MS) {
        stopTicker();
      }
    }, 100);
  }, [recorder, stopTicker]);

  const finish = useCallback(
    async (returnAudio: boolean): Promise<RecordedAudio | null> => {
      stopTicker();
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      const durationMs = startedAt === null ? 0 : Date.now() - startedAt;
      try {
        await recorder.stop();
      } catch {
        // If stop() throws (e.g. recorder was never started), treat as a
        // no-op rather than crashing the UI.
        setState("idle");
        return null;
      }
      const uri = recorder.uri;
      // Always release the audio session afterwards so playback elsewhere
      // (e.g. future TTS replies) isn't trapped in record-only mode.
      try {
        await setAudioModeAsync({ allowsRecording: false });
      } catch {
        /* non-fatal */
      }
      if (!returnAudio || !uri || durationMs < MIN_RECORDING_MS) {
        setState("idle");
        setElapsedMs(0);
        return null;
      }
      setState("processing");
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        // expo-audio's HIGH_QUALITY preset writes m4a (aac) on both
        // platforms; surface a sensible default mime that Whisper accepts.
        const lower = uri.toLowerCase();
        const mimeType = lower.endsWith(".wav")
          ? "audio/wav"
          : lower.endsWith(".caf")
            ? "audio/x-caf"
            : lower.endsWith(".webm")
              ? "audio/webm"
              : "audio/m4a";
        return { audioBase64, mimeType, durationMs };
      } catch {
        return null;
      } finally {
        setState("idle");
        setElapsedMs(0);
      }
    },
    [recorder, stopTicker],
  );

  const stop = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(async () => {
    await finish(false);
  }, [finish]);

  return { state, elapsedMs, ensurePermission, start, stop, cancel };
}
