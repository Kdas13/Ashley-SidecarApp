import app from "./app";
import { logger } from "./lib/logger";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

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
});
