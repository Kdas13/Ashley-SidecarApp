import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { useFonts } from "expo-font";
import { QueryClientProvider } from "@tanstack/react-query";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus, Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/queryClient";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import {
  fetchState,
  triggerAppOpenGreeting,
  type ServerState,
} from "@/lib/aiClient";
import type { Message } from "@/lib/storage";
import { registerForPushNotificationsAsync } from "@/lib/pushRegistration";
import {
  saveMemories,
  saveMessages,
  saveProfile,
  saveSummaries,
} from "@/lib/storage";

SplashScreen.preventAutoHideAsync();
SystemUI.setBackgroundColorAsync("#1a1325").catch(() => {
  /* ignore */
});

// NOTE: We used to load Feather here via Font.loadAsync (multiple
// approaches tried, all failed on Kane's Android device — glyphs kept
// rendering as boxes-with-X). The whole icon system has been replaced
// with `components/Icon.tsx`, which renders Unicode/emoji characters
// using the system font and therefore needs no font loading at all.

function RootLayoutNav(): React.JSX.Element {
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: "#1a1325" },
        animation: "fade",
      }}
    />
  );
}

/**
 * On boot we (a) resolve the device id and (b) hydrate React Query with
 * the latest /state from the server. Both happen in parallel with font
 * loading so we don't double the splash time. The chat / profile /
 * memories hooks each have their own useQuery — seeding the caches up
 * front means the first frame of those screens renders with real data,
 * not a spinner-on-empty-list.
 */
async function bootstrap(): Promise<void> {
  await getOrCreateDeviceId();
  let state: ServerState;
  try {
    state = await fetchState();
  } catch {
    // Offline / server unavailable on cold start — let the per-screen
    // hooks fall back to their AsyncStorage cache.
    return;
  }
  queryClient.setQueryData(["profile"], state.profile);
  queryClient.setQueryData(["messages"], state.messages);
  queryClient.setQueryData(["memories"], state.memories);
  queryClient.setQueryData(["summaries"], state.summaries);
  await Promise.all([
    saveProfile(state.profile).catch(() => undefined),
    saveMessages(state.messages).catch(() => undefined),
    saveMemories(state.memories).catch(() => undefined),
    saveSummaries(state.summaries).catch(() => undefined),
  ]);

  // Push notification registration. Runs AFTER state hydration so the
  // permission prompt doesn't appear during the splash. If the user's
  // current cadence is "off" we don't even ask — saves a noisy prompt
  // for users who explicitly opted out. Anything that fails inside
  // registerForPushNotificationsAsync surfaces as `token: null` rather
  // than a throw, so it can never break boot.
  if (state.profile.proactiveCadence !== "off") {
    void registerForPushNotificationsAsync().catch(() => undefined);
  }

  // Ask the server whether Ashley should greet us on this open. The server
  // enforces all the gates (toggle, quiet hours, time-since-last-message,
  // 4h dedupe), so we can call unconditionally — but skip the round trip
  // when the user has explicitly turned it off so a flaky network never
  // blocks boot for the opted-out path either.
  if (state.profile.greetOnAppOpen !== false) {
    void runAppOpenGreeting();
  }
}

/**
 * Fire the on-app-open greeting check and, if the server returned a fresh
 * Ashley message, splice it into the cached messages list so it appears
 * without waiting for the next /state refresh. Cache update is optimistic
 * AND idempotent — uses a functional setter that checks for the message id
 * so a concurrent /state hydration landing in either order is safe.
 *
 * In-flight guard (`appOpenGreetingInFlight`) collapses concurrent callers
 * onto a single network request. Cold start + an immediate AppState→active
 * fire would otherwise hit the endpoint twice; the server's 4h dedupe would
 * still do the right thing, but skipping the round trip is cleaner.
 */
let appOpenGreetingInFlight: Promise<void> | null = null;
async function runAppOpenGreeting(): Promise<void> {
  if (appOpenGreetingInFlight) return appOpenGreetingInFlight;
  appOpenGreetingInFlight = (async () => {
    try {
      const result = await triggerAppOpenGreeting();
      if (!result.greeted) return;
      queryClient.setQueryData<Message[] | undefined>(
        ["messages"],
        (prev) => {
          const list = prev ?? [];
          if (list.some((m) => m.id === result.message.id)) return list;
          return [...list, result.message];
        },
      );
    } finally {
      appOpenGreetingInFlight = null;
    }
  })();
  return appOpenGreetingInFlight;
}

export default function RootLayout(): React.JSX.Element | null {
  // Inter (Google fonts) goes through useFonts as normal — that path is
  // reliable for @expo-google-fonts packages.
  const [interLoaded, interError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  // Icons are now Unicode/emoji glyphs (components/Icon.tsx) — no font
  // loading required, so no `iconsReady` gate.
  const [splashTimedOut, setSplashTimedOut] = useState(false);
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    bootstrap()
      .catch(() => undefined)
      .finally(() => setBootDone(true));
  }, []);

  // Notification listeners — installed once at root mount, torn down on
  // unmount. Two distinct paths:
  //   • addNotificationReceivedListener fires when a push ARRIVES while
  //     the app is in the foreground. The proactive message is already
  //     in the server's chat history, so we just invalidate the messages
  //     query and the new bubble pops into the list immediately.
  //   • addNotificationResponseReceivedListener fires when the user TAPS
  //     a push (foreground or background). Same query invalidation, plus
  //     route them to the chat screen so they see the message.
  // expo-notifications listeners are global — they fire even when no
  // screen is mounted — so this is the right place to wire them.
  useEffect(() => {
    // Skip listener attach in Expo Go — remote push is gone there since
    // SDK 53, so no notifications can ever arrive to fire these. Attaching
    // them is harmless on its own but `expo-notifications` logs a warning
    // when any of its remote-push surface is touched in Expo Go, and we
    // want a clean console for the rest of dev. Listeners come back
    // automatically when running in a dev / standalone build.
    if (Constants.executionEnvironment === "storeClient") return;

    const foregroundSub = Notifications.addNotificationReceivedListener(() => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
    });
    const tapSub = Notifications.addNotificationResponseReceivedListener(() => {
      queryClient.invalidateQueries({ queryKey: ["messages"] });
      // Tiny defer so any in-flight nav settles before we push.
      setTimeout(() => {
        try {
          router.push("/chat");
        } catch {
          // navigator may not be ready yet on cold start — the
          // invalidate above will at least surface the bubble next
          // time the user opens chat.
        }
      }, 50);
    });
    return () => {
      foregroundSub.remove();
      tapSub.remove();
    };
  }, []);

  // Foreground-resume greeting: if the user backgrounds the app for a few
  // hours and brings it back, give the server a chance to greet again. The
  // server's 4h dedupe means a quick out-and-back won't fire a second time.
  // We use a ref + the last AppStateStatus so we only ping on the
  // background→active transition, not on every state change.
  const lastAppState = useRef<AppStateStatus>(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      const prev = lastAppState.current;
      lastAppState.current = next;
      if (next === "active" && prev !== "active") {
        // Best-effort — failures resolve to greeted:false inside the helper,
        // and the splice is a no-op when nothing comes back.
        void runAppOpenGreeting();
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if ((interLoaded || interError) && bootDone) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [interLoaded, interError, bootDone]);

  useEffect(() => {
    // The splash-timeout fallback only exists for the proxied web preview in
    // the Replit IDE — the iframe sometimes blocks the @expo-google-fonts
    // CDN and we don't want to hang forever. On native (Expo Go) Metro
    // serves both the Inter and Feather TTFs and they always resolve, so a
    // timeout fallback there would only manifest as broken glyphs on slow
    // links. We deliberately do NOT set splashTimedOut on native.
    if (Platform.OS !== "web") return;
    const t = setTimeout(() => {
      setSplashTimedOut(true);
      SplashScreen.hideAsync().catch(() => undefined);
    }, 12000);
    return () => clearTimeout(t);
  }, []);

  // On native: render once Inter is loaded (or has errored hard).
  // On web: also allow render after the splashTimedOut fallback fires.
  const fontsReady = interLoaded || interError;
  const allowWebFallback = Platform.OS === "web" && splashTimedOut;
  if (!fontsReady && !allowWebFallback) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <GestureHandlerRootView style={{ flex: 1, backgroundColor: "#1a1325" }}>
            <KeyboardProvider>
              <StatusBar style="light" />
              <RootLayoutNav />
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
