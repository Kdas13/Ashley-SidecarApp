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
import { BlueOrb } from "@/components/BlueOrb";
import { useProfile, useUpdateProfile } from "@/lib/useProfile";
import colors from "@/constants/colors";

export default function HomeScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const profileQuery = useProfile();
  const update = useUpdateProfile();

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

  return (
    <AmbientBackground dim={0.3}>
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 },
        ]}
      >
        <View style={styles.topBar}>
          <Pressable
            onPress={() => router.push("/profile")}
            style={styles.iconBtn}
            accessibilityLabel="Profile and settings"
          >
            <Feather name="settings" size={20} color={colors.light.mutedForeground} />
          </Pressable>
          <View style={styles.topBarRight}>
            <Pressable
              onPress={() => router.push("/voice-test" as never)}
              style={styles.iconBtn}
              accessibilityLabel="Voice test"
            >
              <Feather name="mic" size={20} color={colors.light.mutedForeground} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/visuals" as never)}
              style={styles.iconBtn}
              accessibilityLabel="Visual memory"
            >
              <Feather name="image" size={20} color={colors.light.mutedForeground} />
            </Pressable>
            <Pressable
              onPress={() => router.push("/memories")}
              style={styles.iconBtn}
              accessibilityLabel="Memories"
            >
              <Feather name="book-open" size={20} color={colors.light.mutedForeground} />
            </Pressable>
          </View>
        </View>

        <View style={styles.middle}>
          <BlueOrb size={160} />
        </View>

        <View style={styles.bottom}>
          {profileQuery.isLoading ? (
            <ActivityIndicator color={colors.light.primary} />
          ) : (
            <>
              <Text style={styles.name}>
                {profile?.name ?? "Ashley"}
              </Text>
              <Text style={styles.listening}>Ashley is listening</Text>
            </>
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
    backgroundColor: "rgba(232, 237, 242, 0.06)",
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
    gap: 14,
  },
  name: {
    fontSize: 52,
    fontFamily: "Inter_600SemiBold",
    color: colors.light.text,
    textAlign: "center",
    letterSpacing: -1,
  },
  listening: {
    fontSize: 16,
    fontFamily: "Inter_400Regular",
    color: colors.light.primary,
    textAlign: "center",
    marginBottom: 12,
    letterSpacing: 0.3,
  },
  cta: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
    backgroundColor: colors.light.primary,
    paddingHorizontal: 28,
    paddingVertical: 16,
    borderRadius: 999,
    minWidth: 220,
    justifyContent: "center",
  },
  ctaText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
  },
});
