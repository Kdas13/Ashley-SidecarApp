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
- Chat with real Ashley replies via **streaming** `POST /api/chat/stream`
  (SSE; Anthropic Claude through the Replit AI Integrations proxy).
  Tokens render in-place into the Ashley bubble as they arrive. The
  send button does an in-place swap to a stop button while a reply is
  in flight; tapping it aborts the upstream Anthropic call server-side
  and surfaces the partial as an "interrupted" bubble with Continue
  (primary) / Retry (secondary) actions. Adaptive presence signals
  ("I'm here…" after 3s, "take your time" after 12s, "connection
  dipped…" on a 7s watchdog) are emitted by `usePresenceLoop`. See
  `docs/presence-loop.md` for the full Stage 1 architecture. The
  legacy non-streaming `POST /api/chat` route is still mounted as a
  fallback for the rare unanswered-tail recovery path.
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

> **Note (May 2026 — Stage 1 streaming):** Mobile primary chat path is
> now `POST /api/chat/stream` (SSE). The stateful non-streaming
> `POST /api/chat` route is kept mounted purely as the fallback for
> `useRetryUnansweredReply` when the SSE connection itself fails before
> a meta event arrives. The stateless `/api/chat/reply` route described
> below is the original V1.1 design and has been superseded — do not
> add new clients to it. See `docs/presence-loop.md` for the streaming
> architecture (SSE event types, abort protocol, continue-from-partial
> contract, presence-signal taxonomy).
>
> **Streaming routes added in Stage 1:**
>
> - `POST /api/chat/stream` — SSE. Body either `{ userMessage }` (new
>   turn) or `{ continueFromMessageId }` (resume an interrupted reply).
>   Validated as exclusive in zod. Emits `meta` (with
>   `streamId === ashleyMessage.id`, `userMessage`, `ashleyMessage`,
>   `mode: "new" | "continue"`), then a stream of `delta` events with
>   text chunks, terminating in `done` (clean end) or `interrupted`
>   (server-side abort) or `error`. The Ashley DB row is inserted
>   up-front with `status="streaming"`, then patched to
>   `complete` / `interrupted` on the terminal event. `client-close`
>   on the underlying socket calls `ac.abort()`.
> - `POST /api/chat/stream/:streamId/abort` — fire-and-forget,
>   idempotent. Resolves the streamId in `inFlightStreams: Map<string,
>   AbortController>` and aborts. 200 even on unknown streamId.
> - `messagesTable.status` text column (default `"complete"`, allowed
>   values `complete | streaming | interrupted`). On boot,
>   `index.ts` flips any orphan `status='streaming'` rows to
>   `'interrupted'` (logs the count) so a recycled api-server doesn't
>   leave dangling bubbles.
> - Continue mode: server prepends the interrupted Ashley row's
>   partial content as the final `assistant` turn in the messages
>   array, then nudges Claude with "Continue naturally from where you
>   were, without repeating yourself" before resuming the stream into
>   a *new* Ashley row (the original interrupted row is left in place
>   as the visible "before" half).
>
> **Mobile streaming pieces:**
>
> - `lib/aiClient.ts::streamAshleyReply({req, callbacks, signal})` —
>   expo/fetch + manual SSE buffer, mirrors the existing
>   `transcribeAudioStream` pattern. Spreads both `apiHeaders()` AND
>   `authHeaders()` (X-API-Key + Bearer + X-Device-Id) on the POST.
>   `abortStream(streamId)` is a small POST helper.
> - `lib/useMessages.ts` — `useStreamMessage`, `useContinueMessage`,
>   `useStopStream`, `useActiveStream`. A module-level
>   `inFlightStreamControllers: Map<streamId, AbortController>` is
>   populated in the meta callback so stop has a target the moment
>   meta lands. Delta flushes are throttled to ~30ms intervals to
>   avoid render storms on token-heavy bursts. Final state is
>   persisted to AsyncStorage via the existing `persistCacheSnapshot`.
> - `lib/usePresenceLoop.ts` — pure reducer
>   (`idle | listening | thinking | speaking | waiting | interrupted`)
>   plus a small hook with adaptive timers. Signals are
>   one-shot per state-entry (re-entering thinking re-arms "I'm
>   here…"). Watchdog tracks last delta arrival in a ref and fires
>   `CONNECTION_DIP` when speaking goes silent ≥7s.
> - `app/chat.tsx` — wires the reducer events
>   (USER_TYPING/USER_CLEAR_DRAFT/USER_SEND/USER_INTERRUPT/STREAM_*)
>   into the input + mutation lifecycle. Send button does an
>   in-place swap to a square stop button when
>   `activeStream != null` or state ∈ {thinking, speaking}.
>   Interrupted Ashley bubbles render a Continue (primary) / Retry
>   (secondary) row underneath the partial text. Streaming bubbles
>   show a pulsing block-cursor (`▍`) at the end of the text. The
>   `PresenceSignalsList` component renders signals as small italic
>   muted-tone rows in the `ListHeaderComponent` slot (which sits at
>   the visually-bottom thanks to `inverted`). Connection-dip
>   triggers an auto-retry-once per stream via the stop+continue
>   dance, guarded by `autoRetriedStreamRef`.

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
- **Icons use Unicode/emoji glyphs, NOT @expo/vector-icons.** Four
  separate Feather-font-loading strategies were tried and all failed on
  Kane's Android device — glyphs kept rendering as boxes-with-X:
  1. `useFonts({...Feather.font})` spread (canonical Expo pattern)
  2. Imperative `Font.loadAsync(Feather.font)` in `useEffect` with a
     gate state
  3. Module-level `Font.loadAsync` with an explicit `require()` of
     `Feather.ttf` under the lowercase family name `"feather"`
  4. Belt-and-braces: BOTH (3) and a `Font.loadAsync(Feather.font)`
     fallback running in parallel at module load
  Root cause never confirmed but most likely either pnpm symlink +
  Metro asset registry interaction (the TTF resolves through
  `node_modules/.pnpm/@expo+vector-icons@.../Feather.ttf`), Expo Go
  bundle caching on Kane's specific device, or a `createIconSet.js`
  race that can't be defeated from outside the library. The fix:
  `components/Icon.tsx` exports an `Icon` component (re-exported as
  `Feather` for drop-in compatibility) that maps icon names →
  Unicode/emoji characters and renders them as `<Text>`. No font
  loading required — the system font on every device handles these
  glyphs natively. All 8 screens/components import via
  `import { Icon as Feather } from "@/components/Icon"` so existing
  `<Feather name="x" size={...} color={...} />` JSX continues to work
  unchanged. `_layout.tsx` no longer touches `expo-font` for icons
  (Inter via `@expo-google-fonts/inter` still loads via `useFonts`).
  - **DO NOT** add `@expo/vector-icons` back. If you need a new icon,
    add it to the `ICON_MAP` in `components/Icon.tsx`.
  - Aesthetic note: emoji glyphs (paperclip, mic, send, trash) render
    in color on most Androids, which is jarring against the dark theme.
    If polish is needed, swap individual entries to monochrome Unicode
    alternatives (e.g. `mic` → `●`, `send` → `▶`).
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
- The chat `FlatList` uses **`inverted`** with a memoized
  `reversedMessages = messages.slice().reverse()` view (WhatsApp/iMessage
  pattern). `data[0]` (the newest message after reversing) anchors to
  the visually-bottom of the list at scroll offset 0, so cold-mount,
  keyboard-open, and new-message-arrival all "just work" — the user
  always sees the latest message and scrolls UP for history. We removed
  ~110 lines of `scrollToEnd` / multi-snap / `userHasScrolledRef` /
  `isNearBottomRef` machinery that previously tried (and intermittently
  failed) to land at the true bottom across virtualization passes.
  - The underlying `messages` array stays in `[oldest, ..., newest]`
    order; only the rendered view is reversed. So
    `messages[messages.length - 1]` / `lastMessage` / `hasUnansweredTail`
    logic continues to work without changes.
  - `inverted` flips the FlatList AND counter-flips each `renderItem`,
    but does **NOT** counter-flip `ListHeaderComponent` /
    `ListEmptyComponent` / `ListFooterComponent`. Wrap those in
    `<View style={styles.invertedFix}>` (which is just
    `transform: [{ scaleY: -1 }]`) or they render upside-down.
  - The "Ashley is typing…" indicator is now `ListHeaderComponent`
    (NOT `ListFooterComponent`) because with `inverted` the header
    renders at the visually-bottom — exactly where the typing bubble
    should appear.
  - `initialNumToRender={20}` is sufficient to fill the viewport on
    first paint; the rest virtualizes lazily as the user scrolls up.
  - `removeClippedSubviews={false}` is kept for measurement stability,
    but is no longer load-bearing for "land at the true bottom".
