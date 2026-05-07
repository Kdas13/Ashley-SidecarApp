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
    - **Safeguard reminders** (set on the Safeguard API artifact):
        - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — generate with `pnpm dlx web-push generate-vapid-keys`. Without these the reminder worker logs a warning and stays idle; the public key is also exposed by `GET /safeguard-api/me/push/public-key`.
        - `VAPID_SUBJECT` — `mailto:` or `https://` URL for the push service to contact (defaults to `mailto:safeguard-pilot@example.org`).
        - `REMINDER_CRON_SECRET` — required to call `POST /safeguard-api/reminders/tick` from an external scheduler. Without it the endpoint returns 503 (the in-process 60s tick still runs).

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
- **Reply contract:** no Ashley URL tag on Safeguard-related replies. When a reply is specifically about Ashley work, end it with one of `publish needed` / `just restart` / `live in dev` followed by https://Ashley-Sidecar.replit.app. No emojis, anywhere, ever.
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