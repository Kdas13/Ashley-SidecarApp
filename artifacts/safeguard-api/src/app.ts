import express, { type Express, type RequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import publicExportsRouter from "./routes/publicExports";
import { reminderTickHandler } from "./routes/push";
import { logger } from "./lib/logger";
import { apiRateLimit } from "./middleware/rateLimit";
import { requireClerkUser } from "./middleware/clerkAuth";
import { ensureSafeguardUser } from "./middleware/ensureSafeguardUser";

const app: Express = express();

app.set("etag", false);
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const isPublicPath = (p: string): boolean => {
  return p === "/healthz" || p === "/invariants" || p === "/reminders/tick";
};

const gate: RequestHandler = (req, res, next) => {
  if (isPublicPath(req.path)) {
    next();
    return;
  }
  apiRateLimit(req, res, (err: unknown) => {
    if (err) return next(err);
    requireClerkUser(req, res, (err2: unknown) => {
      if (err2) return next(err2);
      ensureSafeguardUser(req, res, next);
    });
  });
};

// Mount the cron tick BEFORE the gate so external schedulers can reach it
// without a Clerk JWT. The handler still requires `X-Reminder-Cron-Secret`
// to match `REMINDER_CRON_SECRET`.
app.use("/safeguard-api", reminderTickHandler());
// Token-gated PDF fetch for surgery scans. Mounted before the Clerk gate
// so a phone scanning the QR doesn't need a session — auth is the opaque
// token in the URL, see `routes/publicExports.ts`.
app.use("/safeguard-api", publicExportsRouter);
app.use("/safeguard-api", gate, router);

export default app;
