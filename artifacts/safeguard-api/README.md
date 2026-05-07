# Safeguard API

Express 5 backend for the Safeguard pilot — a mobile-first refugee GP-continuity
safeguarding app. **Hard separated from `@workspace/api-server`** (Ashley):
its own package, its own port, its own Clerk-authenticated routes, its own
`safeguard_*` Postgres tables.

## Run

```sh
pnpm --filter @workspace/safeguard-api run dev
```

Mounts at `/safeguard-api/...` via the global proxy.

## Required env

- `DATABASE_URL` (shared Postgres instance; tables are namespaced `safeguard_*`)
- `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY` — Replit-managed Clerk
- `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY`
- Optional: `SAFEGUARD_OPENAI_MODEL` (defaults to `gpt-4o-mini`)

## Routes

All authenticated routes require `Authorization: Bearer <Clerk session JWT>`.

- `GET  /safeguard-api/healthz` — liveness
- `GET  /safeguard-api/invariants` — public list of safeguarding invariants
- `GET  /safeguard-api/me/profile` — get current user's onboarding profile
- `PUT  /safeguard-api/me/profile` — upsert onboarding profile
- `POST /safeguard-api/me/checkins` — submit a daily check-in (auto-translates + summarises)
- `GET  /safeguard-api/me/checkins` — list recent check-ins
- `GET  /safeguard-api/me/checkins/today` — has the user checked in today?
- `GET  /safeguard-api/me/observations?days=7` — observational summaries
- `POST /safeguard-api/translate` — ad-hoc translation utility

## Safeguarding invariants

Source of truth: `src/lib/safeguardingInvariants.ts`. The web client imports
its own mirror copy; both must match. Any new feature is filtered through
these six rules before it ships.

## AI service abstraction

`src/lib/translationService.ts` is the single module that talks to OpenAI.
Routes never import the OpenAI SDK directly — they go through `translate()`
and `summariseCheckin()`. Swapping providers later is a one-file change.
