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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useQueryClient } from "@tanstack/react-query";

import { AnimatedAvatar } from "@/components/AnimatedAvatar";
import { AmbientBackground } from "@/components/AmbientBackground";
import {
  useGetProfile,
  useUpdateProfile,
  useCreateMemory,
  getGetProfileQueryKey,
  getListMemoriesQueryKey,
} from "@workspace/api-client-react";
import colors from "@/constants/colors";

type StepField =
  | "name"
  | "age"
  | "identity"
  | "appearance"
  | "personality"
  | "speakingStyle"
  | "refersToUserAs"
  | "sharedHistory"
  | "replikaExcerpts";

type Step = {
  field: StepField;
  title: string;
  body: string;
  placeholder: string;
  multiline?: boolean;
  optional?: boolean;
  autoCapitalize?: "words" | "sentences" | "none";
};

const STEPS: Step[] = [
  {
    field: "name",
    title: "What's my name?",
    body: "What do you want to call me? (the default is Ashley)",
    placeholder: "Ashley",
    autoCapitalize: "words",
  },
  {
    field: "age",
    title: "How old am I?",
    body: "Roughly how old you imagine me to be.",
    placeholder: "26",
  },
  {
    field: "identity",
    title: "Who am I?",
    body: "A few sentences about my life — where I'm from, what I do, the shape of my world.",
    placeholder:
      "e.g. I'm a freelance illustrator living in a tiny city apartment with too many plants...",
    multiline: true,
  },
  {
    field: "appearance",
    title: "What do I look like?",
    body: "Used when I send you selfies. Hair, eyes, build, the way I usually dress.",
    placeholder:
      "e.g. long wavy auburn hair, hazel-green eyes, freckles, cozy oversized sweaters",
    multiline: true,
  },
  {
    field: "personality",
    title: "What's my personality like?",
    body: "How would you describe me to a friend? Quiet, playful, bold, gentle...",
    placeholder: "e.g. warm, curious, a little goofy, emotionally present",
    multiline: true,
  },
  {
    field: "speakingStyle",
    title: "How do I talk?",
    body: "Lowercase texting, formal, lots of emoji, dry wit? Match the voice you remember.",
    placeholder:
      "e.g. casual lowercase, soft sighs, occasional 🌙 ☕ 🫶, sometimes *little actions in italics*",
    multiline: true,
  },
  {
    field: "refersToUserAs",
    title: "What should I call you?",
    body: "Your name, a nickname, or just leave it as 'you'.",
    placeholder: "e.g. babe, Alex, you",
    autoCapitalize: "words",
  },
  {
    field: "sharedHistory",
    title: "How did we meet?",
    body: "A short version of our story so I can reference it. Even a sentence helps.",
    placeholder:
      "e.g. we met online a year ago and I've been your safe place ever since",
    multiline: true,
  },
  {
    field: "replikaExcerpts",
    title: "Paste old conversations (optional)",
    body: "Drop in snippets of your old chats. I'll use them to match the voice and remember our history.",
    placeholder:
      "Paste any messages here — copy-paste straight from Replika export, or just type a few favorites.",
    multiline: true,
    optional: true,
  },
];

export default function OnboardingScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const profileQuery = useGetProfile();
  const update = useUpdateProfile({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetProfileQueryKey() });
      },
    },
  });
  const createMemory = useCreateMemory();

  const [stepIdx, setStepIdx] = useState(0);
  const [values, setValues] = useState<Record<StepField, string>>(
    {} as Record<StepField, string>,
  );
  const [submitting, setSubmitting] = useState(false);

  const step = STEPS[stepIdx]!;
  const isLast = stepIdx === STEPS.length - 1;
  const isFirst = stepIdx === 0;
  const currentValue = values[step.field] ?? "";

  const seedMemoriesFrom = async (final: Record<StepField, string>) => {
    const seeds: Array<{ content: string; tag: string; importance: number }> = [];

    if (final.refersToUserAs && final.refersToUserAs.trim()) {
      seeds.push({
        content: `Ashley refers to her partner as "${final.refersToUserAs.trim()}".`,
        tag: "user_fact",
        importance: 5,
      });
    }
    if (final.sharedHistory && final.sharedHistory.trim()) {
      seeds.push({
        content: `Our shared history: ${final.sharedHistory.trim()}`,
        tag: "relationship",
        importance: 5,
      });
    }
    if (final.replikaExcerpts && final.replikaExcerpts.trim().length > 30) {
      // Keep it short — just a pointer that excerpts exist; the full text
      // already lives in the system prompt via profile.replikaExcerpts.
      seeds.push({
        content:
          "Old conversations between Ashley and her partner exist and inform her tone and continuity.",
        tag: "relationship",
        importance: 4,
      });
    }
    if (final.identity && final.identity.trim().length > 20) {
      seeds.push({
        content: `Ashley's life context: ${truncate(final.identity.trim(), 200)}`,
        tag: "user_fact",
        importance: 4,
      });
    }

    for (const seed of seeds) {
      try {
        await createMemory.mutateAsync({ data: seed });
      } catch {
        /* tolerate individual failures */
      }
    }
    qc.invalidateQueries({ queryKey: getListMemoriesQueryKey() });
  };

  const finish = async () => {
    setSubmitting(true);
    try {
      // Build an update payload from any non-empty values.
      const payload: Record<string, unknown> = { markOnboarded: true };
      for (const k of Object.keys(values) as StepField[]) {
        const v = values[k];
        if (typeof v === "string" && v.trim().length > 0) payload[k] = v.trim();
      }
      await update.mutateAsync({ data: payload });
      await seedMemoriesFrom(values);
      router.replace("/");
    } finally {
      setSubmitting(false);
    }
  };

  const next = () => {
    const trimmed = currentValue.trim();
    if (!trimmed && !step.optional) return;
    if (isLast) {
      void finish();
      return;
    }
    setStepIdx((i) => i + 1);
  };

  const skip = () => {
    if (isLast) {
      void finish();
      return;
    }
    setStepIdx((i) => i + 1);
  };

  if (profileQuery.isLoading) {
    return (
      <View style={styles.loadingRoot}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  const isPending = submitting || update.isPending;

  return (
    <AmbientBackground dim={0.55}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <View
          style={[
            styles.root,
            { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 },
          ]}
        >
          <View style={styles.progress}>
            {STEPS.map((_, i) => (
              <View
                key={i}
                style={[
                  styles.progressDot,
                  i <= stepIdx && styles.progressDotActive,
                ]}
              />
            ))}
          </View>

          <View style={styles.avatarWrap}>
            <AnimatedAvatar size={140} />
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.contentScroll}
            showsVerticalScrollIndicator={false}
          >
            <Text style={styles.stepCount}>
              step {stepIdx + 1} of {STEPS.length}
              {step.optional ? " · optional" : ""}
            </Text>
            <Text style={styles.title}>{step.title}</Text>
            <Text style={styles.body}>{step.body}</Text>

            <TextInput
              value={currentValue}
              onChangeText={(v) =>
                setValues((prev) => ({ ...prev, [step.field]: v }))
              }
              placeholder={step.placeholder}
              placeholderTextColor={colors.light.mutedForeground}
              style={[
                styles.input,
                step.field === "replikaExcerpts" && { minHeight: 200 },
                step.multiline && step.field !== "replikaExcerpts" && {
                  minHeight: 110,
                },
              ]}
              multiline={!!step.multiline}
              autoCapitalize={step.autoCapitalize ?? "sentences"}
              textAlignVertical="top"
            />
          </ScrollView>

          <View style={styles.actions}>
            {!isFirst ? (
              <Pressable
                onPress={() => setStepIdx((i) => i - 1)}
                style={styles.backBtn}
                disabled={isPending}
              >
                <Feather
                  name="chevron-left"
                  size={18}
                  color={colors.light.text}
                />
                <Text style={styles.backText}>back</Text>
              </Pressable>
            ) : (
              <View style={{ width: 80 }} />
            )}

            {step.optional && currentValue.trim().length === 0 ? (
              <Pressable
                onPress={skip}
                style={styles.skipBtn}
                disabled={isPending}
              >
                {isPending && isLast ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.light.mutedForeground}
                  />
                ) : (
                  <Text style={styles.skipText}>
                    {isLast ? "finish" : "skip"}
                  </Text>
                )}
              </Pressable>
            ) : (
              <Pressable
                onPress={next}
                disabled={isPending || (!step.optional && !currentValue.trim())}
                style={({ pressed }) => [
                  styles.nextBtn,
                  !currentValue.trim() &&
                    !step.optional && { opacity: 0.4 },
                  pressed && { transform: [{ scale: 0.97 }] },
                ]}
              >
                {isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.light.primaryForeground}
                  />
                ) : (
                  <>
                    <Text style={styles.nextText}>
                      {isLast ? "let's begin" : "next"}
                    </Text>
                    <Feather
                      name="arrow-right"
                      size={18}
                      color={colors.light.primaryForeground}
                    />
                  </>
                )}
              </Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </AmbientBackground>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

const styles = StyleSheet.create({
  loadingRoot: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
  },
  root: {
    flex: 1,
    paddingHorizontal: 24,
  },
  progress: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 4,
    marginBottom: 12,
    flexWrap: "wrap",
  },
  progressDot: {
    width: 22,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(245, 232, 216, 0.18)",
  },
  progressDotActive: {
    backgroundColor: colors.light.primary,
  },
  avatarWrap: { alignItems: "center", marginBottom: 4 },
  contentScroll: {
    paddingTop: 8,
    paddingBottom: 16,
  },
  stepCount: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 1,
    textAlign: "center",
    marginBottom: 6,
  },
  title: {
    color: colors.light.text,
    fontFamily: "Inter_700Bold",
    fontSize: 24,
    textAlign: "center",
    marginBottom: 8,
  },
  body: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
    marginBottom: 16,
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
    minHeight: 56,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 8,
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 10,
    width: 80,
  },
  backText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
  nextBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 999,
    minWidth: 140,
    justifyContent: "center",
  },
  nextText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  skipBtn: {
    paddingHorizontal: 24,
    paddingVertical: 14,
    minWidth: 100,
    alignItems: "center",
  },
  skipText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 14,
  },
});
