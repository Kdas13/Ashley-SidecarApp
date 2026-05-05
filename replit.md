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

- **Local-First with Stateless AI Chat**: Profile, memories, and messages are stored locally on the device. The API server provides stateless AI chat responses, reducing server load and ensuring privacy.
- **Streaming AI Replies**: AI chat replies are streamed via Server-Sent Events (SSE) for a more responsive user experience, with adaptive presence signals.
- **Two-Call Selfie Generation**: Selfie image generation is split into two API calls (`/api/chat/reply` and `/api/chat/selfie`) to provide immediate text display while the image generates in the background, sidestepping connection timeouts.
- **Dev-Server Resilience**: The mobile client includes retry logic for API calls that encounter Replit's dev server placeholder, ensuring a smoother development experience during server restarts.
- **Unicode/Emoji Icons**: Instead of `expo/vector-icons`, UI icons are rendered using Unicode/emoji characters for broader device compatibility and to avoid font loading issues.
- **Inverted FlatList for Chat**: The chat `FlatList` is `inverted` to display the newest messages at the bottom, mimicking standard chat apps and simplifying new message handling and scrolling logic.

## Product

- **Personal AI Companion**: Offers a personalized AI interaction experience.
- **Local Profile & Memory Management**: Users can manage their identity, personality, and long-term memories directly on their device.
- **Real-time Streaming Chat**: Engage in conversations with Ashley, featuring streaming AI replies and dynamic presence indicators.
- **AI-Generated Selfies**: Ashley can send AI-generated images within the chat.
- **Proactive Messaging**: Ashley can initiate conversations based on user activity, memory nudges, or well-being prompts, with configurable cadences.
- **Onboarding Flow**: Guides users through initial setup, including persona customization and shared history.

## User preferences

- _Populate as you build_

## Gotchas

- **`expo-dev-client` Version Pinning**: Always install Expo-ecosystem packages with `pnpm exec expo install <pkg>` to avoid version mismatches.
- **API Key Headers**: All API requests must include both `X-API-Key` and `Authorization` (Bearer + X-Device-Id) headers.
- **Android `KeyboardAvoidingView`**: `keyboardVerticalOffset` should be `0` with `behavior="height"` on Android to prevent persistent dead zones.
- **`FlatList` Header/Footer Components with `inverted`**: Do not use `ListHeaderComponent`, `ListEmptyComponent`, or `ListFooterComponent` with `inverted` `FlatList`s; render them as flex siblings instead.
- **Replit Web Preview Limitations**: The Expo web preview can be heavy and may render blank; use Expo Go on an Android device for actual testing.
- **Storage is Per-Device**: Clearing app data resets the profile.

## Pointers

- **Stage 1 Streaming Architecture**: `docs/presence-loop.md`
- **Tavily API**: https://app.tavily.com (for optional web search)
- **Expo Notifications**: `https://docs.expo.dev/versions/latest/sdk/notifications/`