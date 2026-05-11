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
// Status of the staged voice plan (single source of truth — keep in sync
// with voiceOutput.ts):
//   ✓ Stage 1   — Push-to-talk STT (this file).
//   ✓ Stage 3   — TTS voice replies (voiceOutput.ts + lib/openai.ts
//                 synthesizeSpeech). Auto-spoken Ashley reply, toggle in
//                 chat header, clean delivery prompt, stripForTts() drops
//                 markdown emphasis + bracketed stage directions before
//                 TTS so asterisks aren't read aloud.
//   ✓ Stage 3.5 — Voice register (profile.voiceMode flag). Re-shapes
//                 Ashley's *text* output for spoken delivery (no
//                 asterisks/emojis/stage directions, short sentences,
//                 natural pauses, warm pacing). Server-side, lives in
//                 ashleyCoreSpec.ts buildSystemPrompt.
//
// Future-stage placeholder hooks (DO NOT BUILD YET — Kane re-scoped away
// from full live voice; these are explicit reservations):
//   • [voice selection]      Pick from a list of TTS voices per
//                            device. Wire as profile.ttsVoice (string),
//                            forwarded by /chat/tts to the OpenAI voice
//                            param. Default: current "alloy".
//   • [live voice mode]      Hands-free walkie-talkie session: VAD
//                            (lib/voiceActivity.ts already drafted with
//                            -35/-40 dB thresholds, 200/800ms holds) +
//                            recorder cycling + barge-in + state machine
//                            (idle | listening | thinking | speaking).
//                            Realtime API is blocked by the Replit
//                            OpenAI proxy, so this would be turn-based
//                            via the existing transcribe→chat→tts
//                            pipeline (~4-5s per turn).
//   • [interruption handling] When live mode lands: a "VAD-only"
//                            recorder runs during thinking+speaking and
//                            stops TTS the moment voice is detected.
//                            Partly wired today: handleMicPressIn in
//                            chat.tsx already calls tts.stop().
//   • [emotional tone]       Switch /chat/transcribe to verbose_json so
//                            the server gets segment timing + non-verbal
//                            markers; pipe an `instructions` field into
//                            synthesizeSpeech for tone-aware delivery
//                            ("speak softly", "warm and slow", etc.).
//                            Gated via the voice-presence safety floor.
//   • [wire format]          When live mode lands, add inputMode:
//                            "text" | "voice" to the chat payload so the
//                            prompt builder can append a voice-floor
//                            block alongside the existing voiceMode
//                            register block.
// ---------------------------------------------------------------------------

import { useCallback, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  setAudioModeAsync,
  type RecordingStatus,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";

// Push-to-talk ceiling. Whisper handles long clips well; 150s (2.5 min)
// gives enough headroom for an extended thought while keeping uploads
// manageable on cellular and preventing accidental open-mic marathons.
export const VOICE_MAX_DURATION_MS = 150_000;

export type RecordedAudio = {
  audioBase64: string;
  mimeType: string;
  durationMs: number;
};

export type VoiceRecorderState = "idle" | "recording" | "processing";

export type VoiceRecorder = {
  state: VoiceRecorderState;
  elapsedMs: number;
  /**
   * Live metering value in dB (roughly -160 silence … 0 peak). Updated on
   * every recorder status tick (~100ms). null when not recording. Used by
   * the Stage 4 live-conversation VAD; push-to-talk callers ignore it.
   */
  metering: number | null;
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
  // Metering is opt-in per start() call. We hold the latest dB value in a
  // ref so the status listener (created once below) can keep writing
  // without triggering a re-render every 100ms; consumers get the value
  // via the returned `metering` field, which is mirrored into state on
  // each status tick (cheap setState — RN batches at 60fps anyway).
  const meteringRef = useRef<number | null>(null);
  const [metering, setMetering] = useState<number | null>(null);
  const recorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY,
    (status: RecordingStatus) => {
      // `metering` is only present when the recorder was prepared with
      // isMeteringEnabled:true (see start() below). The expo-audio types
      // don't surface it on RecordingStatus yet, hence the cast.
      const m = (status as RecordingStatus & { metering?: number }).metering;
      if (typeof m === "number" && Number.isFinite(m)) {
        meteringRef.current = m;
        setMetering(m);
      }
    },
  );
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
    // isMeteringEnabled adds the `metering` field to status updates so
    // the Stage 4 VAD can see live dB values. Cheap (no measurable
    // battery impact) and ignored by push-to-talk callers.
    await recorder.prepareToRecordAsync({
      ...RecordingPresets.HIGH_QUALITY,
      isMeteringEnabled: true,
    });
    meteringRef.current = null;
    setMetering(null);
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
      meteringRef.current = null;
      setMetering(null);
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

  return { state, elapsedMs, metering, ensurePermission, start, stop, cancel };
}
