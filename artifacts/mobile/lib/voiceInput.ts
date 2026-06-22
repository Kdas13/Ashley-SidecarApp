// ---------------------------------------------------------------------------
// Voice input — Push-to-talk STT via react-native-audio-record.
//
// Replaces expo-audio's useAudioRecorder (whose native "recordingStatusUpdate"
// event never fires during active recording on Android, making metering
// permanently dead) with react-native-audio-record, which uses Android's
// AudioRecord API directly. Raw 16-bit PCM chunks are streamed via a 'data'
// event; amplitude is computed in JS from the samples, giving real metering
// values that are immune to Samsung DSP/AGC suppression of getMaxAmplitude().
//
// Audio format: 16 kHz, mono, 16-bit PCM → WAV (Deepgram handles WAV natively).
// AEC: audioSource=7 (VOICE_COMMUNICATION) preserves hardware echo cancellation,
//      noise suppression, and AGC — the same source used by phone call apps.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import { PermissionsAndroid, Platform } from "react-native";
import AudioRecord from "react-native-audio-record";
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
   * Live metering value in dBFS (roughly −160 silence … 0 peak). Computed
   * from raw PCM chunk samples on every 'data' event (~100ms). null when
   * not recording.
   */
  metering: number | null;
  ensurePermission: () => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<RecordedAudio | null>;
  cancel: () => Promise<void>;
};

// Clips shorter than this are treated as accidental taps and discarded.
const MIN_RECORDING_MS = 350;

// Recording configuration: 16 kHz mono 16-bit PCM, VOICE_COMMUNICATION for AEC.
// wavFile is the filename written to the app's documents directory; stop()
// returns its full absolute path.
const AUDIO_OPTIONS = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 7, // MediaRecorder.AudioSource.VOICE_COMMUNICATION
  wavFile: "voice_input.wav",
};

export function useVoiceRecorder(): VoiceRecorder {
  const meteringRef = useRef<number | null>(null);
  const [metering, setMetering] = useState<number | null>(null);
  const [state, setState] = useState<VoiceRecorderState>("idle");
  const stateRef = useRef<VoiceRecorderState>("idle");
  const setStateTracked = useCallback((s: VoiceRecorderState) => {
    stateRef.current = s;
    setState(s);
  }, []);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Init AudioRecord once on mount and subscribe to PCM data chunks for
  // real-time metering. AudioRecord.on() calls removeAllListeners before
  // addListener — only one handler is active at a time.
  //
  // Amplitude computation: decode base64 → 16-bit LE signed samples →
  // max(|sample|) / 32768 → dBFS. This reads from the actual PCM buffer
  // rather than querying the hardware amplitude meter, so Samsung's AGC
  // cannot suppress it.
  useEffect(() => {
    AudioRecord.init(AUDIO_OPTIONS);
    let active = true;
    AudioRecord.on("data", (chunk: string) => {
      if (!active) return;
      const binary = atob(chunk);
      let max = 0;
      for (let i = 0; i + 1 < binary.length; i += 2) {
        let sample = binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8);
        if (sample > 32767) sample -= 65536; // two's complement → signed int16
        const abs = Math.abs(sample);
        if (abs > max) max = abs;
      }
      const dBFS = max > 0 ? 20 * Math.log10(max / 32768) : -160;
      meteringRef.current = dBFS;
      setMetering(dBFS);
    });
    return () => {
      active = false;
    };
  }, []);

  const stopTicker = useCallback(() => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);

  const ensurePermission = useCallback(async () => {
    audioLog("STT.ensurePermission");
    try {
      let granted = true;
      if (Platform.OS === "android") {
        const result = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
        );
        granted = result === PermissionsAndroid.RESULTS.GRANTED;
      }
      // On iOS the system permission dialog fires automatically on the first
      // AudioRecord.start() call — no explicit request needed here.
      patchAudioState({ micPermission: granted ? "granted" : "denied" });
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
    // Guard: if already recording skip. Safety net — the mutex in openMic
    // should prevent concurrent calls, but defensive in case any caller bypasses.
    if (stateRef.current === "recording") {
      audioLog("STT.start.skipped — already recording");
      return;
    }

    meteringRef.current = null;
    setMetering(null);

    // react-native-audio-record acquires audio focus internally on start().
    // No explicit setAudioModeAsync needed; VOICE_COMMUNICATION AEC stays
    // active throughout the session via the audioSource configuration.
    try {
      AudioRecord.start();
      patchAudioState({ audioFocusState: "recording" });
      audioLog("STT.start.recording");
    } catch (err) {
      audioError("STT.start", err);
      patchAudioState({ sttReady: false, audioFocusState: "none" });
      throw err; // Propagate so handleMicPressIn can show voiceError.
    }

    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStateTracked("recording");
    patchAudioState({
      sttListening: true,
      sttReady: true,
      lastSttStartedAt: Date.now(),
    });

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
  }, [stopTicker, setStateTracked]);

  const finish = useCallback(
    async (returnAudio: boolean): Promise<RecordedAudio | null> => {
      audioLog("STT.finish", { returnAudio });
      stopTicker();
      const startedAt = startedAtRef.current;
      startedAtRef.current = null;
      const durationMs = startedAt === null ? 0 : Date.now() - startedAt;

      let filePath: string;
      try {
        filePath = await AudioRecord.stop();
        audioLog("STT.finish.stopped", { durationMs, filePath });
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

      meteringRef.current = null;
      setMetering(null);
      patchAudioState({ sttListening: false, lastSttStoppedAt: Date.now() });

      if (!returnAudio || !filePath || durationMs < MIN_RECORDING_MS) {
        setStateTracked("idle");
        setElapsedMs(0);
        audioLog("STT.finish.discarded", {
          returnAudio,
          hasPath: !!filePath,
          durationMs,
        });
        return null;
      }

      setStateTracked("processing");
      try {
        // AudioRecord.stop() returns an absolute path on Android; FileSystem
        // requires a file:// URI.
        const uri = filePath.startsWith("file://")
          ? filePath
          : `file://${filePath}`;
        const audioBase64 = await FileSystem.readAsStringAsync(uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        audioLog("STT.finish.audioReady", { mimeType: "audio/wav", durationMs });
        return { audioBase64, mimeType: "audio/wav", durationMs };
      } catch (err) {
        audioError("STT.finish.readAudio", err, { filePath });
        return null;
      } finally {
        setStateTracked("idle");
        setElapsedMs(0);
      }
    },
    [stopTicker, setStateTracked],
  );

  const stop = useCallback(() => finish(true), [finish]);
  const cancel = useCallback(async () => {
    audioLog("STT.cancel");
    await finish(false);
  }, [finish]);

  return { state, elapsedMs, metering, ensurePermission, start, stop, cancel };
}
