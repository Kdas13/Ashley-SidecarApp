import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { useFonts } from "expo-font";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { Platform } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/queryClient";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import {
  fetchState,
  type ServerState,
} from "@/lib/aiClient";
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
