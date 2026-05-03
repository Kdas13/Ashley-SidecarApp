import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { requireApiKey } from "./middleware/auth";
import { requireDeviceId } from "./middleware/deviceId";
import { apiRateLimit } from "./middleware/rateLimit";

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
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// Public paths that bypass auth + rate limiting + device-id check:
//   /api/healthz                → liveness probe (used by Replit deploy)
//   /api/selfies/:filename      → static image serving for <Image> tags
//                                  (selfie URLs already use unguessable UUIDs;
//                                  RN <Image> can't attach Authorization)
const isPublicApiPath = (path: string): boolean => {
  return path === "/healthz" || path.startsWith("/selfies/");
};

const gate: RequestHandler = (req, res, next) => {
  if (isPublicApiPath(req.path)) {
    next();
    return;
  }
  apiRateLimit(req, res, (err) => {
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

export default app;
