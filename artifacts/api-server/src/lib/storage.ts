import fs from "node:fs";
import path from "node:path";

// Persistent storage for generated selfies, scoped to api-server cwd.
// In dev, cwd is artifacts/api-server (pnpm --filter runs in package dir).
// In production, cwd is workspace root, so the dir is artifacts/api-server/storage.
const isProd = process.env["NODE_ENV"] === "production";

export const storageDir = isProd
  ? path.resolve(process.cwd(), "artifacts/api-server/storage")
  : path.resolve(process.cwd(), "storage");

export const selfieDir = path.join(storageDir, "selfies");

if (!fs.existsSync(selfieDir)) {
  fs.mkdirSync(selfieDir, { recursive: true });
}
