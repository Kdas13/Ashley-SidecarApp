import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from "@expo-google-fonts/inter";
import { Feather } from "@expo/vector-icons";
import { useFonts } from "expo-font";
import { QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import * as SystemUI from "expo-system-ui";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { queryClient } from "@/lib/queryClient";

SplashScreen.preventAutoHideAsync();
SystemUI.setBackgroundColorAsync("#1a1325").catch(() => {
  /* ignore */
});

// Catch otherwise-uncaught JS errors so they show in the Metro logs with
// a real stack trace, instead of silently rendering Expo Go's native
// "Something went wrong" screen with no detail. Wrapped in a try so a
// missing ErrorUtils (e.g. on web) never itself crashes module load.
try {
  // ErrorUtils is a React Native global without typings.
  const eu = (globalThis as { ErrorUtils?: {
    getGlobalHandler: () => (e: unknown, isFatal?: boolean) => void;
    setGlobalHandler: (
      h: (e: unknown, isFatal?: boolean) => void,
    ) => void;
  } }).ErrorUtils;
  if (eu) {
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((err, isFatal) => {
      const e = err instanceof Error ? err : new Error(String(err));
      console.error(
        `[ashley:${isFatal ? "fatal" : "error"}] ${e.message}\n${e.stack ?? ""}`,
      );
      prev(err, isFatal);
    });
  }
} catch {
  /* never let error-handler setup itself crash boot */
}

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

export default function RootLayout(): React.JSX.Element | null {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    // Spread Feather's icon font in so glyphs render. @expo/vector-icons
    // normally self-loads, but only when no other useFonts call is racing
    // it on the same render — without this, Feather icons appear as [X]
    // placeholders in Expo Go.
    ...Feather.font,
  });
  const [splashTimedOut, setSplashTimedOut] = useState(false);

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  useEffect(() => {
    // Don't block forever if fonts can't load (e.g. blocked CDN in proxied web preview).
    const t = setTimeout(() => {
      setSplashTimedOut(true);
      SplashScreen.hideAsync().catch(() => {
        /* ignore */
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  if (!fontsLoaded && !fontError && !splashTimedOut) return null;

  // SafeAreaProvider stays outermost because ErrorFallback uses
  // useSafeAreaInsets and would itself crash without that context. The
  // ErrorBoundary then sits OUTSIDE QueryClient / GestureHandlerRootView /
  // KeyboardProvider so a crash inside any of those (or any screen) is
  // caught by our nice fallback instead of falling through to Expo Go's
  // native blue "Something went wrong" screen.
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
