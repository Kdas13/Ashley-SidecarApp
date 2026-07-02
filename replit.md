# Ashley-Sidecar

A personal AI companion mobile app providing local-first, stateless AI chat with a focus on profile management, memories, and real-time conversation.

## Run & Operate

- **Mobile Dev**: `pnpm --filter @workspace/mobile run dev` (Scan QR with Expo Go on Android)
- **API Server Dev**: `pnpm --filter @workspace/api-server run dev`
- **EAS Build**: `pnpm --filter @workspace/mobile exec eas build --platform android`
- **Required Env Vars**:
    - `DATABASE_URL` (for legacy stateful routes, not V1.1 mobile)
    - `SESSION_SECRET` (backend session secret)
    - `AI_INTEGRATIONS_ANTHROPIC_BASE_URL`
    - `AI_INTEGRATIONS_ANTHROPIC_API_KEY`
    - `EXPO_PUBLIC_DOMAIN` (auto-set by mobile dev script)
    - `API_SECRET` (generate with `openssl rand -hex 32`, set as Replit secret)
    - `EXPO_PUBLIC_API_KEY` (must match `API_SECRET`, set in `.env` or Replit secret)
    - `TAVILY_API_KEY` (Optional, enables web search)
    - `AI_INTEGRATIONS_GEMINI_BASE_URL`, `AI_INTEGRATIONS_GEMINI_API_KEY` (auto-set by the Gemini integration; required if `ASHLEY_TEXT_PROVIDER=gemini`)
    - `ASHLEY_TEXT_PROVIDER` (`gemini` default — Gemini 2.5 Flash for the chat lane; set to `anthropic` to flip back to Claude Sonnet 4.6 — see Architecture decisions below)
    - `ASHLEY_SELFIE_DAILY_CAP` (integer, default 5 — per-device daily cap on selfie generation)
    - `ADMIN_API_KEY` — secret key for all `/admin/*` routes; generate with `node -e "require('crypto').randomBytes(16).toString('hex')"`. Without it, admin routes return 503.
    - `BASE44_SERVICE_ROLE_KEY` — Base44 project service role key (from Base44 project settings panel). Without it, `postInboxMessage` and `postProposal` are no-ops.
    - `ASHLEY_IMAGE_PROVIDER` — `fal` (current), `zencreator`, `replicate`, or `pollo`. Unset = gpt-image-1 fallback.
    - **ZenCreator image provider** (set `ASHLEY_IMAGE_PROVIDER=zencreator` to activate):
        - `Ashley_v3_Adult` — ZenCreator API key (Bearer token). Already in Replit Secrets.
        - `ZENCREATOR_TOOL` — tool name from `GET https://api.zencreator.pro/api/public/v1/tools`. Required; server throws on startup if missing when provider=zencreator.
        - `ZENCREATOR_EXTRA_INPUT` — optional JSON string of additional input fields merged into `{ prompt, width, height }` — use for LoRA weights, negative prompts, model overrides, etc.
    - **Safeguard reminders** (set on the Safeguard API artifact):
        - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — generate with `pnpm dlx web-push generate-vapid-keys`. Without these the reminder worker logs a warning and stays idle; the public key is also exposed by `GET /safeguard-api/me/push/public-key`.
        - `VAPID_SUBJECT` — `mailto:` or `https://` URL for the push service to contact (defaults to `mailto:safeguard-pilot@example.org`).
        - `REMINDER_CRON_SECRET` — required to call `POST /safeguard-api/reminders/tick` from an external scheduler. Without it the endpoint returns 503 (the in-process 60s tick still runs).
    - **Safeguard surgery-email delivery** (set on the Safeguard API artifact):
        - `SAFEGUARD_DELIVERY_SMTP_URL` — nodemailer transport URL, e.g. `smtps://user:pass@smtp.nhs.net:465` or `smtp://user:pass@smtp.example.org:587`. Without it the deliver endpoint returns `transport_not_configured` and the UI shows a retry button instead of pretending the email went out.
        - `SAFEGUARD_DELIVERY_FROM` — RFC 5322 from-address for the outbound email (e.g. `Safeguard <noreply@safeguard.nhs.uk>`). Defaults to `Safeguard <noreply@safeguard.local>`, which most surgery mail servers will reject — set this in production.
        - `SAFEGUARD_PUBLIC_BASE_URL` (or `PUBLIC_BASE_URL`) — absolute base URL the QR / NHS-app share tokens resolve against (e.g. `https://safeguard.example.org`). Required in production; minting a QR throws otherwise.

## Stack

- **Mobile**: Expo SDK 54, Expo Router, TanStack Query, React Native, Reanimated, expo-image, expo-linear-gradient, KeyboardAvoidingView, Inter font.
- **Local Storage**: `@react-native-async-storage/async-storage`.
- **API Server**: Express 5, Pino, Drizzle ORM (Postgres).
- **Build Tool**: pnpm

## Where things live

- `artifacts/mobile/`: User-facing companion app.
- `artifacts/api-server/`: Express backend.
- `artifacts/mobile/lib/storage.ts`: Typed AsyncStorage wrapper.
- `artifacts/mobile/app/`: Mobile screens (e.g., `chat.tsx`, `onboarding.tsx`).
- `artifacts/api-server/src/lib/db/src/schema/ashley.ts`: DB schema (for legacy routes).
- `artifacts/api-server/src/lib/api-spec/openapi.yaml`: API contracts (for legacy routes).
- `artifacts/mobile/components/Icon.tsx`: Source for all UI icons.

## Architecture decisions

- **Hybrid storage with server source-of-truth**: AsyncStorage is a write-through cache; the server (keyed by device id) is the source of truth. `/state` hydration on every cold load overwrites local cache. Cross-device migration therefore requires pushing the imported payload to the server via `POST /api/state/import` (wholesale replace) — local-only writes get clobbered by the next hydration.
- **Streaming AI Replies**: AI chat replies are streamed via Server-Sent Events (SSE) for a more responsive user experience, with adaptive presence signals.
- **Two-Call Selfie Generation**: Selfie image generation is split into two API calls (`/api/chat/reply` and `/api/chat/selfie`) to provide immediate text display while the image generates in the background, sidestepping connection timeouts.
- **Dev-Server Resilience**: The mobile client includes retry logic for API calls that encounter Replit's dev server placeholder, ensuring a smoother development experience during server restarts.
- **Unicode/Emoji Icons**: Instead of `expo/vector-icons`, UI icons are rendered using Unicode/emoji characters for broader device compatibility and to avoid font loading issues.
- **Inverted FlatList for Chat**: The chat `FlatList` is `inverted` to display the newest messages at the bottom, mimicking standard chat apps and simplifying new message handling and scrolling logic.
- **App-Open Greeting (separate from cadence)**: A "say hi when you open the app" greeting is gated by the `greetOnAppOpen` profile flag (default ON) — independent of `proactiveCadence`, which only governs PUSHED messages. The mobile pings `POST /api/proactive/on-app-open` on cold launch and on every background→active AppState transition; the server enforces all gates (toggle, quiet hours, 4h min message gap, 4h dedupe via `proactive_sends`, requires user history) and returns either `{greeted:false, reason}` or `{greeted:true, message}`. The greeting is persisted as `source="proactive"`, `proactiveType="app_open_greeting"` so it survives history reloads.
- **Two-provider chat lane (cost lever)**: `lib/textLLM.ts` is a thin adapter exposing `generateChatText` and `streamChatText` with an Anthropic-shaped messages input. It routes by `ASHLEY_TEXT_PROVIDER` env: default `gemini` (Gemini 2.5 Flash) for the cost saving, set to `anthropic` (Claude Sonnet 4.6) to flip back. Used by: main chat reply (`/chat`), streaming chat reply (`/chat/stream`), proactive message generation, and the per-turn memory distiller. **Stays on Claude regardless** of the env switch: the summariser (`/chat/summarize` + `maybeRollUpOlderMessages` rollup + `carryover.ts`) — quality matters for long-term memory continuity and cost is small — and the vision reply (photo-input chat at line ~2062) — Claude vision quality matters and the call is infrequent. Flip the env between providers with no code change; nothing else has to move.
- **Daily selfie cap**: `lib/selfieCap.ts` enforces a per-device per-UTC-day cap on `/chat/selfie` (image gen is the most expensive per-call line item). Default 5/day, override with `ASHLEY_SELFIE_DAILY_CAP`. Cap-hit returns 429 `{capReached: true, cap, used}` so the mobile can show a "no more selfies today" toast. Counter is in-process (resets on server restart) — acceptable for cost control at single-user scale; persist if multi-user becomes real.
- **Two-Lane Proactive Scheduler (Care vs Companion)**: Proactive categories are split into a `LANE_BY_CATEGORY` map. **Care lane** (`routine_support`, future `medical_checkin`) = responsibility — aggregate cap 6/day, NO recent-message guard (responsibility shouldn't lose to chitchat), per-category cooldowns still apply, walked first each tick. **Companion lane** (`memory_nudge`, `conversation_gap`) = presence — capped by the cadence selector (low=1/normal=2/high=4 per day), 60-min recent-message guard. Both lanes obey quiet hours (until a future `safety_escalation` category exists with its own bypass). `proactiveCadence === "off"` currently silences both lanes — a separate Care-on/off toggle is a follow-up. The `routine_support` prompt bundles two related wellbeing checks per message (e.g. "had any water? eaten something proper today?") so the lane covers more ground without becoming a checklist.

## Product

- **Personal AI Companion**: Offers a personalized AI interaction experience.
- **Local Profile & Memory Management**: Users can manage their identity, personality, and long-term memories directly on their device.
- **Real-time Streaming Chat**: Engage in conversations with Ashley, featuring streaming AI replies and dynamic presence indicators.
- **AI-Generated Selfies**: Ashley can send AI-generated images within the chat.
- **Proactive Messaging**: Ashley can initiate conversations based on user activity, memory nudges, or well-being prompts, with configurable cadences.
- **Onboarding Flow**: Guides users through initial setup, including persona customization and shared history.

## User preferences

- **User name:** Kane (calls himself "Wren" in chat).
- **Active project focus:** Safeguard pilot (refugee GP safeguarding platform). Ashley-Sidecar is in maintenance, not the daily driver.
- **Safeguard pilot languages:** English (`en`, British English wording) and Polish (`pl`) only. `uk/ar/ur/ps/so` bundles stay in the codebase but are NOT in pilot scope — do not gate pilot readiness on them, and do not commission native-speaker review for them yet. Kane is handling clinical/translation review himself (wife = clinical review of English source, sister-in-law = Polish).
- **Reply contract:** no Ashley URL tag on Safeguard-related replies. When a reply is specifically about Ashley work, end it with one of `publish needed` / `just restart` / `live in dev` followed by https://Ashley-Sidecar.replit.app. No emojis, anywhere, ever.
- **Michael completion reports — verification required:** A commit to GitHub is not a deployment. No report on Michael work may claim something is "done," "live," "deployed," or "complete" based on a commit alone. Every completion report must include: (1) a direct curl of the live Railway URL `/health` endpoint confirming the `constitutionVersion` matches what the report claims, and (2) a spot-check of at least one new/changed endpoint confirming it responds as expected (not a 404). "Committed" and "verified live" are different claims. Only the second justifies calling something done.
- **Tone:** push back on self-diminishing language; do not flatter; treat him as a serious collaborator on a long project.
- **Ashley production URL (reference):** https://Ashley-Sidecar.replit.app
- **Kane's APK device id (Ashley production):** `6e1af2db-fb82-42db-9ced-b34f8af8cc74` — this is the live Ashley row.

## Gotchas

- **`expo-dev-client` Version Pinning**: Always install Expo-ecosystem packages with `pnpm exec expo install <pkg>` to avoid version mismatches.
- **API Key Headers**: All API requests must include both `X-API-Key` and `Authorization` (Bearer + X-Device-Id) headers.
- **Android `KeyboardAvoidingView`**: `keyboardVerticalOffset` should be `0` with `behavior="height"` on Android to prevent persistent dead zones.
- **`FlatList` Header/Footer Components with `inverted`**: Do not use `ListHeaderComponent`, `ListEmptyComponent`, or `ListFooterComponent` with `inverted` `FlatList`s; render them as flex siblings instead.
- **Replit Web Preview Limitations**: The Expo web preview can be heavy and may render blank; use Expo Go on an Android device for actual testing.
- **Storage is Per-Device**: Clearing app data resets the profile.

## Pointers

- **Stage 1 Streaming Architecture**: `docs/presence-loop.md`
- **Ashley's Autonomous Home (long-term vision)**: `docs/autonomous-home-vision.md`
- **Tavily API**: https://app.tavily.com (for optional web search)
- **Expo Notifications**: `https://docs.expo.dev/versions/latest/sdk/notifications/`