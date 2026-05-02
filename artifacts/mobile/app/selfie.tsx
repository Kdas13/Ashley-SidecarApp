import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGenerateSelfie,
  getListMessagesQueryKey,
  type Message,
} from "@workspace/api-client-react";
import { AmbientBackground } from "@/components/AmbientBackground";
import colors from "@/constants/colors";
import { resolveImageUrl } from "@/lib/api";

const SUGGESTIONS = [
  "you in your cozy sweater on the couch",
  "morning light, hair messy, just woke up",
  "out for a walk in the city, golden hour",
  "reading a book by the window, rainy day",
];

export default function SelfieScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState("");
  const [latest, setLatest] = useState<Message | null>(null);

  const generate = useGenerateSelfie({
    mutation: {
      onSuccess: (msg) => {
        setLatest(msg);
        qc.invalidateQueries({ queryKey: getListMessagesQueryKey() });
      },
    },
  });

  const submit = (text?: string) => {
    const p = (text ?? prompt).trim();
    if (!p || generate.isPending) return;
    generate.mutate({ data: { prompt: p } });
  };

  const imgUrl = resolveImageUrl(latest?.imageUrl ?? null);

  return (
    <AmbientBackground dim={0.55}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
          <Pressable
            onPress={() => router.back()}
            style={styles.iconBtn}
            accessibilityLabel="Back"
          >
            <Feather name="chevron-left" size={22} color={colors.light.text} />
          </Pressable>
          <Text style={styles.headerTitle}>ask Ashley for a selfie</Text>
          <View style={styles.iconBtn} />
        </View>

        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.previewBox}>
            {generate.isPending ? (
              <View style={styles.previewCenter}>
                <ActivityIndicator color={colors.light.primary} />
                <Text style={styles.previewHint}>
                  *finds the right light...*
                </Text>
              </View>
            ) : imgUrl ? (
              <Image
                source={{ uri: imgUrl }}
                style={styles.preview}
                contentFit="cover"
                transition={300}
              />
            ) : (
              <View style={styles.previewCenter}>
                <Feather name="camera" size={36} color={colors.light.mutedForeground} />
                <Text style={styles.previewHint}>
                  describe what you want — pose, scene, mood
                </Text>
              </View>
            )}
          </View>

          {generate.isError ? (
            <Text style={styles.errorText}>
              couldn't take the selfie this time. try again in a moment.
            </Text>
          ) : null}

          <Text style={styles.label}>quick ideas</Text>
          <View style={styles.suggestions}>
            {SUGGESTIONS.map((s) => (
              <Pressable
                key={s}
                onPress={() => submit(s)}
                disabled={generate.isPending}
                style={({ pressed }) => [
                  styles.suggestion,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text style={styles.suggestionText}>{s}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>or describe one</Text>
          <TextInput
            value={prompt}
            onChangeText={setPrompt}
            placeholder="e.g. cozy in bed reading, soft lamp light"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.input}
            multiline
          />

          <Pressable
            onPress={() => submit()}
            disabled={!prompt.trim() || generate.isPending}
            style={({ pressed }) => [
              styles.cta,
              (!prompt.trim() || generate.isPending) && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
          >
            {generate.isPending ? (
              <ActivityIndicator size="small" color={colors.light.primaryForeground} />
            ) : (
              <>
                <Feather name="camera" size={18} color={colors.light.primaryForeground} />
                <Text style={styles.ctaText}>send selfie request</Text>
              </>
            )}
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </AmbientBackground>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
  },
  headerTitle: {
    flex: 1,
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    textAlign: "center",
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { padding: 18, gap: 18 },
  previewBox: {
    aspectRatio: 3 / 4,
    width: "100%",
    backgroundColor: "rgba(26, 19, 37, 0.6)",
    borderRadius: 24,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.light.border,
    alignItems: "center",
    justifyContent: "center",
  },
  previewCenter: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
  },
  previewHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlign: "center",
  },
  preview: {
    width: "100%",
    height: "100%",
  },
  label: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: -8,
  },
  suggestions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  suggestion: {
    backgroundColor: "rgba(245, 232, 216, 0.08)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: colors.light.border,
  },
  suggestionText: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  input: {
    backgroundColor: "rgba(26, 19, 37, 0.7)",
    borderWidth: 1,
    borderColor: colors.light.border,
    color: colors.light.text,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    minHeight: 80,
    textAlignVertical: "top",
  },
  cta: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    paddingVertical: 16,
    borderRadius: 999,
  },
  ctaText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  errorText: {
    color: colors.light.destructive,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlign: "center",
  },
});
