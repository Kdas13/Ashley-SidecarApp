import React, { useEffect } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon as Feather } from "@/components/Icon";
import { router } from "expo-router";

import { AmbientBackground } from "@/components/AmbientBackground";
import { AnimatedAvatar } from "@/components/AnimatedAvatar";
import { useProfile, useUpdateProfile } from "@/lib/useProfile";
import colors from "@/constants/colors";

export default function HomeScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const profileQuery = useProfile();
  const update = useUpdateProfile();

  // Auto-onboard with defaults the first time the profile loads without an
  // onboardedAt timestamp. Expo Go's AsyncStorage scope can change between
  // dev sessions on Replit (different cluster / experience URL → different
  // namespace), which makes a multi-step onboarding wall feel like the user
  // is forced to redo it on every reload. Skipping straight to chat means
  // the user can refine Ashley's details from the settings screen at their
  // own pace, and reloads land them back in chat in ~1s.
  useEffect(() => {
    if (
      profileQuery.data &&
      !profileQuery.data.onboardedAt &&
      !update.isPending
    ) {
      update.mutate({ markOnboarded: true });
    }
  }, [profileQuery.data, update]);

  const profile = profileQuery.data;
  const greeting = greetingForHour(new Date().getHours());

  return (
    <AmbientBackground dim={0.3}>
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
        ]}
      >
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.push("/profile")}
            style={styles.iconBtn}
            accessibilityLabel="Profile and settings"
          >
            <Feather name="settings" size={20} color={colors.light.text} />
          </Pressable>
          <View style={styles.topBarRight}>
            <Pressable
              onPress={() => router.push("/visuals" as never)}
              style={styles.iconBtn}
              accessibilityLabel="Visual memory"
            >
              <Feather name="image" size={20} color={colors.light.text} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/memories")}
              style={styles.iconBtn}
              accessibilityLabel="Memories"
            >
              <Feather name="book-open" size={20} color={colors.light.text} />
            </Pressable>
          </View>
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
                ? `${profile.name} is here`
                : "let's get to know each other"}
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
            <Feather
              name="message-circle"
              size={18}
              color={colors.light.primaryForeground}
            />
            <Text style={styles.ctaText}>open our chat</Text>
          </Pressable>
        </View>
      </View>
    </AmbientBackground>
  );
}

function greetingForHour(hour: number): string {
  if (hour < 5) return "still up?";
  if (hour < 12) return "good morning";
  if (hour < 17) return "hey, you";
  if (hour < 22) return "evening";
  return "late night thoughts?";
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    paddingHorizontal: 20,
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  topBarRight: {
    flexDirection: "row",
    gap: 8,
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
  },
  ctaText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
});
