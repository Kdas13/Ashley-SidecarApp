# Safeguard e2e

End-to-end Playwright suite that walks the full appointment + follow-up
flow signed in as a Clerk test user. See `appointment-flow.spec.ts` for the
exact path covered.

## Run locally against the Replit dev workflows

```sh
# Make sure both Safeguard workflows are running:
#   - artifacts/safeguard: web
#   - artifacts/safeguard-api: Safeguard API
# Then:
E2E_BASE_URL=http://localhost:80 \
CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY \
CLERK_SECRET_KEY=sk_test_xxx \
pnpm --filter @workspace/safeguard run test:e2e
```

`E2E_BASE_URL` set → Playwright will not start its own servers and will
talk to the Replit shared proxy directly.

## Run with Playwright-managed servers (used in CI)

```sh
pnpm --filter @workspace/safeguard run test:e2e
```

This starts the API server, the Vite dev server, and a tiny same-origin
proxy (`tests/e2e/support/proxy.mjs`) that mounts `/safeguard-api/*` and
`/safeguard/*` on a single port, exactly like the production proxy.

Required env:

- `VITE_CLERK_PUBLISHABLE_KEY` and `CLERK_PUBLISHABLE_KEY` — the same
  Clerk test instance publishable key (`pk_test_…`).
- `CLERK_SECRET_KEY` — Clerk test instance secret (`sk_test_…`).
- `DATABASE_URL` — writable Postgres for the Safeguard schema.
- `AI_INTEGRATIONS_OPENAI_BASE_URL` + `AI_INTEGRATIONS_OPENAI_API_KEY` —
  the appointment intake / translation / follow-up assertions depend on
  real model output. Without them the test fails fast (by design).

## Run as a Replit task-agent validation step

The same suite is registered as a local validation named `safeguard-e2e`
via `scripts/safeguard-e2e-guard.sh`. The wrapper inspects the working
tree against `HEAD` and only runs Playwright when files matching
`artifacts/safeguard/**`, `artifacts/safeguard-api/**`, `lib/db/**`,
`pnpm-workspace.yaml`, `pnpm-lock.yaml`, or the wrapper itself have
changed — otherwise it exits 0 with a "skipping" message so unrelated
tasks don't pay the multi-minute cost. It then verifies the same env
vars listed above before invoking `pnpm run test:e2e`.

Override knobs:

- `FORCE_SAFEGUARD_E2E=1` — run regardless of the change scope.
- `SKIP_SAFEGUARD_E2E=1` — skip even if Safeguard files changed (use
  sparingly; this is the same suite that gates the GitHub workflow).
