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
  type AudioPlayer,
} from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { useVoiceRecorder } from "./voiceInput";
import { getDeviceIdSync } from "./deviceId";

// ── VAD config ────────────────────────────────────────────────────────────────

const SILENCE_DB    = -45;    // was -30 — too sensitive, picking up room noise as speech
const SILENCE_MS    = 3500;   // silence tolerance once significant speech has been detected
const MIN_SPEECH_MS = 500;    // was 200 — too short, catching non-speech sounds

// ── Adaptive silence threshold ─────────────────────────────────────────────
// Short segments (sentence openers like "Hey," / "Sorry,") get a longer
// silence tolerance before submit. A genuine pause after a short fragment
// is more likely a thinking pause than an end-of-utterance.
// Long segments (≥ 1000ms detected speech — a sentence is underway) use
// the standard SILENCE_MS; they don't need extra tolerance.
const SILENCE_MS_SHORT           = 4500;   // silence tolerance for short-segment openers
const SILENCE_THRESHOLD_SHORT_MS = 1000;   // segment speech below this → SILENCE_MS_SHORT

// ── VAD open-mic delay (echo guard on mic reopen) ─────────────────────────────
// After recorder.start(), hold VAD inactive for a flat delay before allowing
// detection to start. This is a known heuristic, not a calibrated measurement:
// it covers the ~300-400ms Bluetooth A2DP buffer drain identified as the echo
// risk window, with some margin. SILENCE_DB (-45) is unreachable during ambient
// silence on VOICE_COMMUNICATION mode (AGC keeps the noise floor above -45), so
// a metering-based "confirmed quiet" gate is not viable on this device without
// first logging and calibrating actual dBFS values.
const VAD_DELAY_MS = 500;

// ── STT hallucination guard ────────────────────────────────────────────────────
// Minimum detected-speech duration before the segment is sent to STT.
// Deepgram/Whisper will hallucinate ("Still there.", "Thank you.", etc.) on
// near-silence or very short audio. Only applied on metering-capable devices;
// null-metering devices always pass through (they have no other submit path).
const MIN_STT_SPEECH_MS = 300;

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
  /** Stop Ashley mid-sentence and reopen the mic immediately. */
  interrupt: () => void;
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
  /** Audit log entries (newest first, capped at 40). Debug overlay only. */
  auditLog: string[];
} & VoiceCallActions {
  const [phase, setPhase] = useState<VoiceCallPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [ashleyResponse, setAshleyResponse] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [auditLog, setAuditLog] = useState<string[]>([]);

  const addLog = useCallback((msg: string): void => {
    const ts = new Date().toISOString().slice(11, 22); // HH:MM:SS.mm
    setAuditLog(prev => [`${ts} ${msg}`, ...prev].slice(0, 40));
  }, []);

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
  // True from when playNext shifts a URI until the track finishes/errors.
  // Bridges the gap where playerRef is null between tracks but playback is
  // still in progress — prevents tts_done from opening the mic too early.
  const playBusyRef = useRef(false);
  // Mutex: only one playNext call may be in flight at a time. Concurrent
  // callers (flushChunkBuffer + didJustFinish arriving as separate JS tasks
  // before the first microtask runs) return early — the running instance
  // drains the queue via the didJustFinish → playNext loop.
  const playNextRunningRef = useRef(false);

  const playNextRef = useRef<() => Promise<void>>(async () => {});
  const recorder = useVoiceRecorder();

  // ── VAD state ─────────────────────────────────────────────────────────────

  const isUserSpeakingRef   = useRef(false);
  const lastSpeechAtRef     = useRef(0);
  const segmentSpeechMsRef  = useRef(0);
  const speechStartAtRef    = useRef(0);
  const vadActiveRef        = useRef(false); // true only while mic should be running
  const autoSubmitTimerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Intent-based silence threshold: server sends set_silence_threshold before
  // the LLM pipeline; openMic() picks it up and resets to SILENCE_MS afterward.
  const nextSilenceThresholdRef = useRef<number | null>(null);
  const activeSilenceMsRef      = useRef<number>(SILENCE_MS);
  const reconnectAttemptsRef = useRef(0);
  const connectRef          = useRef<() => void>(() => {});
  // ttsServerDoneRef: true once the server has sent tts_done (all chunks sent).
  // ttsCompleteRef:   true once the device has finished PLAYING all queued audio.
  // Both must be true before openMic is allowed to run.
  // Separating them prevents the mic from opening during the gap between
  // "server finished sending" and "device finished playing".
  // Starts false — there is no audio in flight until the server sends
  // speech_start for a real turn. Defaulting to true previously caused
  // the mic to open before the first turn's lifecycle had begun.
  const ttsServerDoneRef    = useRef(false);
  const ttsCompleteRef      = useRef(true);
  // responseEndReceivedRef: true once the server has sent "response_end" for
  // the current turn. The client MUST NOT send playback_confirmed until this
  // is true — prevents inter-sentence queue drains from triggering premature
  // confirmation.
  const responseEndReceivedRef = useRef<boolean>(false);
  // Mutex: prevents two concurrent openMic calls from both calling
  // prepareToRecordAsync — the second call would throw "already been prepared".
  const micOpeningRef       = useRef(false);

  // ── VAD open-mic delay ref ────────────────────────────────────────────────
  // Handle for the plain 500ms delay timer that holds VAD inactive after
  // recorder.start(). Cancelled by submitSegment if a submit races the delay.
  const vadDelayTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── STT hallucination guard ref ────────────────────────────────────────────
  // Set to true on the first non-null metering reading each segment.
  // Lets submitSegment distinguish "no speech on a metering device" from
  // "null-metering device that should always pass through".
  const meteringEverReceivedRef = useRef(false);

  // ── Auxiliary audio (thinking clips, non-turn clips) ──────────────────────
  // These messages carry kind="auxiliary" and must not touch main lifecycle refs.
  const auxChunkBufRef      = useRef<Uint8Array[]>([]);
  const auxPlayerRef        = useRef<AudioPlayer | null>(null);
  // "auxiliary" while receiving an aux clip's binary frames; "main" otherwise.
  const activeSpeechKindRef = useRef<"main" | "auxiliary">("main");

  // ── Audio playback queue ──────────────────────────────────────────────────

  const stopPlayback = useCallback((): void => {
    playQueueRef.current = [];
    playBusyRef.current = false;
    playNextRunningRef.current = false;
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
    // Also stop any in-flight auxiliary clip.
    const ap = auxPlayerRef.current;
    auxPlayerRef.current = null;
    if (ap) {
      try { ap.pause(); } catch { /* ignore */ }
      try { ap.remove(); } catch { /* ignore */ }
    }
  }, []);

  const playNext = useCallback(async (): Promise<void> => {
    // Mutex: if a playNext is already in flight, return immediately.
    // The running instance will drain the queue via its didJustFinish → playNext loop.
    if (playNextRunningRef.current) {
      addLog("playNext: skip — already running");
      return;
    }
    playNextRunningRef.current = true;

    const uri = playQueueRef.current.shift();
    if (!uri) {
      // Queue drained.
      addLog(`playNext: drained responseEnd=${responseEndReceivedRef.current} srvDone=${ttsServerDoneRef.current} phase=${phaseRef.current}`);
      if (phaseRef.current === "speaking") {
        if (ttsServerDoneRef.current) {
          // tts_done already received (server safety timeout path) — open mic directly.
          ttsCompleteRef.current = true;
          addLog("ttsComplete=true — opening mic (safety-timeout path)");
          setPhaseSync("listening");
          void openMicRef.current();
        } else if (responseEndReceivedRef.current) {
          // Server has confirmed all audio sent AND our queue is empty — send confirmation.
          // This is the ONLY valid time to send playback_confirmed. Before response_end
          // arrives, an empty queue means "inter-sentence gap", not "response complete".
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ type: "playback_confirmed" }));
            addLog("WS playback_confirmed → sent (response_end + queue empty)");
          }
        } else {
          // Queue is empty but server has NOT sent response_end yet.
          // This is an inter-sentence gap — do nothing. Wait for the next sentence's
          // audio to arrive and be queued. Do NOT send any confirmation.
          addLog("playNext: queue empty, response_end not yet received — waiting for next sentence");
        }
      }
      playNextRunningRef.current = false;
      return;
    }

    playBusyRef.current = true;
    // Do NOT call setAudioModeAsync({ allowsRecording: false }) here.
    // Switching the audio mode tears down the VOICE_COMMUNICATION session and
    // disables hardware echo cancellation. Keep allowsRecording: true for the
    // entire call — voiceInput's start() set it and it must stay active.
    try {
      const player = createAudioPlayer({ uri });
      playerRef.current = player;
      playerUriRef.current = uri;
      addLog(`player: started q=${playQueueRef.current.length}`);
      setPhaseSync("speaking");
      // One-shot guard: expo-audio can fire didJustFinish more than once for
      // the same player on Android; the second fire would double-release the
      // mutex and start a second concurrent playNext.
      let trackFinished = false;
      player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) {
          if (trackFinished) return;
          trackFinished = true;
          addLog("player: finished");
          playBusyRef.current = false;
          playerRef.current = null;
          playerUriRef.current = null;
          // Release mutex BEFORE calling playNext so the next call can enter.
          playNextRunningRef.current = false;
          try { player.remove(); } catch { /* ignore */ }
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => { /* ignore */ });
          void playNextRef.current();
        }
      });
      player.play();
      // Note: playNextRunningRef stays true until didJustFinish releases it.
    } catch {
      playBusyRef.current = false;
      playNextRunningRef.current = false;
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
      // Always call playNext — the mutex inside ensures only one runs at a time.
      void playNextRef.current();
    } catch { /* audio lost, call continues */ }
  }, []);

  // Fire-and-forget: decode and play the current aux chunk buffer independently
  // of the main playback queue, with no lifecycle side-effects.
  const flushAuxChunkBuffer = useCallback(async (): Promise<void> => {
    const chunks = auxChunkBufRef.current;
    auxChunkBufRef.current = [];
    if (chunks.length === 0) return;
    const combined = concatChunks(chunks);
    const b64 = toBase64(combined);
    const dir = FileSystem.cacheDirectory;
    if (!dir) return;
    const uri = `${dir}vc-aux-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`;
    try {
      await FileSystem.writeAsStringAsync(uri, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      // Stop any previous aux clip before starting the new one.
      const prev = auxPlayerRef.current;
      auxPlayerRef.current = null;
      if (prev) {
        try { prev.pause(); } catch { /* ignore */ }
        try { prev.remove(); } catch { /* ignore */ }
      }
      const player = createAudioPlayer({ uri });
      auxPlayerRef.current = player;
      player.addListener("playbackStatusUpdate", (status) => {
        if (status.didJustFinish) {
          auxPlayerRef.current = null;
          try { player.remove(); } catch { /* ignore */ }
          FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => { /* ignore */ });
        }
      });
      player.play();
      addLog("aux: playing thinking clip");
    } catch { /* aux audio lost, call continues */ }
  }, [addLog]);

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
    if (phaseRef.current === "submitting" || phaseRef.current === "thinking" || phaseRef.current === "speaking") {
      addLog(`submit BLOCKED phase=${phaseRef.current}`);
      return;
    }
    clearAutoSubmitTimer();
    // Cancel the VAD open-mic delay timer so it cannot re-enable VAD after
    // we transition to "submitting" (guards against submitNow racing the delay).
    if (vadDelayTimerRef.current !== null) {
      clearTimeout(vadDelayTimerRef.current);
      vadDelayTimerRef.current = null;
    }
    vadActiveRef.current = false;
    setPhaseSync("submitting");

    const audio = await recorder.stop();
    if (!audio) {
      // Nothing useful — reopen mic and wait for more speech.
      setPhaseSync("listening");
      void openMicRef.current();
      return;
    }

    // ── STT hallucination guard ─────────────────────────────────────────────
    // If this device provided metering readings (non-null metering device) but
    // detected speech for less than MIN_STT_SPEECH_MS, the segment is likely
    // near-silence bait for STT hallucination ("Still there.", "Thank you.",
    // etc. from Deepgram/Whisper). Null-metering devices always pass through —
    // they have no other detection path and must rely on the autoSubmit fallback.
    if (meteringEverReceivedRef.current && segmentSpeechMsRef.current < MIN_STT_SPEECH_MS) {
      addLog(`submit skip: speech ${segmentSpeechMsRef.current}ms < ${MIN_STT_SPEECH_MS}ms`);
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
    const db = recorder.metering;
    if (db === null) return;
    meteringEverReceivedRef.current = true;

    if (!vadActiveRef.current) return;

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
      // Option C: reset the fallback timer on every detected sound so it only
      // fires after genuine post-sound silence, not from mic-open alone.
      // Only restart if the timer is currently armed (openMic set it) —
      // prevents arming a new timer after it has already fired and submitted.
      if (autoSubmitTimerRef.current !== null) {
        clearAutoSubmitTimer();
        autoSubmitTimerRef.current = setTimeout(() => {
          autoSubmitTimerRef.current = null;
          addLog(`autoSubmit fired phase=${phaseRef.current}`);
          if (
            phaseRef.current === "listening" ||
            phaseRef.current === "user_speaking"
          ) {
            vadActiveRef.current = false;
            void submitSegmentRef.current();
          }
        }, 4000);
      }
    } else {
      // Silence.
      // Adaptive threshold: segments with < 1000ms of detected speech get
      // SILENCE_MS_SHORT (4500ms) tolerance — they are likely sentence openers
      // ("Hey,", "Sorry,") where a thinking pause should not trigger submit.
      // Longer segments use the standard activeSilenceMsRef (SILENCE_MS=3500ms
      // or a server-pushed override). Math.max keeps server overrides intact.
      const effectiveSilenceMs =
        segmentSpeechMsRef.current < SILENCE_THRESHOLD_SHORT_MS
          ? Math.max(SILENCE_MS_SHORT, activeSilenceMsRef.current)
          : activeSilenceMsRef.current;
      if (
        isUserSpeakingRef.current &&
        segmentSpeechMsRef.current >= MIN_SPEECH_MS &&
        now - lastSpeechAtRef.current >= effectiveSilenceMs
      ) {
        // User has stopped talking long enough — submit.
        isUserSpeakingRef.current = false;
        segmentSpeechMsRef.current = 0;
        void submitSegmentRef.current();
      }
    }
  }, [recorder.metering, setPhaseSync, clearAutoSubmitTimer, addLog]);

  // ── openMic ───────────────────────────────────────────────────────────────

  const openMic = useCallback(async (): Promise<void> => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (phaseRef.current === "ended") return;
    if (!ttsCompleteRef.current) {
      addLog(`openMic BLOCKED ttsComplete=false srvDone=${ttsServerDoneRef.current}`);
      return;
    }
    if (micOpeningRef.current) {
      addLog("openMic BLOCKED mutex");
      return;
    }
    addLog("openMic start");
    micOpeningRef.current = true;

    // Reset VAD state for new segment.
    isUserSpeakingRef.current = false;
    lastSpeechAtRef.current = 0;
    segmentSpeechMsRef.current = 0;
    speechStartAtRef.current = 0;
    clearAutoSubmitTimer();
    // Apply intent-based threshold if server requested one, then reset.
    activeSilenceMsRef.current = nextSilenceThresholdRef.current ?? SILENCE_MS;
    nextSilenceThresholdRef.current = null;

    const ok = await recorder.ensurePermission();
    if (!ok) {
      micOpeningRef.current = false;
      setError("Microphone permission denied");
      return;
    }
    try {
      await recorder.start();
      // ── VAD open-mic delay ────────────────────────────────────────────────
      // Hold VAD inactive for VAD_DELAY_MS (500ms) after the mic opens.
      // This is a known heuristic: it covers the ~300-400ms Bluetooth A2DP
      // drain window so TTS tail audio cannot trigger detection on reopen.
      // A metering-based confirmation is not viable on this device because
      // VOICE_COMMUNICATION mode AGC keeps the noise floor above SILENCE_DB
      // (-45 dBFS) even in genuine silence — see Dump #4 for full diagnosis.
      meteringEverReceivedRef.current = false;
      vadDelayTimerRef.current = setTimeout(() => {
        vadDelayTimerRef.current = null;
        if (phaseRef.current === "listening") {
          vadActiveRef.current = true;
          addLog("VAD delay: 500ms elapsed — active");
        }
      }, VAD_DELAY_MS);
      setPhaseSync("listening");
      addLog("openMic OK — recording (500ms delay)");
      micOpeningRef.current = false;

      // Fallback: if metering-based VAD never fires (metering null on this
      // device), auto-submit after 4 s so the call doesn't hang forever.
      autoSubmitTimerRef.current = setTimeout(() => {
        autoSubmitTimerRef.current = null;
        addLog(`autoSubmit fired phase=${phaseRef.current}`);
        if (
          phaseRef.current === "listening" ||
          phaseRef.current === "user_speaking"
        ) {
          vadActiveRef.current = false;
          void submitSegmentRef.current();
        }
      }, 4000);
    } catch (err) {
      micOpeningRef.current = false;
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
        if (activeSpeechKindRef.current === "auxiliary") {
          auxChunkBufRef.current.push(new Uint8Array(event.data));
        } else {
          chunkBufRef.current.push(new Uint8Array(event.data));
        }
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

        case "speech_start": {
          const kind = (msg["kind"] as string | undefined) ?? "main";
          if (kind === "auxiliary") {
            // Auxiliary clip (e.g. thinking clip) — reset only the aux buffer.
            // Do NOT touch main lifecycle refs.
            auxChunkBufRef.current = [];
            activeSpeechKindRef.current = "auxiliary";
            addLog("WS speech_start(aux) — aux buffer reset");
          } else {
            // Main turn speech — reset all lifecycle gates as before.
            chunkBufRef.current = [];
            ttsCompleteRef.current = false;        // device not done playing
            ttsServerDoneRef.current = false;      // server not done sending
            responseEndReceivedRef.current = false; // server has not yet confirmed response complete
            activeSpeechKindRef.current = "main";
            addLog("WS speech_start(main) — gates reset");
          }
          break;
        }

        case "sentence_end": {
          const kind = (msg["kind"] as string | undefined) ?? "main";
          if (kind === "auxiliary") {
            await flushAuxChunkBuffer();
            addLog("WS sentence_end(aux) — aux buffer flushed");
          } else {
            await flushChunkBuffer();
            addLog("WS sentence_end(main) — chunk buffer flushed");
          }
          break;
        }

        case "response_end": {
          const kind = (msg["kind"] as string | undefined) ?? "main";
          if (kind !== "main") break; // defensive: ignore any auxiliary response_end
          // Server has dispatched all TTS chunks for this turn.
          // The client may now send playback_confirmed once the play queue drains.
          responseEndReceivedRef.current = true;
          addLog("WS response_end — all audio sent by server");
          // If the queue already drained before response_end arrived, trigger playNext
          // so the confirmation can be sent now rather than waiting for the next drain.
          if (!playNextRunningRef.current) {
            void playNextRef.current();
          }
          break;
        }

        case "tts_done": {
          const kind = (msg["kind"] as string | undefined) ?? "main";
          if (kind === "auxiliary") {
            // Aux clip finished — restore routing to main, no lifecycle effect.
            activeSpeechKindRef.current = "main";
            addLog("WS tts_done(aux) — aux clip done, routing restored to main");
            break;
          }
          // Main turn tts_done — existing lifecycle.
          await flushChunkBuffer();
          const text = (msg["responseText"] as string | undefined) ?? "";
          if (text) setAshleyResponse(text);
          ttsServerDoneRef.current = true;
          addLog(`WS tts_done(main) — q=${playQueueRef.current.length} running=${playNextRunningRef.current}`);
          // Route through playNext so the same drain logic handles both the
          // "no audio queued" case and the "last track just finished" case.
          // The mutex ensures this is a no-op if playback is already in flight.
          void playNextRef.current();
          break;
        }

        case "interrupt_ack":
          ttsCompleteRef.current = true;
          stopPlayback();
          setPhaseSync("listening");
          void openMicRef.current();
          break;

        case "reconnect_ok":
          ttsCompleteRef.current = true;
          reconnectAttemptsRef.current = 0;
          setError(null);
          void openMicRef.current();
          break;

        case "set_silence_threshold": {
          const ms = msg["ms"] as number | undefined;
          if (typeof ms === "number" && ms > 0) {
            nextSilenceThresholdRef.current = ms;
            addLog(`WS set_silence_threshold — next=${ms}ms`);
          }
          break;
        }

        case "call_ended":
          break;

        case "error":
          setError((msg["message"] as string) || "Server error");
          break;
      }
    },
    [flushChunkBuffer, flushAuxChunkBuffer, stopPlayback, setPhaseSync],
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
      if (vadDelayTimerRef.current !== null) {
        clearTimeout(vadDelayTimerRef.current);
        vadDelayTimerRef.current = null;
      }
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

  const interrupt = useCallback((): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (phaseRef.current !== "speaking") return;
    addLog("interrupt: tap");
    stopPlayback();
    // Kick the drain path so playback_confirmed is sent if response_end already
    // arrived — closes the Path C stuck-state if ws.send throws below.
    void playNextRef.current();
    try { ws.send(JSON.stringify({ type: "interrupt" })); } catch { /* ignore */ }
  }, [stopPlayback, addLog]);

  return {
    phase,
    sessionId,
    userTranscript,
    ashleyResponse,
    auditLog,
    error,
    metering: recorder.metering,
    connect,
    disconnect,
    submitNow,
    interrupt,
  };
}
