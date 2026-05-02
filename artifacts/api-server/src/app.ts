import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Disable ETag generation. We're a JSON API, not a static-asset server, and
// some endpoints (notably the selfie-job poll loop) return identical bodies
// across calls while state is still pending. With ETag on, Express+the
// Replit proxy returns 304 Not Modified with an empty body on subsequent
// polls, which breaks React Native's `fetch().json()` and causes the chat
// bubble to flip to "couldn't send the photo" while the image is actually
// still rendering.
app.set("etag", false);

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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
