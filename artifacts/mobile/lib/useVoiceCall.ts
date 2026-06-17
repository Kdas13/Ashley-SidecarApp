// ---------------------------------------------------------------------------
// useVoiceCall — orchestrates the live voice-call loop.
//
// Architecture:
//   WebSocket  ←→  /api/voice/call
//   Binary MP3 chunks arrive per sentence; a sentence_end JSON frame signals
//   "this sentence is fully buffered — write to disk and start playing".
//   tts_done signals the full turn is over (flush any remainder).
//   Push-to-talk: pressIn = start recording, pressOut = stop + transcribe +
//   send speech_final. Pressing while Ashley is speaking interrupts her.
//
// Audio queue:
//   Sentences are queued as temp .mp3 files. playNext() dequeues one file,
//   plays it with expo-audio, and on didJustFinish calls itself recursively
//   to drain the queue. When the queue empties after tts_done, phase → listening.
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

// ── Types ────────────────────────────────────────────────────────────────────

export type VoiceCallPhase =
  | "idle"          // not started
  | "connecting"    // WS handshake in progress
  | "listening"     // connected, waiting for user to press mic
  | "recording"     // user holding mic button
  | "transcribing"  // audio posted to STT endpoint
  | "thinking"      // speech_final sent, server LLM running
  | "speaking"      // receiving / playing Ashley's audio
  | "ended";        // call over (normal hangup or WS close)

export interface VoiceCallActions {
  connect: () => void;
  disconnect: () => void;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  cancelRecording: () => Promise<void>;
}

// ── Private helpers ──────────────────────────────────────────────────────────

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
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function toBase64(arr: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceCall(): {
  phase: VoiceCallPhase;
  sessionId: string | null;
  userTranscript: string;
  ashleyResponse: string;
  error: string | null;
} & VoiceCallActions {
  const [phase, setPhase] = useState<VoiceCallPhase>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [userTranscript, setUserTranscript] = useState("");
  const [ashleyResponse, setAshleyResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Keep a ref so async callbacks always read current phase without stale closure.
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

  // Ref to playNext so the didJustFinish closure can call the latest version.
  const playNextRef = useRef<() => Promise<void>>(async () => {});

  const recorder = useVoiceRecorder();

  // ── Audio queue ────────────────────────────────────────────────────────────

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
      // Queue drained — go back to listening if we are still in a speaking phase.
      if (phaseRef.current === "speaking") setPhaseSync("listening");
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
      // Player creation failed — skip this file and try the next.
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => { /* ignore */ });
      void playNextRef.current();
    }
  }, [setPhaseSync]);

  // Keep ref current after each render.
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
      // Kick off the queue if nothing is currently playing.
      if (!playerRef.current) void playNextRef.current();
    } catch {
      /* ignore write errors — audio is lost but the call continues */
    }
  }, []);

  // ── WS message handler ─────────────────────────────────────────────────────

  const handleMessage = useCallback(
    async (event: MessageEvent): Promise<void> => {
      // Binary frames = raw MP3 chunks.
      if (event.data instanceof ArrayBuffer) {
        chunkBufRef.current.push(new Uint8Array(event.data));
        return;
      }
      if (typeof event.data !== "string") return;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        return;
      }

      switch (msg["type"] as string) {
        case "call_connected":
          setSessionId((msg["sessionId"] as string) ?? null);
          setPhaseSync("listening");
          break;

        case "speech_start":
          // Clear any leftover chunks from a previous (interrupted) turn.
          chunkBufRef.current = [];
          setPhaseSync("thinking");
          break;

        case "sentence_end":
          // All binary chunks for this sentence have arrived — flush to disk
          // and enqueue for playback.
          await flushChunkBuffer();
          break;

        case "tts_done": {
          // Flush any trailing partial sentence.
          await flushChunkBuffer();
          const text = (msg["responseText"] as string | undefined) ?? "";
          if (text) setAshleyResponse(text);
          // If nothing queued and nothing playing, go straight to listening.
          if (playQueueRef.current.length === 0 && !playerRef.current) {
            setPhaseSync("listening");
          }
          break;
        }

        case "interrupt_ack":
          stopPlayback();
          setPhaseSync("listening");
          break;

        case "reconnect_ok":
          setPhaseSync("listening");
          break;

        case "call_ended":
          // onclose handles cleanup.
          break;

        case "error":
          setError((msg["message"] as string) || "Server error");
          break;
      }
    },
    [flushChunkBuffer, stopPlayback, setPhaseSync],
  );

  // ── Connect ────────────────────────────────────────────────────────────────

  const connect = useCallback((): void => {
    if (wsRef.current) return;
    setPhaseSync("connecting");
    setError(null);
    setUserTranscript("");
    setAshleyResponse("");

    const url = voiceWsUrl();
    const key = process.env.EXPO_PUBLIC_API_KEY ?? "";
    const deviceId = getDeviceIdSync();

    // React Native's WebSocket accepts custom headers via a 3rd options arg.
    // The lib.dom.d.ts definition only declares 2 parameters, so we cast the
    // constructor to bypass that restriction without touching the instance type.
    type RNWebSocket = new (
      url: string,
      protocols: string | string[] | null,
      options: { headers: Record<string, string> },
    ) => WebSocket;
    const RNWebSocketCtor = WebSocket as unknown as RNWebSocket;
    const ws = new RNWebSocketCtor(url, null, {
      headers: {
        Authorization: `Bearer ${key}`,
        "X-Device-Id": deviceId,
      },
    });

    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (e: MessageEvent) => {
      void handleMessage(e);
    };
    ws.onerror = () => {
      setError("Connection error — check network and API key");
      setPhaseSync("ended");
    };
    ws.onclose = () => {
      wsRef.current = null;
      stopPlayback();
      chunkBufRef.current = [];
      if (phaseRef.current !== "ended") setPhaseSync("ended");
    };
  }, [handleMessage, stopPlayback, setPhaseSync]);

  // ── Disconnect ─────────────────────────────────────────────────────────────

  const disconnect = useCallback((): void => {
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
  }, [stopPlayback, recorder, setPhaseSync]);

  // ── Recording ──────────────────────────────────────────────────────────────

  const startRecording = useCallback(async (): Promise<void> => {
    // Interrupt Ashley if she is speaking.
    if (phaseRef.current === "speaking" || phaseRef.current === "thinking") {
      stopPlayback();
    }
    const ok = await recorder.ensurePermission();
    if (!ok) {
      setError("Microphone permission denied");
      return;
    }
    try {
      await recorder.start();
      setPhaseSync("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start recording");
    }
  }, [recorder, stopPlayback, setPhaseSync]);

  const stopRecording = useCallback(async (): Promise<void> => {
    if (phaseRef.current !== "recording") return;
    setPhaseSync("transcribing");

    const audio = await recorder.stop();
    if (!audio) {
      setPhaseSync("listening");
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
          "X-Device-Id": deviceId,
        },
        body: JSON.stringify({
          audioBase64: audio.audioBase64,
          mimeType: audio.mimeType,
        }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = (await resp.json()) as { transcript?: string };
      const tx = (data.transcript ?? "").trim();
      if (!tx) {
        setPhaseSync("listening");
        return;
      }
      setUserTranscript(tx);

      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        setError("Connection lost");
        setPhaseSync("ended");
        return;
      }
      const utteranceId = Math.random().toString(36).slice(2);
      ws.send(
        JSON.stringify({ type: "speech_final", transcript: tx, utteranceId }),
      );
      setPhaseSync("thinking");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
      setPhaseSync("listening");
    }
  }, [recorder, setPhaseSync]);

  const cancelRecording = useCallback(async (): Promise<void> => {
    await recorder.cancel();
    setPhaseSync("listening");
  }, [recorder, setPhaseSync]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopPlayback();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
    };
  }, [stopPlayback]);

  return {
    phase,
    sessionId,
    userTranscript,
    ashleyResponse,
    error,
    connect,
    disconnect,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
