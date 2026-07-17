import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

const REQUIRED_RUNTIME_ENV = ["DATABASE_URL", "API_AUTH_KEY", "API_SECRET"] as const;

function deploymentMetadata() {
  return {
    commit:
      process.env["RAILWAY_GIT_COMMIT_SHA"] ??
      process.env["APP_COMMIT_SHA"] ??
      "unknown",
    migrationVersion: process.env["APP_MIGRATION_VERSION"] ?? "unversioned",
    environment:
      process.env["RAILWAY_ENVIRONMENT_NAME"] ??
      process.env["NODE_ENV"] ??
      "unknown",
  };
}

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

router.get("/readyz", async (req, res): Promise<void> => {
  const missing = REQUIRED_RUNTIME_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    res.status(503).json({
      status: "not_ready",
      reason: "missing_required_configuration",
      missing,
      ...deploymentMetadata(),
    });
    return;
  }

  try {
    await db.execute(sql`select 1`);
    res.json({ status: "ready", database: "reachable", ...deploymentMetadata() });
  } catch (err) {
    req.log.error({ err }, "Readiness check failed");
    res.status(503).json({
      status: "not_ready",
      reason: "database_unreachable",
      ...deploymentMetadata(),
    });
  }
});

export default router;
