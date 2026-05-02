# Ashley-Sidecar

A personal AI companion mobile app (Expo/React Native) — a privacy-first
Replika replacement with a single user, persistent long-term memory, an
animated 2D avatar on a moving background, and AI-generated selfies.

## Stack

- **Mobile**: Expo SDK 54, Expo Router (stack), TanStack Query, Reanimated,
  expo-image, expo-linear-gradient, KeyboardAvoidingView, Inter via
  @expo-google-fonts.
- **API server**: Express 5 + Pino, Drizzle ORM (Postgres), generated React
  Query hooks + Zod schemas from a single OpenAPI spec.
- **AI**: Anthropic Claude (`claude-sonnet-4-6`) for chat + memory distillation,
  OpenAI `gpt-image-1` for selfies — both via the Replit AI Integrations proxy
  (no user API keys needed).

## Artifacts

- `artifacts/mobile` — the user-facing companion app (`Ashley-Sidecar`).
- `artifacts/api-server` — Express backend mounted at `/api`.
- `artifacts/mockup-sandbox` — Vite-based component playground (default).

## Mobile screens (`artifacts/mobile/app/`)

- `_layout.tsx` — sets the API base URL, loads Inter, hides splash, renders
  the stack. Fonts are non-blocking with a 1.5 s fallback so the app renders
  even when the Google Fonts CDN is unreachable.
- `index.tsx` — home screen: animated avatar + ambient background + greeting +
  CTAs (open chat, ask for selfie). Auto-redirects to `/onboarding` when the
  profile has no `onboardedAt`.
- `onboarding.tsx` — 9-step onboarding flow that walks through every core
  profile field: name, age, identity, appearance, personality, speaking
  style, what Ashley calls the user, shared history, and optional Replika
  excerpts. On completion it persists the profile (`markOnboarded: true`)
  AND seeds initial long-term memories from the supplied history, identity,
  and how-Ashley-refers-to-the-user values.
- `chat.tsx` — chat screen with bubbles, typing indicator, image bubbles for
  selfies, "ask for selfie" attach button, and a clear-conversation icon.
- `memories.tsx` — list, add, edit, and forget memories. Tap any memory to
  edit its content, tag, and importance inline; importance stars + tag
  badges visible on each card.
- `profile.tsx` — edit every aspect of Ashley's persona; persists via
  `PUT /api/profile`.
- `selfie.tsx` — dedicated selfie request screen with quick-idea chips.

## Backend routes (`artifacts/api-server/src/routes/`)

- `GET/PUT /api/profile` — singleton profile (id=1).
- `GET/POST/DELETE /api/chat/messages` — chat history + send (real Claude
  call). On every send, the assistant's reply is followed by a
  fire-and-forget memory-distillation call that extracts JSON memories
  and inserts them into the `memories` table.
- `GET/POST/PATCH/DELETE /api/memories` — CRUD for the long-term memory
  store.
- `POST /api/image/selfie` — generates a 1024×1536 selfie via OpenAI,
  writes it to `artifacts/api-server/storage/selfies/<uuid>.png`, and
  inserts an assistant message with `imageUrl = /api/selfies/<uuid>.png`.
  The folder is exposed via `express.static`.

## Database (`lib/db/src/schema/ashley.ts`)

- `ashley_profile` — singleton (id=1) holding name, identity, personality,
  speaking style, appearance, refers-to-user-as, shared history, optional
  pasted Replika excerpts, theme colors, and `onboardedAt`.
- `messages` — chronological chat log with `role`, `content`, `imageUrl`.
- `memories` — distilled long-term memory with `tag` and `importance` 1–5.

## OpenAPI / codegen

- Spec: `lib/api-spec/openapi.yaml`.
- Run codegen: `pnpm --filter @workspace/api-spec run codegen`.
- The api-zod barrel re-exports types from `./generated/types` and namespaces
  zod schemas as `zodSchemas` plus aliases (e.g. `UpdateProfileBodySchema`)
  to avoid name collisions with TypeScript types of the same name.

## Environment

- `DATABASE_URL` — provisioned Postgres (set automatically).
- `AI_INTEGRATIONS_ANTHROPIC_*` — Anthropic via Replit AI Integrations.
- `AI_INTEGRATIONS_OPENAI_*` — OpenAI via Replit AI Integrations.
- Mobile uses `EXPO_PUBLIC_DOMAIN` (set by the Expo workflow) to compute the
  absolute `https://<domain>` API base URL via `lib/api.ts → getApiBaseUrl()`.

## Workflows

- `artifacts/api-server: API Server` — `pnpm --filter @workspace/api-server run dev`
- `artifacts/mobile: expo` — `pnpm --filter @workspace/mobile run dev`
- `artifacts/mockup-sandbox: Component Preview Server` — Vite dev server.

## Verification

End-to-end smoke test against the live AI stack confirmed:

- Profile defaults seed correctly on first read.
- Chat replies stay in character ("hey jordan 🫶 oat milk latte people are
  my people, just so you know").
- Background memory distillation correctly extracted "His name is Jordan"
  (`user_fact`, importance 5) and "Jordan loves oat-milk lattes"
  (`preference`, importance 3) within ~3 s of the reply.

## Notes / known limitations

- Selfie storage is on local disk (`artifacts/api-server/storage/selfies/`).
  Fine for single-user dev; for production the user may want to switch to
  Replit Object Storage so images survive across deployments.
- The web preview of the Expo app is heavy (8 MB dev bundle) and can take
  several seconds to mount on first load — this only affects the in-IDE
  preview, not the actual Expo Go / built mobile app.
- The chat history window sent to Claude is currently capped at the last
  30 messages plus up to 40 highest-importance memories.
