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

import { useCallback, useRef, useState } from "react";
import {
  AudioModule,
  RecordingPresets,
  useAudioRecorder,
  setAudioModeAsync,
  type RecordingStatus,
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
  const recorder = useAudioRecorder(
    RecordingPresets.HIGH_QUALITY,
    (status: RecordingStatus) => {
      const m = (status as RecordingStatus & { metering?: number }).metering;
      if (typeof m === "number" && Number.isFinite(m)) {
        meteringRef.current = m;
        setMetering(m);
      }
    },
  );
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
        ...RecordingPresets.HIGH_QUALITY,
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

      // Release recording audio focus so subsequent TTS or recording
      // sessions can acquire the session cleanly.
      try {
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        patchAudioState({ audioFocusState: "none" });
        audioLog("STT.finish.audioModeReleased");
      } catch (err) {
        audioError("STT.finish.setAudioMode", err);
        // Non-fatal — continue.
      }

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
