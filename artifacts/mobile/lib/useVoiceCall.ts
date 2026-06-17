// ---------------------------------------------------------------------------
// useVoiceCall — continuous-listening voice call with silence-triggered VAD.
//
// UX model:
//   Tap once → connect, mic opens immediately
//   Talk freely — silence for ~1.8s after speech auto-submits the utterance
//   Ashley speaks → mic pauses (prevents feedback loop)
//   Ashley finishes → mic re-opens automatically
//   Tap again → hang up
//
// VAD thresholds (tuneable at top of file):
//   SILENCE_DB    — below this dBFS = silence (-45 works on most phones)
//   SILENCE_MS    — silence duration that triggers a submit (1800ms)
//   MIN_SPEECH_MS — minimum speech duration to avoid submitting stray sounds
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { useVoiceRecorder } from "./voiceInput";
import { getDeviceIdSync } from "./deviceId";

// ── VAD config ────────────────────────────────────────────────────────────────

const SILENCE_DB    = -30;    // dBFS below this is treated as silence
const SILENCE_MS    = 1200;   // how long silence must last to trigger submit
const MIN_SPEECH_MS = 200;    // ignore segments shorter than this

// ── Types ─────────────────────────────────────────────────────────────────────

export type VoiceCallPhase =
  | "idle"          // not connected
  | "connecting"    // WS handshake in progress
  | "listening"     // mic open, waiting for speech
  | "user_speaking" // user is actively talking
  | "submitting"    // stopped recording, posting to STT
  | "thinking"      // speech_final sent, LLM running
  | "speaking"      // receiving / playing Ashley's audio
  | "ended";        // call over

export interface VoiceCallActions {
  connect: () => void;
  disconnect: () => void;
  /** Manually stop recording and submit the current segment. */
  submitNow: () => void;
}

// ── Audio helpers ─────────────────────────────────────────────────────────────

function voiceApiBase(): string {
  const override = process.env.EXPO_PUBLIC_API_BASE;
  const raw = (override?.trim() ? override : process.env.EXPO_PUBLIC_DOMAIN) ?? "";
  const cleaned = raw.replace(/\/+$/, "");
  const withScheme =
    cleaned.startsWith("http://") || cleaned.startsWith("https://")
      ? cleaned
      : `https://${cleaned}`;
  return /\/api$/.test(withScheme) ? withScheme : `${withScheme}/api`;
}

function voiceWsUrl(): string {
  return voiceApiBase()
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    + "/voice/call";
}

function concatChunks(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

function toBase64(arr: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useVoiceCall(): {
  phase: VoiceCallPhase;
  sessionId: string | null;
  userTranscript: string;
  ashleyResponse: string;
  error: string | null;
  /** Live mic level in dBFS (~-160 silence … 0 peak). null when mic closed. */
  metering: number | null;
} & VoiceCallActions {
  const [phase, setPhase] = useState<VoiceCallPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [ashleyResponse, setAshleyResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

  const phaseRef = useRef<VoiceCallPhase>("idle");
  const setPhaseSync = useCallback((p: VoiceCallPhase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  const wsRef = useRef<WebSocket | null>(null);
  const chunkBufRef = useRef<Uint8Array[]>([]);
  const playQueueRef = useRef<string[]>([]);
  const playerRef = useRef<AudioPlayer | null>(null);
  const playerUriRef = useRef<string | null>(null);

  const playNextRef = useRef<() => Promise<void>>(async () => {});
  const recorder = useVoiceRecorder();

  // ── VAD state ─────────────────────────────────────────────────────────────

  const isUserSpeakingRef   = useRef(false);
  const lastSpeechAtRef     = useRef(0);
  const segmentSpeechMsRef  = useRef(0);
  const speechStartAtRef    = useRef(0);
  const vadActiveRef        = useRef(false); // true only while mic should be running
  const autoSubmitTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const connectRef          = useRef<() => void>(() => {});

  // ── Audio playback queue ──────────────────────────────────────────────────

  const stopPlayback = useCallback((): void => {
    playQueueRef.current = [];
    const p = playerRef.current;
    const u = playerUriRef.current;
    playerRef.current = null;
    playerUriRef.current = null;
    if (p) {
      try { p.pause(); } catch { /* ignore */ }
      try { p.remove(); } catch { /* ignore */ }
    }
    if (u) {
      FileSystem.deleteAsync(u, { idempotent: true }).catch(() => { /* ignore */ });
    }
  }, []);

  const playNext = useCallback(async (): Promise<void> => {
    const uri = playQueueRef.current.shift();
    if (!uri) {
      // Queue drained — re-open mic if we are still connected.
      if (phaseRef.current === "speaking") {
        setPhaseSync("listening");
        void openMicRef.current();
      }
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    } catch { /* non-fatal */ }
    try {
      const player = createAudioPlayer({ uri });
      playerRef.current = player;
      playerUriRef.current = uri;
      setPhaseSync("speaking");
      player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) {
          playerRef.current = null;
          playerUriRef.current = null;
          try { player.remove(); } catch { /* ignore */ }
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => { /* ignore */ });
          void playNextRef.current();
        }
      });
      player.play();
    } catch {
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => { /* ignore */ });
      void playNextRef.current();
    }
  }, [setPhaseSync]); // openMic added below via ref

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  const flushChunkBuffer = useCallback(async (): Promise<void> => {
    const chunks = chunkBufRef.current;
    chunkBufRef.current = [];
    if (chunks.length === 0) return;
    const combined = concatChunks(chunks);
    const b64 = toBase64(combined);
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const uri = `${dir}vc-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
    try {
      await FileSystem.writeAsStringAsync(uri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      playQueueRef.current.push(uri);
      if (!playerRef.current) void playNextRef.current();
    } catch { /* audio lost, call continues */ }
  }, []);

  // ── Mic open / submit / reopen cycle ──────────────────────────────────────

  const clearAutoSubmitTimer = useCallback((): void => {
    if (autoSubmitTimerRef.current !== null) {
      clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }
  }, []);

  // openMic is used by both initial connect and post-Ashley reopen.
  // Defined after VAD watchers so the closure captures everything it needs.
  const openMicRef = useRef<() => Promise<void>>(async () => {});

  const submitSegment = useCallback(async (): Promise<void> => {
    if (phaseRef.current === "submitting" || phaseRef.current === "thinking") return;
    clearAutoSubmitTimer();
    vadActiveRef.current = false;
    setPhaseSync("submitting");

    const audio = await recorder.stop();
    if (!audio) {
      // Nothing useful — reopen mic and wait for more speech.
      setPhaseSync("listening");
      void openMicRef.current();
      return;
    }

    const apiBase = voiceApiBase();
    const key = process.env.EXPO_PUBLIC_API_KEY ?? "";
    const deviceId = getDeviceIdSync();

    try {
      const resp = await fetch(`${apiBase}/chat/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "X-Api-Key": key,
          "X-Device-Id": deviceId,
        },
        body: JSON.stringify({ audioBase64: audio.audioBase64, mimeType: audio.mimeType }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { transcript?: string };
      const tx = (data.transcript ?? "").trim();

      if (!tx) {
        // Empty transcript — reopen and listen.
        setPhaseSync("listening");
        void openMicRef.current();
        return;
      }

      setUserTranscript(tx);

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError("Connection lost");
        setPhaseSync("ended");
        return;
      }
      ws.send(JSON.stringify({
        type: "speech_final",
        transcript: tx,
        utteranceId: Math.random().toString(36).slice(2),
      }));
      setPhaseSync("thinking");
      // Mic stays closed until Ashley finishes (playback queue drain reopens it).
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
      setPhaseSync("listening");
      void openMicRef.current();
    }
  }, [recorder, setPhaseSync, clearAutoSubmitTimer]);

  const submitSegmentRef = useRef(submitSegment);
  useEffect(() => { submitSegmentRef.current = submitSegment; }, [submitSegment]);

  // ── VAD effect — watches recorder.metering via React state ───────────────

  useEffect(() => {
    if (!vadActiveRef.current) return;
    const db = recorder.metering;
    if (db === null) return;

    const now = Date.now();

    if (db > SILENCE_DB) {
      // User is producing sound.
      if (!isUserSpeakingRef.current) {
        isUserSpeakingRef.current = true;
        speechStartAtRef.current = now;
        setPhaseSync("user_speaking");
      }
      lastSpeechAtRef.current = now;
      segmentSpeechMsRef.current = now - speechStartAtRef.current;
    } else {
      // Silence.
      if (
        isUserSpeakingRef.current &&
        segmentSpeechMsRef.current >= MIN_SPEECH_MS &&
        now - lastSpeechAtRef.current >= SILENCE_MS
      ) {
        // User has stopped talking long enough — submit.
        isUserSpeakingRef.current = false;
        segmentSpeechMsRef.current = 0;
        void submitSegmentRef.current();
      }
    }
  }, [recorder.metering, setPhaseSync]);

  // ── openMic ───────────────────────────────────────────────────────────────

  const openMic = useCallback(async (): Promise<void> => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (phaseRef.current === "ended") return;

    // Reset VAD state for new segment.
    isUserSpeakingRef.current = false;
    lastSpeechAtRef.current = 0;
    segmentSpeechMsRef.current = 0;
    speechStartAtRef.current = 0;
    clearAutoSubmitTimer();

    const ok = await recorder.ensurePermission();
    if (!ok) {
      setError("Microphone permission denied");
      return;
    }
    try {
      await recorder.start();
      vadActiveRef.current = true;
      setPhaseSync("listening");

      // Fallback: if metering-based VAD never fires (metering null on this
      // device), auto-submit after 3 s so the call doesn't hang forever.
      autoSubmitTimerRef.current = setTimeout(() => {
        autoSubmitTimerRef.current = null;
        if (
          phaseRef.current === "listening" ||
          phaseRef.current === "user_speaking"
        ) {
          vadActiveRef.current = false;
          void submitSegmentRef.current();
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open mic");
    }
  }, [recorder, setPhaseSync, clearAutoSubmitTimer]);

  // Keep openMicRef in sync.
  useEffect(() => { openMicRef.current = openMic; }, [openMic]);

  // Also wire openMic into the playNext callback so queue drain can call it.
  // We do this by overriding playNext inline — the easiest way is to ref it.
  // playNext already reads openMicRef via openMicRef.current — resolved below.

  // ── WS message handler ────────────────────────────────────────────────────

  const handleMessage = useCallback(
    async (event: MessageEvent): Promise<void> => {
      if (event.data instanceof ArrayBuffer) {
        chunkBufRef.current.push(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== "string") return;

      let msg: Record<string, unknown>;
      try { msg = JSON.parse(event.data) as Record<string, unknown>; }
      catch { return; }

      switch (msg["type"] as string) {
        case "call_connected":
          setSessionId((msg["sessionId"] as string) ?? null);
          reconnectAttemptsRef.current = 0; // successful connection — reset counter
          // Open the mic immediately — the call has started.
          await openMicRef.current();
          break;

        case "speech_start":
          chunkBufRef.current = [];
          // Mic is already closed during thinking/submitting phase.
          break;

        case "sentence_end":
          await flushChunkBuffer();
          break;

        case "tts_done": {
          await flushChunkBuffer();
          const text = (msg["responseText"] as string | undefined) ?? "";
          if (text) setAshleyResponse(text);
          // If nothing is queued and nothing playing, reopen mic immediately.
          if (playQueueRef.current.length === 0 && !playerRef.current) {
            setPhaseSync("listening");
            void openMicRef.current();
          }
          break;
        }

        case "interrupt_ack":
          stopPlayback();
          setPhaseSync("listening");
          void openMicRef.current();
          break;

        case "reconnect_ok":
          reconnectAttemptsRef.current = 0;
          setError(null);
          void openMicRef.current();
          break;

        case "call_ended":
          break;

        case "error":
          setError((msg["message"] as string) || "Server error");
          break;
      }
    },
    [flushChunkBuffer, stopPlayback, setPhaseSync],
  );

  // ── Connect ───────────────────────────────────────────────────────────────

  const connect = useCallback((): void => {
    if (wsRef.current) return;
    setPhaseSync("connecting");
    setError(null);
    setUserTranscript("");
    setAshleyResponse("");

    const url = voiceWsUrl();
    const key = process.env.EXPO_PUBLIC_API_KEY ?? "";
    const deviceId = getDeviceIdSync();

    type RNWebSocket = new (
      url: string,
      protocols: string | string[] | null,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const RNWS = WebSocket as unknown as RNWebSocket;
    const ws = new RNWS(url, null, {
      headers: { Authorization: `Bearer ${key}`, "X-Device-Id": deviceId },
    });

    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (e: MessageEvent) => { void handleMessage(e); };
    ws.onerror = () => {
      // onclose always fires after onerror — let it handle state.
      // Just surface a transient message in case reconnect doesn't succeed.
      setError("Connection dropped — reconnecting...");
    };
    ws.onclose = () => {
      wsRef.current = null;
      vadActiveRef.current = false;
      clearAutoSubmitTimer();
      stopPlayback();
      chunkBufRef.current = [];

      // If the user tapped End Call, phase is already "ended" — stop here.
      if (phaseRef.current === "ended") return;

      // Abnormal close (Replit proxy timeout, network blip) — try once to
      // reconnect transparently. The server holds the session for 90s.
      if (reconnectAttemptsRef.current < 1) {
        reconnectAttemptsRef.current++;
        setError(null);
        setPhaseSync("connecting");
        setTimeout(() => { connectRef.current(); }, 1500);
      } else {
        // Second drop in a row — give up and show the ended screen.
        reconnectAttemptsRef.current = 0;
        setPhaseSync("ended");
      }
    };
  }, [handleMessage, stopPlayback, setPhaseSync, clearAutoSubmitTimer]);

  // Keep connectRef current so the onclose reconnect timer always calls the
  // latest version of connect (avoids stale-closure bugs).
  useEffect(() => { connectRef.current = connect; }, [connect]);

  // ── Disconnect ────────────────────────────────────────────────────────────

  const disconnect = useCallback((): void => {
    clearAutoSubmitTimer();
    vadActiveRef.current = false;
    stopPlayback();
    void recorder.cancel();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try { ws.send(JSON.stringify({ type: "call_end" })); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
    }
    chunkBufRef.current = [];
    setPhaseSync("ended");
  }, [stopPlayback, recorder, setPhaseSync, clearAutoSubmitTimer]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      clearAutoSubmitTimer();
      vadActiveRef.current = false;
      stopPlayback();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) { try { ws.close(); } catch { /* ignore */ } }
    };
  }, [stopPlayback, clearAutoSubmitTimer]);

  const submitNow = useCallback((): void => {
    if (
      phaseRef.current === "listening" ||
      phaseRef.current === "user_speaking"
    ) {
      vadActiveRef.current = false;
      void submitSegmentRef.current();
    }
  }, []);

  return {
    phase,
    sessionId,
    userTranscript,
    ashleyResponse,
    error,
    metering: recorder.metering,
    connect,
    disconnect,
    submitNow,
  };
}
