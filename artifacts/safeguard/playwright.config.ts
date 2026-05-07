import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the Safeguard pilot e2e suite.
 *
 * Two run modes:
 *   1. `E2E_BASE_URL` set → assume a Safeguard web + safeguard-api are
 *      already running behind that URL (typically `http://localhost:80` in
 *      Replit dev where the shared proxy mounts `/safeguard/` and
 *      `/safeguard-api/`). No webServer is started by Playwright.
 *   2. `E2E_BASE_URL` unset → start both servers via `webServer`. Used by
 *      CI. Requires the env vars listed in `.github/workflows/safeguard-e2e.yml`
 *      (Clerk test keys, OpenAI key, DATABASE_URL, etc).
 *
 * Either way, the test navigates to `${baseURL}/safeguard/...`.
 */

const SAFEGUARD_PORT = 4173;
const SAFEGUARD_API_PORT = 4174;
const PROXY_PORT = 4175;

// Treat both unset *and* empty-string as "not set" so CI can clear the var
// (`E2E_BASE_URL: ""`) to force Playwright-managed servers without
// accidentally producing an empty baseURL that breaks `page.goto("/...")`.
const externalBaseURL =
  process.env.E2E_BASE_URL && process.env.E2E_BASE_URL.length > 0
    ? process.env.E2E_BASE_URL
    : undefined;
const useExternalServers = externalBaseURL !== undefined;
// When Playwright manages the servers, the browser must hit the same-origin
// proxy (which mounts both `/safeguard/` and `/safeguard-api/`), NOT the
// raw Vite port — otherwise the API calls escape the origin.
const baseURL = externalBaseURL ?? `http://127.0.0.1:${PROXY_PORT}`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: useExternalServers
    ? undefined
    : [
        {
          name: "safeguard-api",
          command: "pnpm --filter @workspace/safeguard-api run dev",
          env: {
            PORT: String(SAFEGUARD_API_PORT),
            NODE_ENV: "development",
          },
          url: `http://127.0.0.1:${SAFEGUARD_API_PORT}/safeguard-api/healthz`,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          name: "safeguard-web",
          command: "pnpm --filter @workspace/safeguard run dev",
          env: {
            PORT: String(SAFEGUARD_PORT),
            BASE_PATH: "/safeguard/",
          },
          url: `http://127.0.0.1:${SAFEGUARD_PORT}/safeguard/`,
          timeout: 120_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
        {
          // Tiny path-based reverse proxy so the app can hit
          // `/safeguard-api/...` from the same origin as the page,
          // exactly like it does behind Replit's shared proxy in prod.
          name: "test-proxy",
          command: `node tests/e2e/support/proxy.mjs ${PROXY_PORT} ${SAFEGUARD_PORT} ${SAFEGUARD_API_PORT}`,
          url: `http://127.0.0.1:${PROXY_PORT}/safeguard/`,
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
          stdout: "pipe",
          stderr: "pipe",
        },
      ],
});
