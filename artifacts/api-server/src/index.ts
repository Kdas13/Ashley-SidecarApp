import app from "./app";
import { logger } from "./lib/logger";
import { db, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { tickProactive } from "./lib/proactiveScheduler";
import { timingSafeEqual } from "node:crypto";
// @ts-ignore – ws ships no bundled types; @types/ws not yet installed
import { WebSocketServer } from "ws";
import * as registry from "./lib/VoiceSessionRegistry";
import { handleVoiceTurn } from "./routes/voice-call";

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
    logger.info(
      { deviceId, sessionId: session.sessionId, gen: session.connectionGeneration },
      "Voice-call WS: session reclaimed",
    );
  } else {
    session = registry.create(deviceId, ws as registry.WsLike);
    logger.info(
      { deviceId, sessionId: session.sessionId },
      "Voice-call WS: new session created",
    );
  }

  // Checkpoint 1A DoD item 4: send call_connected with sessionId.
  ws.send(
    JSON.stringify({
      type: "call_connected",
      sessionId: session.sessionId,
      connectionGeneration: session.connectionGeneration,
      reconnected: session.connectionGeneration > 1,
    }),
  );

  const sessionId = session.sessionId; // capture for closure safety

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ws.on("message", async (data: any, isBinary: boolean) => {
    const currentSession = registry.findBySessionId(sessionId);
    if (!currentSession) return;

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

    if (msg["type"] === "speech_final") {
      const transcript = (msg["transcript"] as string | undefined)?.trim() ?? "";
      const utteranceId = (msg["utteranceId"] as string | undefined) ?? crypto.randomUUID();

      if (!transcript) return;

      // Idempotency: ignore duplicate utteranceIds.
      if (currentSession.processedUtteranceIds.has(utteranceId)) {
        logger.info({ deviceId, utteranceId }, "voice: duplicate utteranceId ignored");
        return;
      }
      currentSession.processedUtteranceIds.add(utteranceId);

      logger.info({ deviceId, utteranceId, transcriptPreview: transcript.slice(0, 80) }, "voice: speech_final accepted");

      const result = await handleVoiceTurn(currentSession, transcript, utteranceId);
      if (result) {
        // ElevenLabs TTS wired in Checkpoint 1E.
        // For now: confirm the text is ready and set state back to listening.
        logger.info(
          { deviceId, turnId: result.turnId, strippedPreview: result.stripped.slice(0, 80) },
          "voice: ready for TTS (Checkpoint 1E pending)",
        );
        const sess = registry.findBySessionId(sessionId);
        if (sess) sess.state = "listening";
      }
    }
  });

  ws.on("close", (code: number, reason: Buffer) => {
    logger.info(
      { deviceId, sessionId, code, reason: reason.toString() },
      "Voice-call WS: closed — marking recovering",
    );
    const closingSession = registry.findBySessionId(sessionId);
    if (closingSession) {
      registry.markRecovering(sessionId);
    }
  });

  ws.on("error", (err: Error) => {
    logger.error({ err, deviceId, sessionId }, "Voice-call WS: error");
  });
});
