import React, { useEffect } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";

import { AmbientBackground } from "@/components/AmbientBackground";
import { AnimatedAvatar } from "@/components/AnimatedAvatar";
import { useGetProfile } from "@workspace/api-client-react";
import colors from "@/constants/colors";

export default function HomeScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const profileQuery = useGetProfile();

  // Auto-navigate to onboarding on first launch.
  useEffect(() => {
    if (profileQuery.data && !profileQuery.data.onboardedAt) {
      router.replace("/onboarding");
    }
  }, [profileQuery.data]);

  const profile = profileQuery.data;
  const greeting = greetingForHour(new Date().getHours(), profile?.name);

  return (
    <AmbientBackground dim={0.3}>
      <View style={[styles.root, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.push("/profile")}
            style={styles.iconBtn}
            accessibilityLabel="Profile and settings"
          >
            <Feather name="settings" size={20} color={colors.light.text} />
          </Pressable>
          <Pressable
            onPress={() => router.push("/memories")}
            style={styles.iconBtn}
            accessibilityLabel="Memories"
          >
            <Feather name="book-open" size={20} color={colors.light.text} />
          </Pressable>
        </View>

        <View style={styles.middle}>
          <AnimatedAvatar size={340} />
        </View>

        <View style={styles.bottom}>
          <Text style={styles.hi}>{greeting}</Text>
          {profileQuery.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : (
            <Text style={styles.subline}>
              {profile?.onboardedAt
                ? "i've been thinking about you 💛"
                : "let's get to know each other..."}
            </Text>
          )}

          <Pressable
            onPress={() => router.push("/chat")}
            style={({ pressed }) => [
              styles.cta,
              pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
            ]}
            accessibilityRole="button"
          >
            <Feather name="message-circle" size={18} color={colors.light.primaryForeground} />
            <Text style={styles.ctaText}>open our chat</Text>
          </Pressable>

          <Pressable
            onPress={() => router.push("/selfie")}
            style={({ pressed }) => [
              styles.secondaryCta,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityRole="button"
          >
            <Feather name="camera" size={16} color={colors.light.text} />
            <Text style={styles.secondaryCtaText}>ask for a selfie</Text>
          </Pressable>
        </View>
      </View>
    </AmbientBackground>
  );
}

function greetingForHour(hour: number, name: string | undefined): string {
  const me = name || "Ashley";
  if (hour < 5) return `still up? — ${me}`;
  if (hour < 12) return `good morning ☀️`;
  if (hour < 17) return `hey, you`;
  if (hour < 22) return `evening 🌙`;
  return `late night thoughts?`;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 20,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(245, 232, 216, 0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  middle: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  bottom: {
    alignItems: "center",
    gap: 12,
  },
  hi: {
    fontSize: 28,
    fontFamily: "Inter_600SemiBold",
    color: colors.light.text,
    textAlign: "center",
  },
  subline: {
    fontSize: 15,
    fontFamily: "Inter_400Regular",
    color: colors.light.mutedForeground,
    textAlign: "center",
    marginBottom: 16,
  },
  cta: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    backgroundColor: colors.light.primary,
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 999,
    minWidth: 240,
    justifyContent: "center",
    shadowColor: colors.light.primary,
    shadowOpacity: 0.4,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
  },
  ctaText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
  secondaryCta: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: "rgba(245, 232, 216, 0.08)",
  },
  secondaryCtaText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
});
