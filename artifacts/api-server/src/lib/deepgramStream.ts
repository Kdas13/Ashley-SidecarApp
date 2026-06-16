// ---------------------------------------------------------------------------
// deepgramStream.ts — Streaming Deepgram STT adapter for voice calls.
//
// EXISTING deepgram.ts IS FROZEN. Do NOT modify it.
// This file is the NEW streaming-only adapter used by the voice-call route.
//
// Connects to wss://api.deepgram.com/v1/listen and forwards binary audio
// frames from the client. Fires callbacks for partial and final transcripts.
//
// Reconnect policy: one automatic reconnect on error. If the reconnect also
// fails, onFatalError fires and the call must end gracefully.
//
// Required env var: DEEPGRAM_API_KEY
// ---------------------------------------------------------------------------

import { logger } from "./logger.js";
// @ts-ignore – ws has no bundled types; @types/ws not yet installed
import WsConstructor from "ws";

// ---------------------------------------------------------------------------
// Minimal inline types for the ws WebSocket CLIENT (not the server-side WS).
// We only need the subset of the API we actually call.
// ---------------------------------------------------------------------------
interface WsClient {
  readyState: number;
  on(event: "open", cb: () => void): this;
  on(event: "message", cb: (data: Buffer | string) => void): this;
  on(event: "close", cb: (code: number, reason: Buffer) => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  send(data: Buffer | string): void;
  close(code?: number): void;
  removeAllListeners(): this;
}

const WS_OPEN = 1; // ws.readyState value for an open connection

const DEEPGRAM_STREAM_URL = "wss://api.deepgram.com/v1/listen";
const DEEPGRAM_PARAMS =
  "model=nova-3&smart_format=true&punctuate=true&interim_results=true";

// Max audio frames to queue while the WS is connecting/reconnecting.
// Prevents unbounded memory growth if the caller sends audio before open.
const MAX_QUEUE_LENGTH = 200;

// ---------------------------------------------------------------------------
// Deepgram streaming response shape — only the fields we use.
// ---------------------------------------------------------------------------
interface DgResult {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: Array<unknown>;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------
export interface DeepgramStream {
  sendAudio(chunk: Buffer): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createDeepgramStream(
  onFinal: (text: string, utteranceId: string) => void,
  onPartial: (text: string) => void,
  onError: (err: Error) => void,
  onFatalError: (err: Error) => void,
): DeepgramStream {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    // Defer so caller can attach handlers before this fires.
    setTimeout(
      () => onFatalError(new Error("DEEPGRAM_API_KEY not configured")),
      0,
    );
    return { sendAudio: () => {}, close: () => {} };
  }

  let ws: WsClient | null = null;
  let audioQueue: Buffer[] = [];
  let closing = false;

  // ---------------------------------------------------------------------------
  // Internal: open a new WebSocket connection to Deepgram.
  // isReconnect=false  → first attempt; calls onError then tries again.
  // isReconnect=true   → reconnect attempt; calls onFatalError on failure.
  // ---------------------------------------------------------------------------
  function connect(isReconnect: boolean): WsClient {
    const url = `${DEEPGRAM_STREAM_URL}?${DEEPGRAM_PARAMS}`;
    const sock = new (WsConstructor as new (
      url: string,
      opts: object,
    ) => WsClient)(url, {
      headers: { Authorization: `Token ${apiKey}` },
    });

    sock.on("open", () => {
      logger.info(
        { isReconnect },
        "deepgramStream: connected to Deepgram streaming endpoint",
      );
      // Flush any audio frames that arrived while connecting.
      const queued = audioQueue;
      audioQueue = [];
      for (const chunk of queued) {
        try {
          sock.send(chunk);
        } catch (sendErr) {
          logger.warn({ err: sendErr }, "deepgramStream: failed to flush queued frame");
        }
      }
    });

    sock.on("message", (raw: Buffer | string) => {
      let data: DgResult;
      try {
        data = JSON.parse(
          Buffer.isBuffer(raw) ? raw.toString("utf8") : raw,
        ) as DgResult;
      } catch {
        return; // binary keepalive / non-JSON frame — ignore
      }

      if (data.type !== "Results") return;

      const alt = data.channel?.alternatives?.[0];
      const transcript = (alt?.transcript ?? "").trim();
      const words = alt?.words ?? [];
      const isFinal = data.is_final === true;
      const speechFinal = data.speech_final === true;

      if (speechFinal) {
        logger.info(
          { transcriptPreview: transcript.slice(0, 80), wordCount: words.length },
          "deepgramStream: speech_final received",
        );
        // Ignore empty / whitespace finals.
        if (!transcript) return;
        // Ignore very short noise (< 1 word).
        if (words.length === 0) return;
        const utteranceId = crypto.randomUUID();
        onFinal(transcript, utteranceId);
      } else if (isFinal) {
        if (!transcript) return;
        logger.info(
          { transcriptPreview: transcript.slice(0, 80) },
          "deepgramStream: is_final (interim) received",
        );
        onPartial(transcript);
      }
    });

    sock.on("close", (code: number, reason: Buffer) => {
      const reasonStr = reason.toString();
      logger.info({ code, reason: reasonStr }, "deepgramStream: ws closed");
      // Unexpected close (caller didn't call close()) — treat as error.
      if (!closing) {
        const err = new Error(
          `Deepgram WS closed unexpectedly: code=${code} reason=${reasonStr}`,
        );
        if (!isReconnect) {
          onError(err);
          // Attempt one reconnect.
          logger.info("deepgramStream: attempting reconnect after unexpected close");
          ws = connect(true);
        } else {
          onFatalError(err);
        }
      }
    });

    sock.on("error", (err: Error) => {
      logger.error(
        { err, isReconnect },
        "deepgramStream: ws error",
      );
      if (closing) return;

      if (!isReconnect) {
        onError(err);
        logger.info("deepgramStream: attempting reconnect after error");
        ws = connect(true);
      } else {
        onFatalError(err);
      }
    });

    return sock;
  }

  ws = connect(false);

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------
  return {
    sendAudio(chunk: Buffer): void {
      if (closing) return;
      logger.debug({ bytes: chunk.byteLength }, "deepgramStream: sendAudio");
      if (ws && ws.readyState === WS_OPEN) {
        try {
          ws.send(chunk);
        } catch (err) {
          logger.warn({ err }, "deepgramStream: send failed, queuing frame");
          if (audioQueue.length < MAX_QUEUE_LENGTH) {
            audioQueue.push(chunk);
          }
        }
      } else {
        // Queue while connecting or reconnecting.
        if (audioQueue.length < MAX_QUEUE_LENGTH) {
          audioQueue.push(chunk);
        } else {
          logger.warn("deepgramStream: audio queue full, dropping frame");
        }
      }
    },

    close(): void {
      closing = true;
      audioQueue = [];
      if (ws) {
        try {
          ws.removeAllListeners();
          ws.close(1000);
        } catch {
          // ignore close errors
        }
        ws = null;
      }
      logger.info("deepgramStream: closed by caller");
    },
  };
}
