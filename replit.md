# Ashley-Sidecar

A personal AI companion mobile app (Expo / React Native, targeting Expo Go on
Android). The current shipped scope is **V1 — local-first**: everything runs
on-device with no backend dependency and no AI calls. The API server and
database schema are kept in the repo as scaffolding for a future "AI on" mode
but are not contacted by the mobile app.

## V1 scope (what ships today)

- Expo shell with Expo Router
- Animated avatar (`AnimatedAvatar`) on an ambient indigo / amber / violet
  background (`AmbientBackground`)
- 5-step onboarding flow that captures name, identity, personality, what
  Ashley calls the user, and an optional shared-history note
- Local profile storage and profile editor
- Local long-term memory store with full CRUD (add, edit, delete, importance
  stars, single tag)
- Chat screen as a placeholder UI: messages persist locally, a small banner
  reads "replies will arrive once AI is connected", no AI call is made
- No emojis anywhere — Feather icons only
- No selfie / image generation, no camera

## Stack

- **Mobile**: Expo SDK 54, Expo Router (stack), TanStack Query (in-memory
  cache over AsyncStorage), Reanimated, expo-image, expo-linear-gradient,
  KeyboardAvoidingView, Inter via @expo-google-fonts (non-blocking with a
  1.5 s splash fallback so the app renders even when the Google Fonts CDN is
  unreachable).
- **Local storage**: `@react-native-async-storage/async-storage` (uses
  `localStorage` on the web preview).
- **API server (dormant)**: Express 5 + Pino, Drizzle ORM (Postgres),
  generated React Query hooks + Zod schemas from a single OpenAPI spec.
  Kept running as scaffolding; the mobile app does not call it in V1.

## Artifacts

- `artifacts/mobile` — the user-facing companion app (`Ashley-Sidecar`).
- `artifacts/api-server` — Express backend mounted at `/api`. Dormant in V1.
- `artifacts/mockup-sandbox` — Vite-based component playground (default).

## Local storage layer (`artifacts/mobile/lib/`)

- `storage.ts` — typed AsyncStorage wrapper. Exports types
  `AshleyProfile`, `Memory`, `Message`, the storage keys
  (`@ashley/profile/v1`, `@ashley/memories/v1`, `@ashley/messages/v1`),
  a `newId()` helper for string IDs, load/save/clear helpers, and
  `withStorageLock(key, fn)` — a per-key promise-chain mutex that
  serializes read-modify-write mutations so concurrent writes
  cannot lose updates.
- `useProfile.ts` — `useProfile()` + `useUpdateProfile()` React Query
  hooks backed by the profile key. Default profile has `onboardedAt: null`,
  which the home screen uses to gate the redirect to onboarding.
- `useMemories.ts` — `useMemories()`, `useCreateMemory()`,
  `useUpdateMemory()`, `useDeleteMemory()`. IDs are strings (`newId()`).
- `useMessages.ts` — `useMessages()`, `useSendMessage()` (appends a
  user-only message; no AI reply yet), `useClearMessages()`.

## Mobile screens (`artifacts/mobile/app/`)

- `_layout.tsx` — loads Inter, hides the splash on font-ready or after
  1.5 s, wraps the app in `SafeAreaProvider` + `GestureHandlerRootView` +
  React Query, renders the stack. Does **not** set any API base URL.
- `index.tsx` — home: animated avatar + ambient background + greeting +
  CTA (open chat). Auto-redirects to `/onboarding` when the profile has no
  `onboardedAt`. Header has a settings icon (left) and book-open icon to
  memories (right). No emojis.
- `onboarding.tsx` — 5-step flow: (1) name, (2) identity, (3) personality,
  (4) what Ashley calls the user, (5) optional shared history. On finish it
  writes the profile (`onboardedAt = ISO now`) and seeds 1–3 memories from
  the supplied identity, refers-to-user-as, and shared-history fields.
- `chat.tsx` — placeholder chat. Renders user bubbles only. Empty state
  reads "say something to her". A small banner reads "replies will arrive
  once AI is connected." Send is local-only; no network call. There is no
  selfie / camera button in V1.
- `memories.tsx` — list, add, inline-edit, and forget memories. Tap a
  card to enter edit mode (content, tag, importance 1–5). All operations
  go through the local hooks.
- `profile.tsx` — edit every persona field. Save shows a transient
  "Saved" confirmation (1.8 s) and writes through `useUpdateProfile`.

## Deleted in V1

- `app/selfie.tsx` — image-generation screen, not part of V1.
- `lib/api.ts` — the absolute-URL API base helper; mobile no longer
  speaks to the backend.

## Backend (dormant — kept for future AI-on mode)

The Express routes, Drizzle schema, and OpenAPI spec are untouched and
documented for the future:

- `GET/PUT /api/profile`, `GET/POST/DELETE /api/chat/messages`,
  `GET/POST/PATCH/DELETE /api/memories`, `POST /api/image/selfie`.
- Schema: `lib/db/src/schema/ashley.ts` (`ashley_profile`, `messages`,
  `memories`).
- Spec: `lib/api-spec/openapi.yaml`. Codegen:
  `pnpm --filter @workspace/api-spec run codegen`.

When AI is enabled in a future version, the mobile hooks in
`artifacts/mobile/lib/` are the swap point: each `useX` hook can be
re-implemented against the generated React Query client without touching
the screens.

## Environment

- `DATABASE_URL` — provisioned Postgres (used only by the dormant backend).
- `SESSION_SECRET` — backend session secret.
- AI integration env vars (Anthropic, OpenAI) are **not required** for V1.

## Workflows

- `artifacts/api-server: API Server` — `pnpm --filter @workspace/api-server run dev`
- `artifacts/mobile: expo` — `pnpm --filter @workspace/mobile run dev`
- `artifacts/mockup-sandbox: Component Preview Server` — Vite dev server.

## Notes / known limitations

- The Expo web preview in the Replit IDE is heavy (~8 MB dev bundle) and
  occasionally renders blank in the proxied iframe even when the bundle
  has compiled. The actual target is **Expo Go on Android** — scan the
  QR code from the `artifacts/mobile: expo` workflow logs to load the
  app on a phone, where it renders normally.
- Storage is per-device. Clearing app data (or `localStorage` on web)
  resets the profile and triggers onboarding again.
- Chat in V1 only stores the user's outgoing messages; Ashley does not
  reply until the AI hookup is added in a follow-up version.
