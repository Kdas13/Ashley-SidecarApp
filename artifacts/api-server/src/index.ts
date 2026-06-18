import app from "./app";
import { logger } from "./lib/logger";
import { db, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tickProactive } from "./lib/proactiveScheduler";
import { timingSafeEqual } from "node:crypto";
// @ts-ignore – ws ships no bundled types; @types/ws not yet installed
import { WebSocketServer } from "ws";
import * as registry from "./lib/VoiceSessionRegistry";
import { restoreRecoveringSessions } from "./lib/VoiceSessionRegistry";
import { handleVoiceTurn, startSilenceMonitor } from "./routes/voice-call";
import * as VoiceOrchestrationService from "./lib/VoiceOrchestrationService";
import { initialize as initAudioClips } from "./lib/AudioClipRegistry";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err: unknown) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // P1-1: restore any voice sessions that were mid-call on last process exit.
  restoreRecoveringSessions().catch((err) => {
    logger.error({ err }, "[P1-1] Failed to restore recovering sessions");
  });

  // P1-4: pre-generate audio clips for voice calls (non-blocking).
  initAudioClips().catch((err) => {
    logger.warn({ err }, "AudioClipRegistry: startup initialization failed");
  });

  // Presence-Loop boot recovery: any messages row left in `status='streaming'`
  // from a previous process is an orphan — the SSE response that owned it has
  // already disconnected, so the client will never see another delta for it.
  // Flip those rows to `interrupted` so the UI can offer Continue / Retry on
  // next state hydration instead of showing a forever-empty bubble.
  void (async () => {
    try {
      const updated = await db
        .update(messagesTable)
        .set({ status: "interrupted" })
        .where(eq(messagesTable.status, "streaming"))
        .returning({ id: messagesTable.id });
      if (updated.length > 0) {
        logger.warn(
          { count: updated.length, ids: updated.map((r) => r.id) },
          "Recovered orphan streaming messages → interrupted",
        );
      } else {
        logger.info("No orphan streaming messages to recover");
      }
    } catch (recoverErr) {
      logger.error(
        { err: recoverErr },
        "Failed to recover orphan streaming messages on boot",
      );
    }
  })();

  // Keepalive: Replit dev hibernates workflows after ~10min without external
  // HTTP traffic, which causes 502s mid-conversation and lost replies. Hit
  // our own public proxy URL every 60s so the workflow looks active. Uses
  // REPLIT_DEV_DOMAIN if available; otherwise falls back to localhost (which
  // won't satisfy the external-traffic check, but at least keeps the event
  // loop busy and surfaces the keepalive in logs for debugging).
  const publicDomain = process.env["REPLIT_DEV_DOMAIN"];
  const keepaliveUrl = publicDomain
    ? `https://${publicDomain}/api/healthz`
    : `http://127.0.0.1:${port}/api/healthz`;
  const intervalMs = 60_000;
  const tick = async (): Promise<void> => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10_000);
      const res = await fetch(keepaliveUrl, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) {
        logger.warn(
          { status: res.status, url: keepaliveUrl },
          "Keepalive ping returned non-2xx",
        );
      }
    } catch (err) {
      logger.warn({ err, url: keepaliveUrl }, "Keepalive ping failed");
    }
  };
  setInterval(() => void tick(), intervalMs).unref();
  // First tick after 5s so the server is fully listening.
  setTimeout(() => void tick(), 5_000).unref();

  // Proactive ("Ashley reaches out first") scheduler. Ticks every 5 min,
  // first run 30s after boot so the server is settled and the keepalive
  // ping has already proven the network is healthy. tickProactive() never
  // throws — every error is caught + logged inside, so a bad tick can't
  // crash the workflow. See lib/proactiveScheduler.ts for the eligibility
  // ladder + cap math.
  const proactiveIntervalMs = 5 * 60 * 1000;
  const runProactiveTick = (): void => {
    void tickProactive().catch((err) => {
      logger.error({ err }, "Proactive tick threw (caught at boundary)");
    });
  };
  setInterval(runProactiveTick, proactiveIntervalMs).unref();
  setTimeout(runProactiveTick, 30_000).unref();
});

// ── Voice-call WebSocket (Phase 1: echo spike) ───────────────────────────────
//
// Path:   ws[s]://<host>/api/voice/call
// Auth:   Authorization: Bearer <API_AUTH_KEY>   (same key as HTTP routes)
//         X-Device-Id: <uuid>                    (same header as HTTP routes)
//
// noServer: true — we own the HTTP upgrade event so Express keeps handling
// every normal request; only the specific path is handed to the WS server.
//
// Phase 1 behaviour: acknowledge connection with a JSON `connected` frame,
// then echo every incoming message back prefixed with "[echo] ". No STT /
// LLM / TTS yet — this proves the socket plumbing end-to-end.

function safeEqualBuf(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const VOICE_WS_PATH = "/api/voice/call";
const DEVICE_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wss: any = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const raw = req.url ?? "/";
  let pathname: string;
  try {
    pathname = new URL(raw, `http://localhost:${port}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== VOICE_WS_PATH) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const expected = (process.env["API_AUTH_KEY"] ?? "").trim();
  if (!expected) {
    logger.error("Voice-call WS: API_AUTH_KEY not configured");
    socket.write("HTTP/1.1 500 Server Config Error\r\n\r\n");
    socket.destroy();
    return;
  }

  const authHeader = (
    (req.headers["authorization"] as string | undefined) ?? ""
  ).trim();
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = (match?.[1] ?? "").trim();
  if (!token || !safeEqualBuf(token, expected)) {
    logger.warn("Voice-call WS: rejected — bad auth token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const deviceId = (
    (req.headers["x-device-id"] as string | undefined) ?? ""
  ).trim();
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    logger.warn("Voice-call WS: rejected — missing/invalid X-Device-Id");
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wss.handleUpgrade(req, socket, head, (ws: any) => {
    wss.emit("connection", ws, req, deviceId);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
wss.on("connection", (ws: any, _req: any, deviceId: string) => {
  // Try to reclaim a recovering session (reconnect within 60s window),
  // otherwise create a fresh session. TRAP 2: all state in registry.
  let session = registry.reclaimSession(deviceId, ws as registry.WsLike);
  if (session) {
    // P1-3: windowed rate limit check (replaces lifetime >15 guard).
    if (registry.isReconnectRateLimited(session)) {
      logger.warn(
        {
          deviceId,
          sessionId: session.sessionId,
          reconnectAttempts: session.reconnectAttempts,
          lastCause: session.lastReconnectCause,
        },
        "Voice-call WS: reconnect rate limit exceeded — ending call",
      );
      try {
        ws.send(JSON.stringify({
          type: "call_ended",
          reason: "reconnect_rate_limit_exceeded",
        }));
      } catch {}
      registry.finalise(session.sessionId, "reconnect_rate_limit_exceeded");
      ws.close(1008, "reconnect_rate_limit_exceeded");
      return;
    }
    logger.info(
      {
        deviceId,
        sessionId: session.sessionId,
        gen: session.connectionGeneration,
        reconnectAttempts: session.reconnectAttempts,
        lastCause: session.lastReconnectCause,
      },
      "Voice-call WS: session reclaimed",
    );
  } else {
    // Evict any stale active session for this device before creating a new one.
    // reclaimSession only matches state==="recovering", so an active session
    // that didn't disconnect cleanly falls through here. Without eviction,
    // registry.create overwrites sessionIdByDeviceId but leaves the old session
    // alive in sessionsBySessionId — both run concurrently and both send TTS
    // to the same device, producing two simultaneous conversations.
    const stale = registry.findByDeviceId(deviceId);
    if (stale) {
      logger.warn(
        { deviceId, staleSessionId: stale.sessionId, staleState: stale.state },
        "Voice-call WS: evicting stale session — new connection from same device",
      );
      try {
        stale.ws?.send(JSON.stringify({ type: "call_ended", reason: "replaced_by_new_connection" }));
      } catch { /* ignore — socket may already be dead */ }
      registry.finalise(stale.sessionId, "replaced_by_new_connection");
    }
    session = registry.create(deviceId, ws as registry.WsLike);
    logger.info(
      { deviceId, sessionId: session.sessionId },
      "Voice-call WS: new session created",
    );
  }

  // Send call_connected with sessionId and reconnect flag (1A DoD item 4).
  ws.send(
    JSON.stringify({
      type: "call_connected",
      sessionId: session.sessionId,
      connectionGeneration: session.connectionGeneration,
      reconnected: session.connectionGeneration > 1,
    }),
  );

  // 1I: Start (or restart on reconnect) the silence lifecycle monitor.
  startSilenceMonitor(session);

  // P1-4: Start zombie cleanup interval for this session.
  VoiceOrchestrationService.startOrchestration(session, ws as registry.WsLike);

  // P1-4: On reconnect (generation > 1), acknowledge the drop naturally.
  if (session.connectionGeneration > 1) {
    void VoiceOrchestrationService.handleReconnect(session, ws as registry.WsLike).catch((err) => {
      logger.warn({ err, sessionId: session.sessionId }, "voice: handleReconnect failed");
    });
  }

  const sessionId = session.sessionId; // capture for closure safety

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws.on("message", async (data: any, isBinary: boolean) => {
    const currentSession = registry.findBySessionId(sessionId);
    if (!currentSession) return;

    // P1-4: update heartbeat on every message (zombie detection).
    currentSession.lastActiveHeartbeatAt = new Date();

    // In ws v8+, all frames arrive as Buffer. Use the isBinary flag to
    // distinguish binary audio frames from text JSON control messages.
    if (isBinary) {
      // Binary frame = audio chunk from the client microphone.
      // Update silence tracking when real audio arrives (1I).
      currentSession.lastAudioReceivedAt = new Date();
      currentSession.silenceWarningSent = false;
      // Audio forwarding to Deepgram wired in 1G.
      return;
    }

    // Text frame — JSON control message.
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(
        Buffer.isBuffer(data) ? data.toString("utf8") : String(data),
      ) as Record<string, unknown>;
    } catch {
      logger.warn({ deviceId }, "Voice-call WS: non-JSON text message ignored");
      return;
    }

    const msgSessionId = msg["sessionId"] as string | undefined;
    const msgGen = msg["connectionGeneration"] as number | undefined;

    if (
      msgSessionId !== undefined &&
      msgGen !== undefined &&
      !registry.validateMessage(currentSession, {
        sessionId: msgSessionId,
        connectionGeneration: msgGen,
      })
    ) {
      return; // stale message — already logged by validateMessage
    }

    // P1-4 Stage 2: speech_interim — intent pre-classification only.
    if (msg["type"] === "speech_interim") {
      const interimTranscript = ((msg["transcript"] as string | undefined) ?? "").trim();
      if (interimTranscript) {
        VoiceOrchestrationService.handleSpeechInterim(currentSession, interimTranscript, ws as registry.WsLike);
      }
      return;
    }

    // P1-4: call_end — client-initiated graceful call termination.
    if (msg["type"] === "call_end") {
      logger.info({ deviceId, sessionId: currentSession.sessionId }, "voice: client sent call_end");
      try {
        ws.send(JSON.stringify({ type: "call_ended", reason: "client_call_end" }));
      } catch {}
      registry.finalise(currentSession.sessionId, "client_call_end");
      return;
    }

    if (msg["type"] === "speech_final") {
      const transcript = (msg["transcript"] as string | undefined)?.trim() ?? "";
      const utteranceId = (msg["utteranceId"] as string | undefined) ?? crypto.randomUUID();

      if (!transcript) return;

      // RACE 4: Deepgram finals must not be processed while the session is closing.
      if (
        currentSession.state === "closing" ||
        currentSession.state === "closed" ||
        currentSession.state === "failed"
      ) {
        logger.info(
          { deviceId, state: currentSession.state },
          "voice: speech_final ignored — session is closing",
        );
        return;
      }

      // Idempotency: ignore duplicate utteranceIds.
      if (currentSession.processedUtteranceIds.has(utteranceId)) {
        logger.info({ deviceId, utteranceId }, "voice: duplicate utteranceId ignored");
        return;
      }
      currentSession.processedUtteranceIds.add(utteranceId);

      logger.info({ deviceId, utteranceId, transcriptPreview: transcript.slice(0, 80) }, "voice: speech_final accepted");

      // handleVoiceTurn runs the full pipeline: context → Claude → TTS.
      // TTS, DB writes, and state reset happen inside the function.
      await handleVoiceTurn(currentSession, transcript, utteranceId);
    }

    // P1-4: Client confirms audio playback is complete.
    // Server sends tts_done only after this confirmation.
    if (msg["type"] === "playback_complete") {
      VoiceOrchestrationService.handlePlaybackComplete(currentSession);
      return;
    }

    if (msg["type"] === "interrupt") {
      // 1G: User interrupts Ashley mid-speech.
      // cancelCurrentTurn is called BEFORE sending interrupt_ack so that
      // any in-flight TTS chunk send sees the cleared speechId first.
      registry.cancelCurrentTurn(currentSession, "user_interrupt");
      currentSession.state = "listening";

      const seq = registry.incrementSequence(currentSession);
      try {
        ws.send(
          JSON.stringify({
            type: "interrupt_ack",
            sessionId: currentSession.sessionId,
            connectionGeneration: currentSession.connectionGeneration,
            sequenceNumber: seq,
            timestamp: Date.now(),
          }),
        );
      } catch (err) {
        logger.warn({ err, deviceId }, "voice: failed to send interrupt_ack");
      }
      logger.info(
        { deviceId, sessionId: currentSession.sessionId },
        "voice: interrupt handled",
      );
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    logger.info(
      { deviceId, sessionId, code, reason: reason.toString() },
      "Voice-call WS: closed — marking recovering",
    );
    const closingSession = registry.findBySessionId(sessionId);
    if (closingSession) {
      // P1-3: detect cause from WS close code before marking recovering.
      if (code === 1000 || code === 1001) {
        closingSession.lastReconnectCause = "clean_close";
      } else if (code === 1006) {
        // 1006 = abnormal closure, no close frame — network drop.
        closingSession.lastReconnectCause = "network_drop";
      } else {
        closingSession.lastReconnectCause = "timeout";
      }
      registry.markRecovering(sessionId);
    }
  });

  ws.on("error", (err: Error) => {
    logger.error({ err, deviceId, sessionId }, "Voice-call WS: error");
  });
});
