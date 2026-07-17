import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import adminRouter from "./routes/admin.js";
import { logger } from "./lib/logger";
import { requireApiKey } from "./middleware/auth";
import { requireDeviceId } from "./middleware/deviceId";
import { apiRateLimit } from "./middleware/rateLimit";
import { adminAuth } from "./middleware/adminAuth.js";

const app: Express = express();

// Disable ETag generation. We're a JSON API, not a static-asset server, and
// some endpoints (notably the selfie-job poll loop) return identical bodies
// across calls while state is still pending. With ETag on, Express+the
// Replit proxy returns 304 Not Modified with an empty body on subsequent
// polls, which breaks React Native's `fetch().json()` and causes the chat
// bubble to flip to "couldn't send the photo" while the image is actually
// still rendering.
app.set("etag", false);

// Trust the Replit proxy so req.ip reflects the real client IP for rate
// limiting. Single hop in front of us.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// The base64 image-upload route (/api/chat/image) needs large headroom;
// 10 images at q=0.85 ≈ 90 MB base64, so the cap is 100 MB.
// Every other endpoint stays on a tight 1 MB cap. We pick the right parser
// per-request based on the path. (Mounting two json parsers globally doesn't
// work because express.json is idempotent — once req._body is set the second
// pass no-ops.)
const jsonLarge = express.json({ limit: "200mb" });
const jsonSmall = express.json({ limit: "1mb" });
app.use((req, res, next) => {
  if (req.path === "/api/chat/image") return jsonLarge(req, res, next);
  // Voice push-to-talk uploads ship base64 audio in JSON. A 150s recording
  // at HIGH_QUALITY (m4a/aac ~128kbps) is ~2.4MB raw, ~3.2MB base64 —
  // comfortably under the 12MB cap.
  if (req.path === "/api/chat/transcribe") return jsonLarge(req, res, next);
  // Stage 2 streaming variant ships the same base64 audio in JSON; the
  // *response* is SSE but the request body is identical to Stage 1.
  if (req.path === "/api/chat/transcribe/stream")
    return jsonLarge(req, res, next);
  // Backup import payload contains the user's full message history,
  // memories, and summaries — easily multiple MB.
  if (req.path === "/api/state/import") return jsonLarge(req, res, next);
  return jsonSmall(req, res, next);
});
app.use(express.urlencoded({ extended: true }));

// Public paths that bypass auth + rate limiting + device-id check:
//   /api/healthz                → process liveness probe
//   /api/readyz                 → deployment readiness probe
//   /api/selfies/:filename      → static image serving for <Image> tags
//                                  (selfie URLs already use unguessable UUIDs;
//                                  RN <Image> can't attach Authorization)
const isPublicApiPath = (path: string): boolean => {
  return (
    path === "/healthz" ||
    path === "/readyz" ||
    path.startsWith("/selfies/") ||
    path.startsWith("/user-images/")
  );
};

const gate: RequestHandler = (req, res, next) => {
  if (isPublicApiPath(req.path)) {
    next();
    return;
  }
  apiRateLimit(req, res, (err: unknown) => {
    if (err) {
      next(err);
      return;
    }
    requireApiKey(req, res, (err2) => {
      if (err2) {
        next(err2);
        return;
      }
      requireDeviceId(req, res, next);
    });
  });
};

app.use("/api", gate, router);
app.use("/admin", adminAuth, adminRouter);

export default app;
