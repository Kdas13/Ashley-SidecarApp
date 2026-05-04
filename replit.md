# Ashley-Sidecar

A personal AI companion mobile app (Expo / React Native, targeting Expo Go on
Android). The shipped scope is **V1.1 — local-first with stateless AI chat**:
profile, memories, and chat messages all live on the device in AsyncStorage;
the only thing the API server does for the mobile app is run a single
stateless Claude call per outgoing message and return the reply. Server has
no DB knowledge of the conversation — the phone is the source of truth.

## V1.1 scope (what ships today)

- Expo shell with Expo Router
- Animated avatar (`AnimatedAvatar`) on an ambient indigo / amber / violet
  background (`AmbientBackground`)
- 5-step onboarding flow that captures name, identity, personality, what
  Ashley calls the user, and an optional shared-history note
- Local profile storage and profile editor
- Local long-term memory store with full CRUD (add, edit, delete, importance
  stars, single tag)
- Chat with real Ashley replies via stateless `POST /api/chat/reply`
  (Anthropic Claude through the Replit AI Integrations proxy). Profile +
  memories + recent history (last 30 turns) are sent on every request; the
  reply is appended locally. Typing indicator + tap-to-dismiss error banner
  on failure.
- **Real selfies in chat (poll-based, two-call flow).** When Ashley wants
  to send a photo she emits a `[selfie: <visual vibe>]` marker. The flow
  is split across two endpoints so the chat bubble appears immediately
  while the slow image generation runs in the background:
    1. `POST /api/chat/reply` → returns `{reply, imageUrl: null, selfieVibe}`
       in ~3 s. The mobile bubble renders the text plus a "taking a
       selfie…" placeholder.
    2. `POST /api/chat/selfie` → returns `{jobId}` in <100 ms (HTTP 202).
       The server kicks off `gpt-image-1` in the background and stores
       the job state in an in-memory Map (5-min TTL).
    3. `GET /api/chat/selfie/:jobId` → mobile polls every 2 s (up to
       120 s) for `{status: "pending" | "ready" | "failed", imageUrl?,
       error?}`. Each individual request is sub-second so the Replit
       proxy / RN-fetch ~60 s connection cap is sidestepped.
  When `ready`, the imageUrl is patched into the existing bubble and the
  placeholder disappears. On failure, the bubble shows a tap-to-retry
  affordance with the actual error inline.
- **Dev-server resilience.** The mobile `aiClient` wraps every POST in
  `fetchWithProxyRetry`, which detects Replit's "Run this app to see the
  results here." placeholder HTML (status 404/502/503 + matching body
  marker) and retries once after 4 s. This makes the chat self-healing
  during the brief api-server rebuild gap that happens whenever the
  workflow recycles in dev. Real 4xx/5xx JSON errors pass through
  untouched and are surfaced verbatim in the chat error banner along
  with the resolved API base URL — so any future "couldn't reach Ashley"
  is debuggable from a single screenshot.
- **Onboarding persistence guard.** After `useUpdateProfile` mutates,
  `onboarding.tsx` re-reads the profile from AsyncStorage and verifies
  `onboardedAt` is set before navigating to `/`. If the write didn't
  stick (silent storage failure), an Alert surfaces the error instead of
  bouncing the user to chat with nothing saved. Prevents the "onboarding
  repeats every reload" bug class.
- No emojis in UI chrome — Feather icons only (Ashley herself uses
  emoji sparingly in her texts, that's part of her voice)
- No camera / phone-side image upload — image flow is one-way
  (Ashley → user)

## Stack

- **Mobile**: Expo SDK 54, Expo Router (stack), TanStack Query (in-memory
  cache over AsyncStorage), Reanimated, expo-image, expo-linear-gradient,
  KeyboardAvoidingView, Inter via @expo-google-fonts (non-blocking with a
  1.5 s splash fallback so the app renders even when the Google Fonts CDN is
  unreachable).
- **Local storage**: `@react-native-async-storage/async-storage` (uses
  `localStorage` on the web preview).
- **API server**: Express 5 + Pino, Drizzle ORM (Postgres), generated
  React Query hooks + Zod schemas from a single OpenAPI spec. Mobile only
  calls the new stateless `POST /api/chat/reply`; the legacy stateful
  `/api/chat/messages` + `/api/memories` + `/api/profile` + `/api/image/selfie`
  routes remain available for future server-backed mode.

## Artifacts

- `artifacts/mobile` — the user-facing companion app (`Ashley-Sidecar`).
- `artifacts/api-server` — Express backend mounted at `/api`. Dormant in V1.

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
- `useMessages.ts` — `useMessages()`, `useSendMessage()`, and
  `useClearMessages()`. `useSendMessage` appends the user message
  locally, calls `fetchAshleyReply` with the current profile + memories +
  prior history, then appends Ashley's reply locally. On error the user
  message stays in the log and the error surfaces via `mutation.error`.
- `aiClient.ts` — `fetchAshleyReply(req)` POSTs to
  `${EXPO_PUBLIC_DOMAIN}/api/chat/reply` with `{ content, profile,
  memories, history }` (history trimmed to the most recent 30 turns) and
  returns `{ reply, imageUrl }`. Throws on non-2xx or empty reply.

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
- `chat.tsx` — chat with real AI replies. Renders user + Ashley bubbles.
  Ashley bubbles can include a generated selfie image above an optional
  caption (rendered when `message.imageUrl` is set). While the request is
  in flight a footer "Ashley is typing…" bubble shows with a spinner. On
  error a destructive banner appears that the user can tap to dismiss;
  the user's outgoing message remains in the log. There is no manual
  selfie / camera button — Ashley decides when to send one.
- `memories.tsx` — list, add, inline-edit, and forget memories. Tap a
  card to enter edit mode (content, tag, importance 1–5). All operations
  go through the local hooks.
- `profile.tsx` — edit every persona field. Save shows a transient
  "Saved" confirmation (1.8 s) and writes through `useUpdateProfile`.

## Deleted in V1

- `app/selfie.tsx` — image-generation screen, not part of V1.
- `lib/api.ts` — the absolute-URL API base helper; mobile no longer
  speaks to the backend.

## Backend

The mobile app only uses one server endpoint:

- `POST /api/chat/reply` — **stateless**. Body:
  `{ content, profile?, memories?, history? }`. Response:
  `{ reply, imageUrl }` where `imageUrl` is `null` for plain text replies
  or an absolute `https://…/api/selfies/<id>.png` URL when Ashley sent a
  photo. Validates with zod, builds the system prompt inline (mirrors
  `buildSystemPrompt` in `ashleyPrompt.ts` but takes plain JSON shapes
  instead of Drizzle row types), trims history to the last 30 turns,
  ensures the conversation starts with a `user` turn, calls
  `claude-sonnet-4-6` via `@workspace/integrations-anthropic-ai`. The
  system prompt instructs Ashley to emit `[selfie: <vibe>]` instead of
  roleplaying photos in italics; the route detects the marker, calls
  `generateImageBase64` (gpt-image-1) with her appearance + the vibe,
  persists the bytes via `saveSelfie`, strips the marker from the reply
  text, and returns the absolute URL. Returns 502 on Anthropic failure;
  selfie generation failure just drops the imageUrl and keeps the text.
  Per-IP rate limit: 30 requests / 5 minutes.

The legacy stateful routes are still mounted and remain functional but
are not used by mobile in V1.1:

- `GET/PUT /api/profile`, `GET/POST/DELETE /api/chat/messages`,
  `GET/POST/PATCH/DELETE /api/memories`, `POST /api/image/selfie`,
  `GET /api/selfies/<id>.png`.
- Schema: `lib/db/src/schema/ashley.ts` (`ashley_profile`, `messages`,
  `memories`).
- Spec: `lib/api-spec/openapi.yaml`. The new `/chat/reply` endpoint is
  intentionally **not** in the OpenAPI spec — it is a thin internal
  helper, not part of the public API contract. Add it to the spec if/when
  a non-mobile client needs it. Codegen:
  `pnpm --filter @workspace/api-spec run codegen`.
- Selfie image bytes are persisted via `artifacts/api-server/src/lib/storage.ts`,
  which writes to Replit Object Storage (App Storage) when
  `PRIVATE_OBJECT_DIR` is set and falls back to local disk
  (`artifacts/api-server/storage/selfies/`) for dev / unconfigured
  environments. The `/api/selfies/<id>.png` route reads from object
  storage first and falls back to disk so legacy local files keep working.

## Environment

- `DATABASE_URL` — provisioned Postgres (used by the legacy stateful
  routes; not touched by V1.1 mobile flow).
- `SESSION_SECRET` — backend session secret.
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
  — Replit AI Integrations proxy creds, required for `/api/chat/reply`.
- `EXPO_PUBLIC_DOMAIN` — set automatically by the mobile dev script from
  `$REPLIT_DEV_DOMAIN`; the AI client builds `https://${EXPO_PUBLIC_DOMAIN}/api/chat/reply`
  from it.
- `API_SECRET` — **Required.** Pre-shared key that all API clients must
  send as the `X-API-Key` request header. Without it, every route except
  `/api/healthz` returns 503. Generate a strong random value
  (`openssl rand -hex 32`) and set it as a Replit secret. The mobile app
  and any other client must include `X-API-Key: <value>` on every request.
- `EXPO_PUBLIC_API_KEY` — **Required for mobile.** Must be set to the same
  value as `API_SECRET`. Expo inlines `EXPO_PUBLIC_*` vars at bundle time;
  `aiClient.ts` reads it and attaches it as `X-API-Key` on every outbound
  API request. Set this in `.env` (local dev) or as a Replit secret. The
  mobile dev script wraps the whole command in `bash -c '…'` so it can
  hard-fail with `FATAL: EXPO_PUBLIC_API_KEY is empty` and print a safe
  fingerprint (`len=64 fingerprint=<first 8 chars>…`) on success — that
  way Metro never starts with a missing key, and we can verify the key is
  loaded without leaking the secret to logs.

## Workflows

- `artifacts/api-server: API Server` — `pnpm --filter @workspace/api-server run dev`
- `artifacts/mobile: expo` — `pnpm --filter @workspace/mobile run dev`

## Notes / known limitations

- The Expo web preview in the Replit IDE is heavy (~8 MB dev bundle) and
  occasionally renders blank in the proxied iframe even when the bundle
  has compiled. The actual target is **Expo Go on Android** — scan the
  QR code from the `artifacts/mobile: expo` workflow logs to load the
  app on a phone, where it renders normally.
- Storage is per-device. Clearing app data (or `localStorage` on web)
  resets the profile and triggers onboarding again.
- AI replies require the api-server to be reachable on the same Replit
  domain as the Expo dev server. In production deployments both are
  served behind the same proxy automatically.
- `aiClient.ts` defines two header helpers — `apiHeaders()` (Content-Type
  + X-API-Key) and `authHeaders()` (Authorization Bearer + X-Device-Id).
  `fetchJSON()` and the streaming `expoFetch` in `transcribeAudioStream`
  spread **both** in that order, so every request carries X-API-Key
  (required by the server's `requireApiKey` middleware) **and** the
  Bearer + device id. If you add a new fetch path, mirror this pattern —
  spreading only `authHeaders()` will silently 401 the call as
  `receivedKeyFingerprint=missing`.
- **Feather icons are loaded at MODULE LOAD time via two parallel
  `Font.loadAsync` calls.** The `useFonts({...Feather.font})` spread
  approach silently fails on Kane's Android device — `useFonts` reports
  `loaded=true` while the `<Feather>` component's internal
  `Font.isLoaded("feather")` check (in `@expo/vector-icons`'s
  `createIconSet.js`) returns false, so every glyph renders as a
  box-with-X. The fix in `_layout.tsx` is maximally defensive:
  - Two `Font.loadAsync` calls run at module-import time (before React
    even mounts): one with an explicit `require()` of the Feather TTF
    bound to the lowercase family name `feather`, and a fallback using
    `Feather.font`. Both are idempotent — if the family is already
    registered, the second call returns immediately.
  - The component awaits `Promise.all([featherFontPromise,
    featherFontPromiseFallback])` and only sets `iconsReady=true` after
    both settle. Both have `.catch(() => undefined)` so a transient
    network error doesn't lock the splash forever — worst case becomes
    the pre-fix boxes, not a hung app.
  - `useFonts` still loads the Inter Google fonts (that path is reliable
    for `@expo-google-fonts/*` packages).
  - Web still has its 12s `splashTimedOut` fallback because the IDE
    preview iframe sometimes blocks the @expo-google-fonts CDN.
  - **DO NOT** revert to `useFonts({...Feather.font})` — it is the
    canonical pattern in Expo docs, but it does not actually work
    reliably on Kane's device.
- **`KeyboardAvoidingView` on Android: `keyboardVerticalOffset` must be 0
  with `behavior="height"`.** With `behavior="height"`, KAV PERMANENTLY
  shrinks its own height by `keyboardVerticalOffset` even when the
  keyboard is closed. The chat screen previously used
  `keyboardVerticalOffset={insets.top + 56}` (~80px), which left an ~80px
  dead zone below the input bar with the user's latest message hidden
  behind it. Android's default `windowSoftInputMode=adjustResize` (set
  by Expo) handles the keyboard natively, so KAV with `offset=0` just
  passes through cleanly. iOS keeps `behavior="padding"` with a small
  `offset=8`.
- The chat `FlatList` uses `initialNumToRender={Math.min(Math.max(messages.length, 20), 200)}`
  + `removeClippedSubviews={false}` so the entire history is laid out in
  the first pass, and a multi-snap effect (`[0, 50, 150, 350, 700]` ms)
  calls `scrollToEnd({ animated: false })` repeatedly on first non-empty
  render until the user touches the list. This reliably lands at the
  true bottom even for long histories where virtualization would
  otherwise leave the user stranded mid-history. The tail past 700ms
  was removed because it created a visible "still settling" feel — by
  700ms the FlatList is done virtualizing 200 rows on Kane's device.
  The growth-tracking `useEffect` also uses `animated: false` for the
  cold-mount scroll (when previous messages length was 0) so it doesn't
  fight the multi-snap with a 250ms ease curve; new messages arriving
  later still get the smooth animated scroll.
