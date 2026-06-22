// ---------------------------------------------------------------------------
// Voice input — Push-to-talk STT via expo-audio.
//
// See voiceOutput.ts for the staged voice plan status.
//
// Changes from previous version:
//   • All state transitions logged via audioLog/audioError from audioState.ts
//   • Every catch block now logs function name + error + current state
//   • setAudioModeAsync calls logged so Android audio session changes are
//     traceable from the phone (no ADB needed — logs surface in the debug panel)
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  useAudioRecorderState,
  setAudioModeAsync,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { audioError, audioLog, patchAudioState } from "./audioState";

// Push-to-talk ceiling — 150s gives enough headroom for an extended thought.
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
   * every recorder status tick (~100ms). null when not recording.
   */
  metering: number | null;
  ensurePermission: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<RecordedAudio | null>;
  cancel: () => Promise<void>;
};

// Clips shorter than this are treated as accidental taps and discarded.
const MIN_RECORDING_MS = 350;

export function useVoiceRecorder(): VoiceRecorder {
  const meteringRef = useRef<number | null>(null);
  const [metering, setMetering] = useState<number | null>(null);
  const VOICE_CALL_PRESET = {
    ...RecordingPresets.HIGH_QUALITY,
    android: {
      ...RecordingPresets.HIGH_QUALITY.android,
      // VOICE_COMMUNICATION enables hardware acoustic echo cancellation (AEC),
      // noise suppression, and AGC on Android — the same source used by phone
      // call apps. Prevents Ashley's TTS audio from leaking back into the mic.
      audioSource: "voice_communication" as const,
    },
  };

  // useAudioRecorder's status callback subscribes to the native
  // "recordingStatusUpdate" event which is only emitted on state transitions
  // (start/stop/pause) — not on a timer tick — so metering never arrives
  // via that path on Android. useAudioRecorderState polls recorder.getStatus()
  // every 100ms instead, which is the library's own documented solution and
  // exposes metering as a first-class typed field on RecorderState.
  const recorder = useAudioRecorder(VOICE_CALL_PRESET);
  const recorderState = useAudioRecorderState(recorder, 100);

  // Sync polled metering into meteringRef (read by VAD closures) and the
  // metering React state (consumed by the VoiceRecorder return value).
  useEffect(() => {
    const m = recorderState.metering ?? null;
    meteringRef.current = m;
    setMetering(m);
  }, [recorderState.metering]);
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const stateRef = useRef<VoiceRecorderState>("idle");
  const setStateTracked = useCallback((s: VoiceRecorderState) => {
    stateRef.current = s;
    setState(s);
  }, []);
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
    audioLog("STT.ensurePermission");
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      const granted = Boolean(status.granted);
      patchAudioState({
        micPermission: granted ? "granted" : "denied",
      });
      audioLog("STT.ensurePermission.result", { granted });
      return granted;
    } catch (err) {
      audioError("STT.ensurePermission", err);
      patchAudioState({ micPermission: "denied" });
      return false;
    }
  }, []);

  const start = useCallback(async () => {
    audioLog("STT.start");
    // Guard: if the recorder is already running, skip rather than calling
    // prepareToRecordAsync on a prepared session (throws "already been prepared").
    // This is a safety net — the mutex in openMic should prevent concurrent calls,
    // but defensive here in case any other caller bypasses that guard.
    if (stateRef.current === "recording") {
      audioLog("STT.start.skipped — already recording");
      return;
    }
    // setAudioModeAsync({ allowsRecording: true }) configures the audio
    // session for capture on iOS; it also tells Android we want recording
    // focus. Must complete BEFORE prepareToRecordAsync so the session is
    // in the right state when the recorder acquires the hardware.
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      patchAudioState({ audioFocusState: "recording" });
      audioLog("STT.start.audioModeSet");
    } catch (err) {
      audioError("STT.start.setAudioMode", err);
      // Continue anyway — recording may still work.
    }

    try {
      await recorder.prepareToRecordAsync({
        ...VOICE_CALL_PRESET,
        isMeteringEnabled: true,
      });
      audioLog("STT.start.prepared");
    } catch (err) {
      audioError("STT.start.prepareToRecordAsync", err);
      patchAudioState({ sttReady: false, audioFocusState: "none" });
      throw err; // Propagate so handleMicPressIn can show voiceError.
    }

    meteringRef.current = null;
    setMetering(null);
    recorder.record();
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStateTracked("recording");
    patchAudioState({
      sttListening: true,
      sttReady: true,
      lastSttStartedAt: Date.now(),
    });
    audioLog("STT.start.recording");

    stopTicker();
    tickRef.current = setInterval(() => {
      const startedAt = startedAtRef.current;
      if (startedAt === null) return;
      const ms = Date.now() - startedAt;
      setElapsedMs(ms);
      if (ms >= VOICE_MAX_DURATION_MS) {
        stopTicker();
      }
    }, 100);
  }, [recorder, stopTicker, setStateTracked]);

  const finish = useCallback(
    async (returnAudio: boolean): Promise<RecordedAudio | null> => {
      audioLog("STT.finish", { returnAudio });
      stopTicker();
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      const durationMs = startedAt === null ? 0 : Date.now() - startedAt;

      try {
        await recorder.stop();
        audioLog("STT.finish.stopped", { durationMs });
      } catch (err) {
        audioError("STT.finish.stop", err, { durationMs });
        setStateTracked("idle");
        patchAudioState({
          sttListening: false,
          lastSttStoppedAt: Date.now(),
          audioFocusState: "none",
        });
        return null;
      }

      const uri = recorder.uri;

      // Do NOT reset allowsRecording to false here. For voice calls, the
      // VOICE_COMMUNICATION audio source (hardware AEC) must stay active
      // throughout the session — switching the mode off between turns
      // destroys the echo cancellation pipeline. The mode was set to
      // { allowsRecording: true } in start() and must remain there.

      meteringRef.current = null;
      setMetering(null);
      patchAudioState({ sttListening: false, lastSttStoppedAt: Date.now() });

      if (!returnAudio || !uri || durationMs < MIN_RECORDING_MS) {
        setStateTracked("idle");
        setElapsedMs(0);
        audioLog("STT.finish.discarded", { returnAudio, hasUri: !!uri, durationMs });
        return null;
      }

      setStateTracked("processing");
      try {
        const audioBase64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        const lower = uri.toLowerCase();
        const mimeType = lower.endsWith(".wav")
          ? "audio/wav"
          : lower.endsWith(".caf")
            ? "audio/x-caf"
            : lower.endsWith(".webm")
              ? "audio/webm"
              : "audio/m4a";
        audioLog("STT.finish.audioReady", { mimeType, durationMs });
        return { audioBase64, mimeType, durationMs };
      } catch (err) {
        audioError("STT.finish.readAudio", err, { uri });
        return null;
      } finally {
        setStateTracked("idle");
        setElapsedMs(0);
      }
    },
    [recorder, stopTicker, setStateTracked],
  );

  const stop = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(async () => {
    audioLog("STT.cancel");
    await finish(false);
  }, [finish]);

  return { state, elapsedMs, metering, ensurePermission, start, stop, cancel };
}
