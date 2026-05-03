# Threat Model

## Project Overview

Ashley-Sidecar is an Expo / React Native personal AI companion app backed by an Express 5 API in a pnpm monorepo. The current shipped mobile scope is local-first: profile, memories, summaries, and chat messages live on the device in AsyncStorage, while the API server provides stateless Claude replies and asynchronous OpenAI image generation for selfies. The API server also still mounts legacy database-backed profile, messages, memories, conversation summaries, and image routes for a future server-backed mode.

Production assumptions for scans: `NODE_ENV` is set to `production`; platform TLS protects network traffic; the Vite mockup sandbox is dev-only and should be ignored unless production reachability is shown.

## Assets

- **Local companion data** -- user profile, memories, conversation summaries, and chat messages stored in mobile AsyncStorage. This data can contain intimate personal information and should only leave the device for intended AI calls.
- **Server-backed legacy data** -- PostgreSQL `ashley_profile`, `messages`, `memories`, and `conversation_summaries` tables used by dormant legacy routes. If these routes are deployed, they expose persistent personal and relationship data.
- **Generated selfies** -- image files stored in Replit Object Storage or local server storage and served through `/api/selfies/<id>.png`.
- **AI integration secrets and quotas** -- Anthropic/OpenAI integration credentials and paid model usage. Public endpoints that invoke these services can create cost-abuse risk.
- **Application secrets** -- `DATABASE_URL`, `SESSION_SECRET`, and AI integration environment variables.

## Trust Boundaries

- **Mobile client to API server** -- Expo clients send profile, memories, summaries, history, and user prompts to unauthenticated API endpoints. The server must treat all request data as untrusted and enforce size, rate, and authorization controls appropriate to the endpoint.
- **API server to AI integrations** -- The server sends user-supplied prompts and companion context to Anthropic/OpenAI through Replit AI Integration credentials. Prompt content must not be allowed to trigger unintended server actions, and cost-amplifying endpoints require abuse controls.
- **API server to PostgreSQL** -- Legacy routes read and mutate persistent profile, message, memory, and summary rows. Any production exposure of these routes requires authentication/authorization or other deployment-level access restrictions.
- **API server to object/local storage** -- Selfie save/read paths cross into object storage or local filesystem. Selfie identifiers must remain server-generated and constrained to prevent traversal or arbitrary object access.
- **Public internet to API** -- In production the API is reachable over HTTPS. Public endpoints are unauthenticated unless explicit middleware is added.
- **Development-only surfaces** -- `artifacts/mockup-sandbox`, Expo development scripts, generated `dist` files, and build tooling are out of production scope unless shown to be deployed.

## Scan Anchors

- Production API entry point: `artifacts/api-server/src/app.ts` mounts `artifacts/api-server/src/routes/index.ts` under `/api`.
- Highest-risk production route files: `artifacts/api-server/src/routes/chat.ts`, `image.ts`, `profile.ts`, `memories.ts`, and `summaries.ts`.
- Storage boundary: `artifacts/api-server/src/lib/storage.ts` for generated selfie persistence and retrieval.
- Mobile outbound data flow: `artifacts/mobile/lib/aiClient.ts`, `artifacts/mobile/lib/useMessages.ts`, and AsyncStorage wrappers in `artifacts/mobile/lib/storage.ts`.
- Public/stateless intended surface: `/api/chat/reply`, `/api/chat/selfie`, `/api/chat/selfie/:jobId`, `/api/chat/summarize`, and `/api/selfies/:filename`.
- Legacy database-backed surfaces: `/api/profile`, `/api/chat/messages`, `/api/memories`, `/api/conversation-summaries`, and `/api/image/selfie`; these are mounted and production-relevant if the API server is deployed.
- Dev-only: `artifacts/mockup-sandbox`, `artifacts/mobile/scripts`, `artifacts/mobile/server`, generated `dist` directories, and local preview tooling.

## Threat Categories

### Spoofing

The application currently has no user authentication model for the mobile client. Any route that exposes or mutates persistent server-side data must either be protected by a deployment-level boundary or require server-side authentication before production use. Public AI helper endpoints must not rely on client-provided identity claims.

### Tampering

All client-supplied profile fields, memories, messages, summaries, and selfie prompts are untrusted. The API must validate type, length, and allowed values before storing them or forwarding them to AI services. Legacy database-backed mutation routes must not allow arbitrary internet clients to overwrite the global companion profile, memories, summaries, or message history.

### Information Disclosure

Local-first mobile data is intentionally sent to `/api/chat/reply` and `/api/chat/summarize` for AI processing, but persistent database-backed data should not be publicly readable. Error messages and logs must avoid exposing secrets, full prompts, or unnecessary PII. Selfie URLs should only expose server-generated images and should not allow enumerating or traversing storage.

### Denial of Service

Unauthenticated endpoints that call Anthropic/OpenAI or write to storage/database can be abused to consume paid quotas, CPU, memory, and storage. Public AI endpoints require strict request size limits, per-client rate limits, and preferably stronger abuse controls than in-memory per-IP counters. Legacy AI/image-generation endpoints need equivalent controls if left mounted.

### Elevation of Privilege

Because there are no user roles, the main elevation risk is function-level access control: public clients reaching admin-like or future-mode legacy capabilities. Database-backed route handlers and selfie storage readers must enforce that only intended callers can invoke privileged actions or access persistent data.
