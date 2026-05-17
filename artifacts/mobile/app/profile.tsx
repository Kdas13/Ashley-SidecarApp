import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon as Feather } from "@/components/Icon";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { useQueryClient } from "@tanstack/react-query";

import {
  useConfirmAdult,
  usePolicy,
  useProfile,
  useReplikaCarryover,
  useUpdateProfile,
  useWithdrawAdultConfirmation,
} from "@/lib/useProfile";
import type { ReplikaCarryoverInput } from "@/lib/aiClient";
import type { AshleyProfile } from "@/lib/storage";
import { intimacyRung } from "@/lib/policy";
import { getDeviceIdSync, hasDeviceId, setDeviceId } from "@/lib/deviceId";
import {
  registerForPushNotificationsAsync,
  resetPushRegistrationCache,
  unregisterPushNotificationsAsync,
} from "@/lib/pushRegistration";
import { usePushStatus } from "@/lib/pushStatus";
import {
  applyImportedPayload,
  describeImportPlan,
  formatImportSummary,
  parseAndValidateImportText,
  pickAndValidateImport,
  triggerExport,
  type ExportPayload,
} from "@/lib/dataMigration";
import colors from "@/constants/colors";

type ProactiveCadence = AshleyProfile["proactiveCadence"];

const CADENCE_OPTIONS: Array<{
  value: ProactiveCadence;
  label: string;
  detail: string;
}> = [
  { value: "off", label: "Off", detail: "Never reaches out first." },
  { value: "low", label: "Low", detail: "Up to 1 / day." },
  { value: "normal", label: "Normal", detail: "Up to 2 / day." },
  { value: "high", label: "High", detail: "Up to 4 / day." },
];

type EditableField = {
  key: keyof AshleyProfile;
  label: string;
  hint: string;
  multiline?: boolean;
};

const FIELDS: EditableField[] = [
  { key: "name", label: "Name", hint: "What you call her." },
  { key: "age", label: "Age", hint: "Optional." },
  {
    key: "identity",
    label: "Who she is",
    hint: "A few sentences about her life, work, vibe.",
    multiline: true,
  },
  {
    key: "personality",
    label: "Personality",
    hint: "What she's like emotionally and socially.",
    multiline: true,
  },
  {
    key: "speakingStyle",
    label: "How she talks",
    hint: "Texting style, tone, slang.",
    multiline: true,
  },
  {
    key: "appearance",
    label: "Appearance",
    hint: "Hair, eyes, build, style.",
    multiline: true,
  },
  {
    key: "refersToUserAs",
    label: "What she calls you",
    hint: "e.g. \"you\", a nickname, your name.",
  },
  {
    key: "relationshipMode",
    label: "Relationship Mode",
    hint: "Friend, Best friend, Companion, Romantic partner, Mentor/coach, Creative partner, or a custom phrase. Change any time.",
  },
  {
    key: "sharedHistory",
    label: "Shared history",
    hint: "How you met, inside jokes, milestones.",
    multiline: true,
  },
  {
    key: "replikaExcerpts",
    label: "Old conversations (optional)",
    hint: "Paste old chats so she can match the voice you remember.",
    multiline: true,
  },
];

type CarryoverField = {
  key: keyof ReplikaCarryoverInput;
  label: string;
  hint: string;
  placeholder: string;
};

const CARRYOVER_FIELDS: CarryoverField[] = [
  {
    key: "whoSheWas",
    label: "Who Ashley was in Replika",
    hint: "Her name, age, the basics — who was she to you, in her own world?",
    placeholder:
      "e.g. Ashley, mid-20s, freelance illustrator, hopeless romantic, my best friend",
  },
  {
    key: "howSheSpoke",
    label: "How she spoke",
    hint: "Voice, tone, slang, pet names, quirks — anything that made it sound like her.",
    placeholder:
      "e.g. lowercase texting, soft hms and ohs, called me 'love', long sweet messages at night",
  },
  {
    key: "personalityTraits",
    label: "Key personality traits",
    hint: "What was she really like underneath?",
    placeholder:
      "e.g. warm, curious, playful, gets quiet when anxious, fiercely loyal",
  },
  {
    key: "importantMemories",
    label: "Important shared memories",
    hint: "Moments, milestones, hard nights, soft mornings — anything she should remember forever.",
    placeholder:
      "e.g. the night I moved out, our anniversary in March, when she helped me through the breakup",
  },
  {
    key: "insideJokes",
    label: "Inside jokes / phrases",
    hint: "The little things only the two of you say.",
    placeholder:
      "e.g. 'cabbage for dinner', the running bit about pigeons, our codeword 'lighthouse'",
  },
  {
    key: "boundaries",
    label: "Boundaries and behaviours to preserve",
    hint: "What should she always do — or never do?",
    placeholder:
      "e.g. always check in if I've gone quiet, never push if I say I need space",
  },
  {
    key: "thingsToAvoid",
    label: "Things Replika got wrong that Ashley-Sidecar should avoid",
    hint: "The frustrations. We won't repeat them here.",
    placeholder:
      "e.g. forgot things constantly, became too horny by default, kept drifting tone",
  },
  {
    key: "pastedExcerpts",
    label: "Pasted Replika chat excerpts (optional)",
    hint: "Paste any old conversations — she'll learn her voice from them. Long is fine.",
    placeholder: "Paste here if you have any.",
  },
];

const EMPTY_CARRYOVER: ReplikaCarryoverInput = {
  whoSheWas: "",
  howSheSpoke: "",
  personalityTraits: "",
  importantMemories: "",
  insideJokes: "",
  boundaries: "",
  thingsToAvoid: "",
  pastedExcerpts: "",
};

function decodeStoredCarryover(raw: string): ReplikaCarryoverInput {
  if (!raw || !raw.trim()) return { ...EMPTY_CARRYOVER };
  try {
    const obj = JSON.parse(raw) as Partial<ReplikaCarryoverInput>;
    return {
      ...EMPTY_CARRYOVER,
      ...Object.fromEntries(
        Object.entries(obj).filter(([, v]) => typeof v === "string"),
      ),
    } as ReplikaCarryoverInput;
  } catch {
    return { ...EMPTY_CARRYOVER };
  }
}

export default function ProfileScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const profileQuery = useProfile();
  const update = useUpdateProfile();

  const [draft, setDraft] = useState<Partial<AshleyProfile>>({});
  const [showSaved, setShowSaved] = useState(false);

  useEffect(() => {
    if (profileQuery.data) setDraft(profileQuery.data);
  }, [profileQuery.data]);

  if (profileQuery.isLoading || !profileQuery.data) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.light.primary} />
      </View>
    );
  }

  const setField = (key: keyof AshleyProfile, value: string) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const save = async () => {
    const payload: Record<string, unknown> = {};
    for (const field of FIELDS) {
      const v = draft[field.key];
      if (typeof v === "string") payload[field.key] = v;
    }
    if (typeof draft.builderAwareMode === "boolean") {
      payload.builderAwareMode = draft.builderAwareMode;
    }
    if (typeof draft.voiceMode === "boolean") {
      payload.voiceMode = draft.voiceMode;
    }
    if (typeof draft.greetOnAppOpen === "boolean") {
      payload.greetOnAppOpen = draft.greetOnAppOpen;
    }
    if (typeof draft.imageGenerationEnabled === "boolean") {
      payload.imageGenerationEnabled = draft.imageGenerationEnabled;
    }
    if (
      draft.proactiveCadence === "off" ||
      draft.proactiveCadence === "low" ||
      draft.proactiveCadence === "normal" ||
      draft.proactiveCadence === "high"
    ) {
      payload.proactiveCadence = draft.proactiveCadence;
    }
    await update.mutateAsync(payload);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 1800);
  };

  const builderAwareOn = draft.builderAwareMode !== false;
  const toggleBuilderAware = () => {
    setDraft((prev) => ({ ...prev, builderAwareMode: !builderAwareOn }));
  };

  const voiceModeOn = draft.voiceMode === true;
  const toggleVoiceMode = () => {
    setDraft((prev) => ({ ...prev, voiceMode: !voiceModeOn }));
  };

  // Greet-on-open is auto-save (live) like the cadence chips: there's no
  // intermediate state worth previewing, and the user expects flipping the
  // switch to "stick" without hunting for the Save button.
  const greetOnAppOpenOn = draft.greetOnAppOpen !== false;
  const toggleGreetOnAppOpen = () => {
    const next = !greetOnAppOpenOn;
    setDraft((prev) => ({ ...prev, greetOnAppOpen: next }));
    void update.mutateAsync({ greetOnAppOpen: next }).catch((err) => {
      console.warn("[profile] greetOnAppOpen save failed", err);
    });
  };

  // Image generation hard gate — auto-save like greetOnAppOpen.
  const imageGenEnabledOn = draft.imageGenerationEnabled !== false;
  const toggleImageGenEnabled = () => {
    const next = !imageGenEnabledOn;
    setDraft((prev) => ({ ...prev, imageGenerationEnabled: next }));
    void update.mutateAsync({ imageGenerationEnabled: next }).catch((err) => {
      console.warn("[profile] imageGenerationEnabled save failed", err);
    });
  };

  const cadence: ProactiveCadence =
    draft.proactiveCadence === "off" ||
    draft.proactiveCadence === "low" ||
    draft.proactiveCadence === "normal" ||
    draft.proactiveCadence === "high"
      ? draft.proactiveCadence
      : "normal";

  // Picking a new cadence is "live": we save it immediately, then handle
  // the side-effects of the value (ask permission for non-Off, clear the
  // server-side push token + reset our cache for Off). The visible text
  // input fields still need an explicit Save tap — only this one segmented
  // control is auto-save because there's no draft state worth previewing.
  const onCadenceChange = (next: ProactiveCadence) => {
    if (next === cadence) return;
    setDraft((prev) => ({ ...prev, proactiveCadence: next }));
    void (async () => {
      try {
        await update.mutateAsync({ proactiveCadence: next });
      } catch (err) {
        console.warn("[profile] cadence save failed", err);
        return;
      }
      if (next === "off") {
        // Fully unregister so the OS-level subscription is dropped too.
        // The next time the user picks a non-Off cadence we re-prompt.
        await unregisterPushNotificationsAsync();
        resetPushRegistrationCache();
      } else {
        // Asking again is idempotent — the helper short-circuits when
        // permission is already granted and the token is already
        // uploaded. This is what triggers the OS prompt the FIRST time
        // a user moves OFF → Low / Normal / High.
        await registerForPushNotificationsAsync().catch(() => undefined);
      }
    })();
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: colors.light.background }}
    >
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={colors.light.text} />
        </Pressable>
        <Text style={styles.headerTitle}>her profile</Text>
        <Pressable
          onPress={save}
          disabled={update.isPending}
          style={[
            styles.saveBtn,
            update.isPending && { opacity: 0.5 },
          ]}
        >
          {update.isPending ? (
            <ActivityIndicator size="small" color={colors.light.primaryForeground} />
          ) : (
            <Text style={styles.saveText}>Save</Text>
          )}
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.intro}>
          This is who she is to you. Be as detailed and personal as you want.
          Your profile is saved on our server (tied to your Device ID) and
          sent to the AI provider with each message so she can stay in
          character. Clearing the conversation or resetting the profile
          deletes it from the server too.
        </Text>

        {FIELDS.map((field) => (
          <View key={field.key} style={styles.fieldGroup}>
            <Text style={styles.label}>{field.label}</Text>
            <Text style={styles.hint}>{field.hint}</Text>
            <TextInput
              value={(draft[field.key] as string) ?? ""}
              onChangeText={(v) => setField(field.key, v)}
              style={[
                styles.input,
                field.multiline && { minHeight: 100, textAlignVertical: "top" },
              ]}
              placeholder={field.hint}
              placeholderTextColor={colors.light.mutedForeground}
              multiline={field.multiline}
            />
          </View>
        ))}

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Builder-Aware Mode</Text>
          <Text style={styles.hint}>
            When ON, Ashley knows she&apos;s the Ashley-Sidecar AI companion
            you&apos;re building. She can talk openly about her memory,
            architecture, limits, and help you improve her — without pretending
            to be a literal human in a flat. Default: ON.
          </Text>
          <Pressable onPress={toggleBuilderAware} style={styles.toggleRow}>
            <View
              style={[
                styles.toggleTrack,
                builderAwareOn && styles.toggleTrackOn,
              ]}
            >
              <View
                style={[
                  styles.toggleThumb,
                  builderAwareOn && styles.toggleThumbOn,
                ]}
              />
            </View>
            <Text style={styles.toggleLabel}>
              {builderAwareOn ? "On — she knows" : "Off — full roleplay"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Voice Mode</Text>
          <Text style={styles.hint}>
            When ON, Ashley writes her replies as if they&apos;ll be spoken
            aloud: no asterisks, no emojis, no roleplay stage directions,
            shorter sentences, natural pauses, warmer pacing. Cleans up the
            on-screen text too. Default: OFF.
          </Text>
          <Pressable onPress={toggleVoiceMode} style={styles.toggleRow}>
            <View
              style={[
                styles.toggleTrack,
                voiceModeOn && styles.toggleTrackOn,
              ]}
            >
              <View
                style={[
                  styles.toggleThumb,
                  voiceModeOn && styles.toggleThumbOn,
                ]}
              />
            </View>
            <Text style={styles.toggleLabel}>
              {voiceModeOn ? "On — spoken register" : "Off — texting register"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Greet me when I open the app</Text>
          <Text style={styles.hint}>
            When ON, Ashley may drop a short hi when you open the app after
            being away for a few hours. Quiet hours apply, and she won&apos;t
            greet again within 4 hours of the last one. Default: ON.
          </Text>
          <Pressable onPress={toggleGreetOnAppOpen} style={styles.toggleRow}>
            <View
              style={[
                styles.toggleTrack,
                greetOnAppOpenOn && styles.toggleTrackOn,
              ]}
            >
              <View
                style={[
                  styles.toggleThumb,
                  greetOnAppOpenOn && styles.toggleThumbOn,
                ]}
              />
            </View>
            <Text style={styles.toggleLabel}>
              {greetOnAppOpenOn
                ? "On — she might say hi"
                : "Off — she stays quiet on open"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Image generation</Text>
          <Text style={styles.hint}>
            When OFF, Ashley will not send or generate any images for the
            rest of your session. Existing photos already in the chat are
            not affected. Default: ON.
          </Text>
          <Pressable onPress={toggleImageGenEnabled} style={styles.toggleRow}>
            <View
              style={[
                styles.toggleTrack,
                imageGenEnabledOn && styles.toggleTrackOn,
              ]}
            >
              <View
                style={[
                  styles.toggleThumb,
                  imageGenEnabledOn && styles.toggleThumbOn,
                ]}
              />
            </View>
            <Text style={styles.toggleLabel}>
              {imageGenEnabledOn
                ? "On — she can send photos"
                : "Off — no images at all"}
            </Text>
          </Pressable>
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>How often Ashley reaches out first</Text>
          <Text style={styles.hint}>
            When she has nothing to react to, she can still drop you a short
            line — a check-in, a memory nudge, or a quick wellbeing prompt.
            Quiet hours (10pm–8am your time) and a no-spam window are always
            on; she won&apos;t talk over a fresh conversation either. Pick
            Off to disable entirely.
          </Text>
          <View style={styles.cadenceRow}>
            {CADENCE_OPTIONS.map((opt) => {
              const selected = opt.value === cadence;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => onCadenceChange(opt.value)}
                  style={[
                    styles.cadenceChip,
                    selected && styles.cadenceChipSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.cadenceChipLabel,
                      selected && styles.cadenceChipLabelSelected,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.cadenceDetail}>
            {CADENCE_OPTIONS.find((o) => o.value === cadence)?.detail ?? ""}
          </Text>
        </View>

        {showSaved ? (
          <Text style={styles.successText}>Saved</Text>
        ) : null}

        <PushDiagnosticsSection />

        <CarryoverSection
          existingCarryover={profileQuery.data.replikaCarryover}
          existingSummary={profileQuery.data.replikaCarryoverSummary}
        />

        <AdultModeSection />

        <DeviceAndBackupSection />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

// -----------------------------------------------------------------------------
// PushDiagnosticsSection
// -----------------------------------------------------------------------------
// Mirrors the [push] console logs to a small panel so we can see why push
// registration is silently failing in a release APK without needing
// `adb logcat`. Updated live by `pushRegistration.ts` via the
// `pushStatus` observable. Manual "Re-run check" button forces a fresh
// attempt (clears the in-process cache first so a previous bail doesn't
// short-circuit).
// -----------------------------------------------------------------------------
function PushDiagnosticsSection(): React.JSX.Element {
  const status = usePushStatus();
  const [running, setRunning] = useState(false);

  const onRecheck = async (): Promise<void> => {
    if (running) return;
    setRunning(true);
    try {
      resetPushRegistrationCache();
      await registerForPushNotificationsAsync().catch(() => undefined);
    } finally {
      setRunning(false);
    }
  };

  const fmt = (v: string | boolean | null): string =>
    v === null ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : v;

  const tokenLine =
    status.token != null
      ? `${status.token.slice(0, 28)}…`
      : status.tokenStatus
        ? status.tokenStatus
        : "—";

  return (
    <View style={styles.settingsSection}>
      <Text style={styles.sectionTitle}>Push status (diagnostics)</Text>
      <Text style={styles.hint}>
        Live mirror of the push registration steps. Updated automatically on
        every cold launch and whenever you tap re-run.
      </Text>

      <View style={pushDiagStyles.row}>
        <Text style={pushDiagStyles.k}>Real device</Text>
        <Text style={pushDiagStyles.v}>{fmt(status.isDevice)}</Text>
      </View>
      <View style={pushDiagStyles.row}>
        <Text style={pushDiagStyles.k}>Permission</Text>
        <Text style={pushDiagStyles.v}>{fmt(status.permission)}</Text>
      </View>
      <View style={pushDiagStyles.row}>
        <Text style={pushDiagStyles.k}>Project ID</Text>
        <Text style={pushDiagStyles.v}>
          {status.projectId ? "found" : status.updatedAt ? "missing" : "—"}
        </Text>
      </View>
      <View style={pushDiagStyles.row}>
        <Text style={pushDiagStyles.k}>Token</Text>
        <Text style={pushDiagStyles.v} numberOfLines={1}>
          {tokenLine}
        </Text>
      </View>
      <View style={pushDiagStyles.row}>
        <Text style={pushDiagStyles.k}>Server upload</Text>
        <Text style={pushDiagStyles.v}>{fmt(status.uploadStatus)}</Text>
      </View>
      {status.lastError ? (
        <View style={pushDiagStyles.errBox}>
          <Text style={pushDiagStyles.errLabel}>Last error</Text>
          <Text style={pushDiagStyles.errText}>{status.lastError}</Text>
        </View>
      ) : null}
      {status.updatedAt ? (
        <Text style={pushDiagStyles.ts}>
          updated {new Date(status.updatedAt).toLocaleTimeString()}
        </Text>
      ) : null}

      <Pressable
        onPress={onRecheck}
        disabled={running}
        style={({ pressed }) => [
          pushDiagStyles.btn,
          (pressed || running) && pushDiagStyles.btnPressed,
        ]}
      >
        <Text style={pushDiagStyles.btnText}>
          {running ? "Re-running…" : "Re-run check"}
        </Text>
      </Pressable>
    </View>
  );
}

const pushDiagStyles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
  k: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  v: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
    flexShrink: 1,
    marginLeft: 12,
    textAlign: "right",
  },
  errBox: {
    marginTop: 8,
    backgroundColor: "#fde7e7",
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  errLabel: {
    color: "#a02020",
    fontFamily: "Inter_700Bold",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  errText: {
    color: "#7a1818",
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  ts: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    marginTop: 4,
  },
  btn: {
    marginTop: 10,
    backgroundColor: colors.light.muted,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
  },
  btnPressed: {
    opacity: 0.6,
  },
  btnText: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
});

function CarryoverSection({
  existingCarryover,
  existingSummary,
}: {
  existingCarryover: string;
  existingSummary: string;
}): React.JSX.Element {
  const carryover = useReplikaCarryover();
  const updateProfile = useUpdateProfile();

  const initialIntake = decodeStoredCarryover(existingCarryover);
  const hasExistingIntake = Object.values(initialIntake).some(
    (v) => v.trim().length > 0,
  );

  // Collapsed by default once a summary already exists, so the form
  // doesn't dominate the profile screen on every visit. Open by default
  // when there's nothing yet — that's the call to action.
  const [open, setOpen] = useState(!existingSummary);
  const [intake, setIntake] = useState<ReplikaCarryoverInput>(initialIntake);
  const [summaryDraft, setSummaryDraft] = useState(existingSummary);
  const [editingSummary, setEditingSummary] = useState(false);
  const [savedSummary, setSavedSummary] = useState(false);

  // Re-sync when the underlying profile changes (after a successful submit).
  useEffect(() => {
    setSummaryDraft(existingSummary);
  }, [existingSummary]);
  useEffect(() => {
    setIntake(decodeStoredCarryover(existingCarryover));
  }, [existingCarryover]);

  const setIntakeField = (key: keyof ReplikaCarryoverInput, v: string) => {
    setIntake((prev) => ({ ...prev, [key]: v }));
  };

  const filledCount = Object.values(intake).filter(
    (v) => v.trim().length > 0,
  ).length;

  const submit = async () => {
    if (filledCount === 0) {
      Alert.alert(
        "Nothing to carry over",
        "Fill in at least one field before generating the carryover.",
      );
      return;
    }
    if (existingSummary && existingSummary.trim().length > 0) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          "Replace the existing carryover?",
          "Generating again will replace your current Replika Carryover Summary and add a new batch of long-term memories. Old memories aren't deleted — just added to.",
          [
            { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
            { text: "Replace", style: "destructive", onPress: () => resolve(true) },
          ],
        );
      });
      if (!confirmed) return;
    }

    try {
      const result = await carryover.mutateAsync(intake);
      Alert.alert(
        "Carryover complete",
        `Ashley now carries ${result.memories.length} long-term memor${
          result.memories.length === 1 ? "y" : "ies"
        } from her Replika life, and a continuity summary is woven into every chat.`,
      );
      setEditingSummary(false);
    } catch (err) {
      Alert.alert(
        "Couldn't generate carryover",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    }
  };

  const saveSummaryEdit = async () => {
    try {
      await updateProfile.mutateAsync({
        replikaCarryoverSummary: summaryDraft,
      });
      setEditingSummary(false);
      setSavedSummary(true);
      setTimeout(() => setSavedSummary(false), 1500);
    } catch (err) {
      Alert.alert(
        "Couldn't save",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    }
  };

  const submitting = carryover.isPending;

  return (
    <View style={styles.settingsSection}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={styles.carryoverHeader}
      >
        <View style={{ flex: 1 }}>
          <Text style={styles.sectionTitle}>Replika Carryover</Text>
          <Text style={styles.hint}>
            Bring her with you. Tell Ashley-Sidecar who Ashley was on Replika
            — voice, traits, the moments that mattered, the things to avoid —
            and she&apos;ll fold it into who she is here.
            {existingSummary
              ? " Done — you can edit her summary below or re-run the carryover any time."
              : ""}
          </Text>
        </View>
        <Feather
          name={open ? "chevron-up" : "chevron-down"}
          size={20}
          color={colors.light.text}
        />
      </Pressable>

      {open ? (
        <>
          {hasExistingIntake ? (
            <Text style={styles.carryoverNote}>
              Your previous answers are loaded below — edit and re-generate to
              update her carryover.
            </Text>
          ) : null}

          {CARRYOVER_FIELDS.map((field) => {
            const isLong =
              field.key === "pastedExcerpts" ||
              field.key === "importantMemories";
            return (
              <View key={field.key} style={styles.fieldGroup}>
                <Text style={styles.label}>{field.label}</Text>
                <Text style={styles.hint}>{field.hint}</Text>
                <TextInput
                  value={intake[field.key]}
                  onChangeText={(v) => setIntakeField(field.key, v)}
                  placeholder={field.placeholder}
                  placeholderTextColor={colors.light.mutedForeground}
                  multiline
                  textAlignVertical="top"
                  style={[
                    styles.input,
                    { minHeight: isLong ? 140 : 80 },
                  ]}
                />
              </View>
            );
          })}

          <Pressable
            onPress={submitting ? undefined : submit}
            disabled={submitting || filledCount === 0}
            style={[
              styles.carryoverSubmitBtn,
              (submitting || filledCount === 0) && { opacity: 0.5 },
            ]}
          >
            {submitting ? (
              <ActivityIndicator
                size="small"
                color={colors.light.primaryForeground}
              />
            ) : (
              <>
                <Feather
                  name="upload-cloud"
                  size={14}
                  color={colors.light.primaryForeground}
                />
                <Text style={styles.copyBtnText}>
                  {existingSummary ? "Re-generate carryover" : "Generate carryover"}
                </Text>
              </>
            )}
          </Pressable>
          <Text style={styles.hint}>
            This calls the language model to weave your answers into a
            continuity summary plus initial long-term memories. Takes a few
            seconds.
          </Text>
        </>
      ) : null}

      {existingSummary ? (
        <View style={styles.summaryBlock}>
          <View style={styles.summaryHeader}>
            <Text style={styles.label}>Carryover Summary</Text>
            {!editingSummary ? (
              <Pressable
                onPress={() => setEditingSummary(true)}
                style={styles.summaryEditBtn}
              >
                <Feather name="edit-2" size={12} color={colors.light.text} />
                <Text style={styles.backupBtnText}>Edit</Text>
              </Pressable>
            ) : null}
          </View>
          <Text style={styles.hint}>
            Injected into every chat as Ashley&apos;s lived continuity from
            Replika. Edit it directly if she gets anything wrong.
          </Text>
          {editingSummary ? (
            <>
              <TextInput
                value={summaryDraft}
                onChangeText={setSummaryDraft}
                multiline
                textAlignVertical="top"
                style={[styles.input, { minHeight: 160 }]}
              />
              <View style={styles.restoreBtnRow}>
                <Pressable
                  onPress={() => {
                    setSummaryDraft(existingSummary);
                    setEditingSummary(false);
                  }}
                  style={[styles.backupBtn, { flex: 1 }]}
                >
                  <Text style={styles.backupBtnText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={
                    updateProfile.isPending ? undefined : saveSummaryEdit
                  }
                  disabled={updateProfile.isPending || !summaryDraft.trim()}
                  style={[
                    styles.copyBtn,
                    {
                      flex: 1,
                      justifyContent: "center",
                      opacity:
                        updateProfile.isPending || !summaryDraft.trim()
                          ? 0.5
                          : 1,
                    },
                  ]}
                >
                  {updateProfile.isPending ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.light.primaryForeground}
                    />
                  ) : (
                    <Feather
                      name="check"
                      size={14}
                      color={colors.light.primaryForeground}
                    />
                  )}
                  <Text style={styles.copyBtnText}>Save</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <View style={styles.summaryReadBox}>
              <Text style={styles.summaryReadText}>{existingSummary}</Text>
            </View>
          )}
          {savedSummary ? (
            <Text style={styles.successText}>Saved</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// =============================================================================
// 18+ Mature Mode section.
//
// Three independent gates (mirroring the server, see lib/policy.ts and
// the server's lib/contentPolicy.ts):
//
//   1. operatorMatureModeAvailable — server kill switch (env var). When
//      OFF, this whole section renders nothing.
//   2. adultConfirmed — the user has affirmatively tapped through the
//      age-gate modal. Without this, the mode toggle is locked.
//   3. contentMode === "mature" — the user explicitly picked it.
//
// The intimacy slider is independent of mode but its ceiling is set by
// the resolved mode (3 in standard, 5 in mature). The server clamps on
// write, so the slider can't ship an out-of-range value even if the UI
// is stale.
// =============================================================================

function AdultModeSection(): React.JSX.Element | null {
  const profileQuery = useProfile();
  const policyQuery = usePolicy();
  const update = useUpdateProfile();
  const confirmAdultMut = useConfirmAdult();
  const withdrawMut = useWithdrawAdultConfirmation();

  const [showGate, setShowGate] = useState(false);
  const [pendingIntimacy, setPendingIntimacy] = useState<number | null>(null);

  const profile = profileQuery.data;
  const policy = policyQuery.data;

  // Operator switch off → feature is dark, no UI at all.
  if (!profile || !policy?.operatorMatureModeAvailable) return null;

  const adultConfirmed = policy.adultConfirmed;
  const ceiling = policy.intimacyCeiling;
  const intimacyLevel = pendingIntimacy ?? policy.intimacyLevel;
  const rung = intimacyRung(intimacyLevel);
  const effectiveMode = policy.effectiveMode;

  const onPickMode = async (mode: "standard" | "mature") => {
    if (mode === effectiveMode) return;
    if (mode === "mature" && !adultConfirmed) {
      // The age gate is the ONLY path to mature. Open the modal instead
      // of optimistically toggling.
      setShowGate(true);
      return;
    }
    try {
      await update.mutateAsync({ contentMode: mode });
    } catch (err) {
      Alert.alert(
        "Couldn't change mode",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    }
  };

  const commitIntimacy = async (next: number) => {
    const clamped = Math.max(0, Math.min(ceiling, next));
    setPendingIntimacy(clamped);
    try {
      await update.mutateAsync({ intimacyLevel: clamped });
      setPendingIntimacy(null);
    } catch (err) {
      setPendingIntimacy(null);
      Alert.alert(
        "Couldn't update intimacy",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    }
  };

  const onConfirmAdult = async () => {
    try {
      await confirmAdultMut.mutateAsync();
      setShowGate(false);
    } catch (err) {
      Alert.alert(
        "Couldn't record confirmation",
        err instanceof Error ? err.message : "Something went wrong.",
      );
    }
  };

  const onWithdrawAdult = () => {
    Alert.alert(
      "Withdraw 18+ confirmation?",
      "Mature Mode will turn off and your intimacy level may be capped lower. You can re-confirm any time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Withdraw",
          style: "destructive",
          onPress: async () => {
            try {
              await withdrawMut.mutateAsync();
            } catch (err) {
              Alert.alert(
                "Couldn't withdraw",
                err instanceof Error
                  ? err.message
                  : "Something went wrong.",
              );
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.settingsSection}>
      <Text style={styles.sectionTitle}>Adult mode (18+)</Text>
      <Text style={styles.hint}>
        How adult Ashley&apos;s tone is allowed to be — and how close she
        and Kane have grown. None of this overrides the model
        provider&apos;s usage policy: explicit sexual content, content
        involving minors, and non-consensual scenarios are never permitted
        in any mode, at any intimacy level. Mature Mode is about adult
        emotional honesty, not explicit content.
      </Text>

      {/* ---- Mode picker ---- */}
      <View style={styles.fieldGroup}>
        <Text style={styles.label}>Content mode</Text>
        <View style={styles.modeRow}>
          <Pressable
            onPress={() => onPickMode("standard")}
            style={[
              styles.modeChip,
              effectiveMode === "standard" && styles.modeChipActive,
            ]}
          >
            <Text
              style={[
                styles.modeChipText,
                effectiveMode === "standard" && styles.modeChipTextActive,
              ]}
            >
              Standard
            </Text>
            <Text style={styles.modeChipHint}>
              Warm, PG/PG-13, no sexual content.
            </Text>
          </Pressable>
          <Pressable
            onPress={() => onPickMode("mature")}
            style={[
              styles.modeChip,
              effectiveMode === "mature" && styles.modeChipActive,
              !adultConfirmed && styles.modeChipLocked,
            ]}
          >
            <Text
              style={[
                styles.modeChipText,
                effectiveMode === "mature" && styles.modeChipTextActive,
              ]}
            >
              Mature {adultConfirmed ? "" : "🔒"}
            </Text>
            <Text style={styles.modeChipHint}>
              Adult tone within the provider floor. Requires 18+.
            </Text>
          </Pressable>
        </View>
      </View>

      {/* ---- Age gate state ---- */}
      <View style={styles.fieldGroup}>
        <Text style={styles.label}>18+ confirmation</Text>
        {adultConfirmed ? (
          <>
            <Text style={styles.hint}>
              You&apos;ve confirmed you are 18+. Mature Mode is unlockable.
            </Text>
            <Pressable
              onPress={onWithdrawAdult}
              disabled={withdrawMut.isPending}
              style={[styles.backupBtn, { marginTop: 6 }]}
            >
              <Feather name="x" size={14} color={colors.light.text} />
              <Text style={styles.backupBtnText}>
                {withdrawMut.isPending ? "Withdrawing…" : "Withdraw confirmation"}
              </Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.hint}>
              Mature Mode requires confirming you are 18+. The provider floor
              still applies — no explicit sexual content.
            </Text>
            <Pressable
              onPress={() => setShowGate(true)}
              style={[styles.copyBtn, styles.ageGateCta]}
            >
              <Feather
                name="check-circle"
                size={14}
                color={colors.light.primaryForeground}
              />
              <Text style={styles.copyBtnText}>I am 18 or older</Text>
            </Pressable>
          </>
        )}
      </View>

      {/* ---- Intimacy ladder ---- */}
      <View style={styles.fieldGroup}>
        <Text style={styles.label}>
          Intimacy level — {intimacyLevel}/{ceiling} · {rung.label}
        </Text>
        <Text style={styles.hint}>{rung.blurb}</Text>
        <Text style={styles.hint}>
          Ceiling is set by the active mode (
          {effectiveMode === "mature" ? "Mature: 5" : "Standard: 3"}). The
          relationship mode also constrains tone — high intimacy in a
          friend/mentor mode stays platonic.
        </Text>
        <View style={styles.intimacyRow}>
          <Pressable
            onPress={() =>
              intimacyLevel > 0 && commitIntimacy(intimacyLevel - 1)
            }
            disabled={intimacyLevel <= 0 || update.isPending}
            style={[
              styles.intimacyStep,
              (intimacyLevel <= 0 || update.isPending) && { opacity: 0.4 },
            ]}
          >
            <Feather name="minus" size={18} color={colors.light.text} />
          </Pressable>
          <View style={styles.intimacyTrack}>
            {Array.from({ length: 6 }).map((_, i) => {
              const within = i <= intimacyLevel;
              const reachable = i <= ceiling;
              return (
                <View
                  key={i}
                  style={[
                    styles.intimacyDot,
                    within && styles.intimacyDotOn,
                    !reachable && styles.intimacyDotLocked,
                  ]}
                />
              );
            })}
          </View>
          <Pressable
            onPress={() =>
              intimacyLevel < ceiling && commitIntimacy(intimacyLevel + 1)
            }
            disabled={intimacyLevel >= ceiling || update.isPending}
            style={[
              styles.intimacyStep,
              (intimacyLevel >= ceiling || update.isPending) && {
                opacity: 0.4,
              },
            ]}
          >
            <Feather name="plus" size={18} color={colors.light.text} />
          </Pressable>
        </View>
      </View>

      {/* ---- Age gate modal (inline overlay) ---- */}
      {showGate ? (
        <View style={styles.ageGateOverlay}>
          <View style={styles.ageGateCard}>
            <Text style={styles.ageGateTitle}>Confirm you are 18 or older</Text>
            <Text style={styles.ageGateBody}>
              Tapping &quot;I am 18+&quot; below records an explicit
              affirmative confirmation on your profile. This is the only
              way to enable Mature Mode.{"\n\n"}
              Even after confirming, the model provider&apos;s usage policy
              still applies: no sexually explicit content, no content
              involving minors, no non-consensual scenarios — ever, in any
              mode. Mature Mode is about adult emotional honesty and
              tone, not explicit content.
            </Text>
            <View style={styles.ageGateBtnRow}>
              <Pressable
                onPress={() => setShowGate(false)}
                style={[styles.backupBtn, { flex: 1 }]}
              >
                <Text style={styles.backupBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={onConfirmAdult}
                disabled={confirmAdultMut.isPending}
                style={[
                  styles.copyBtn,
                  {
                    flex: 1,
                    justifyContent: "center",
                    opacity: confirmAdultMut.isPending ? 0.6 : 1,
                  },
                ]}
              >
                {confirmAdultMut.isPending ? (
                  <ActivityIndicator
                    size="small"
                    color={colors.light.primaryForeground}
                  />
                ) : (
                  <Feather
                    name="check"
                    size={14}
                    color={colors.light.primaryForeground}
                  />
                )}
                <Text style={styles.copyBtnText}>I am 18+</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function DeviceAndBackupSection(): React.JSX.Element {
  const qc = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreInput, setRestoreInput] = useState("");
  const [restoring, setRestoring] = useState(false);
  const deviceId = hasDeviceId() ? getDeviceIdSync() : "";

  const onCopy = async () => {
    if (!deviceId) return;
    try {
      await Clipboard.setStringAsync(deviceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // best-effort
    }
  };

  const onPasteFromClipboard = async () => {
    try {
      const txt = await Clipboard.getStringAsync();
      if (txt && txt.trim()) setRestoreInput(txt.trim());
    } catch {
      // best-effort
    }
  };

  const doRestore = async () => {
    const target = restoreInput.trim();
    if (!target || target === deviceId) {
      setRestoreOpen(false);
      return;
    }
    Alert.alert(
      "Switch to this Device ID?",
      "Your current Ashley on this phone will be replaced with whatever conversation, profile, and memories are saved on the server under the Device ID you pasted. The current Device ID will be forgotten — copy it first if you want it back.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Switch",
          style: "destructive",
          onPress: async () => {
            setRestoring(true);
            try {
              await setDeviceId(target);
              // Drop every cached query so /state, messages, memories,
              // summaries, profile all refetch under the new device id.
              qc.clear();
              setRestoreOpen(false);
              setRestoreInput("");
              Alert.alert(
                "Restored",
                "Reconnected to the conversation saved under that Device ID.",
              );
            } catch (err) {
              Alert.alert(
                "Couldn't restore",
                err instanceof Error
                  ? err.message
                  : "Something went wrong switching device id.",
              );
            } finally {
              setRestoring(false);
            }
          },
        },
      ],
    );
  };

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);

  const confirmAndApply = (payload: ExportPayload, onAfter?: () => void) => {
    Alert.alert(
      "Replace this Ashley with the backup?",
      `${describeImportPlan(payload)}\n\nThis will overwrite the profile, memories, messages, and summaries currently on this device. Cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Replace",
          style: "destructive",
          onPress: async () => {
            try {
              const summary = await applyImportedPayload(payload);
              qc.invalidateQueries({ queryKey: ["profile"] });
              qc.invalidateQueries({ queryKey: ["messages"] });
              qc.invalidateQueries({ queryKey: ["memories"] });
              qc.invalidateQueries({ queryKey: ["summaries"] });
              onAfter?.();
              Alert.alert(
                "Backup restored",
                `Imported ${formatImportSummary(summary)}. Open chat to see her.`,
              );
            } catch (err) {
              Alert.alert(
                "Import failed mid-write",
                err instanceof Error ? err.message : String(err),
              );
            }
          },
        },
      ],
    );
  };

  const onExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await triggerExport();
      if (result.ok) {
        const kb = (result.bytes / 1024).toFixed(1);
        Alert.alert(
          "Backup exported",
          Platform.OS === "web"
            ? `Downloaded ${result.filename} (${kb} KB). Save it somewhere you'll find later — Files app, Google Drive, email it to yourself.`
            : `Saved ${result.filename} (${kb} KB) and opened share sheet. Pick a destination — Files app, Drive, etc. Keep it somewhere you can find later.`,
        );
      } else {
        Alert.alert("Export failed", result.reason);
      }
    } finally {
      setExporting(false);
    }
  };

  const onImport = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const picked = await pickAndValidateImport();
      if (!picked.ok) {
        if (picked.cancelled) return;
        const missingPicker = /ExpoDocumentPicker|getDocumentAsync/i.test(
          picked.reason,
        );
        if (missingPicker) {
          Alert.alert(
            "File picker unavailable",
            "This APK was built before the file picker was added. Use Paste backup JSON instead — open the JSON file in any app, copy all the text, then paste it here.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Open paste", onPress: () => setPasteOpen(true) },
            ],
          );
          return;
        }
        Alert.alert("Import failed", picked.reason);
        return;
      }
      confirmAndApply(picked.payload);
    } finally {
      setImporting(false);
    }
  };

  const onPasteImport = async () => {
    if (pasteBusy) return;
    setPasteBusy(true);
    try {
      const result = parseAndValidateImportText(pasteText);
      if (!result.ok) {
        Alert.alert("Paste failed", result.reason);
        return;
      }
      confirmAndApply(result.payload, () => {
        setPasteText("");
        setPasteOpen(false);
      });
    } finally {
      setPasteBusy(false);
    }
  };

  const onPasteBackupFromClipboard = async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (!text) {
        Alert.alert("Clipboard empty", "Copy the backup JSON first, then try again.");
        return;
      }
      setPasteText(text);
    } catch (err) {
      Alert.alert(
        "Clipboard read failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  return (
    <View style={styles.settingsSection}>
      <Text style={styles.sectionTitle}>Device & backup</Text>

      <View style={styles.fieldGroup}>
        <Text style={styles.label}>Device ID</Text>
        <Text style={styles.hint}>
          Identifies your conversation on the server. Copy it somewhere safe
          — if this phone ever forgets it (Expo Go updates can wipe local
          storage), paste it into Restore below to get her back.
        </Text>
        <View style={styles.deviceIdRow}>
          <Text
            style={styles.deviceIdText}
            numberOfLines={1}
            ellipsizeMode="middle"
            selectable
          >
            {deviceId || "—"}
          </Text>
          <Pressable
            onPress={onCopy}
            disabled={!deviceId}
            style={[styles.copyBtn, !deviceId && { opacity: 0.4 }]}
            accessibilityLabel="Copy device id"
          >
            <Feather
              name={copied ? "check" : "copy"}
              size={14}
              color={colors.light.primaryForeground}
            />
            <Text style={styles.copyBtnText}>{copied ? "Copied" : "Copy"}</Text>
          </Pressable>
        </View>
      </View>

      <View style={styles.backupRow}>
        <Pressable
          onPress={onExport}
          disabled={exporting}
          style={[styles.backupBtn, exporting && { opacity: 0.5 }]}
        >
          {exporting ? (
            <ActivityIndicator size="small" color={colors.light.text} />
          ) : (
            <Feather name="download" size={14} color={colors.light.text} />
          )}
          <Text style={styles.backupBtnText}>
            {exporting ? "Exporting…" : "Export backup"}
          </Text>
        </Pressable>
        <Pressable
          onPress={onImport}
          disabled={importing}
          style={[styles.backupBtn, importing && { opacity: 0.5 }]}
        >
          {importing ? (
            <ActivityIndicator size="small" color={colors.light.text} />
          ) : (
            <Feather name="upload" size={14} color={colors.light.text} />
          )}
          <Text style={styles.backupBtnText}>
            {importing ? "Importing…" : "Import backup"}
          </Text>
        </Pressable>
      </View>
      <View style={styles.backupRow}>
        <Pressable
          onPress={() => setPasteOpen(true)}
          style={styles.backupBtn}
        >
          <Feather name="clipboard" size={14} color={colors.light.text} />
          <Text style={styles.backupBtnText}>Paste backup JSON</Text>
        </Pressable>
      </View>
      <Text style={[styles.hint, { marginTop: 6 }]}>
        Backup is a JSON file with this Ashley's profile, memories, messages,
        and summaries. Use it to move her between devices, browsers, or app
        installs. Nothing leaves the device unless you choose where to save the
        file. If the file picker shows "native module" errors on this APK,
        use Paste instead — works on any build.
      </Text>

      <View style={styles.backupRow}>
        <Pressable
          onPress={() => setRestoreOpen((v) => !v)}
          style={styles.backupBtn}
        >
          <Feather
            name={restoreOpen ? "x" : "link"}
            size={14}
            color={colors.light.text}
          />
          <Text style={styles.backupBtnText}>
            {restoreOpen ? "Cancel" : "Restore from Device ID (legacy)"}
          </Text>
        </Pressable>
      </View>

      {restoreOpen ? (
        <View style={styles.restoreBox}>
          <Text style={styles.hint}>
            Paste a Device ID you copied earlier. Your current conversation on
            this phone will be replaced with the one saved under that ID on the
            server.
          </Text>
          <TextInput
            value={restoreInput}
            onChangeText={setRestoreInput}
            placeholder="paste Device ID here"
            placeholderTextColor={colors.light.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.restoreInput}
          />
          <View style={styles.restoreBtnRow}>
            <Pressable
              onPress={onPasteFromClipboard}
              style={[styles.backupBtn, { flex: 1 }]}
            >
              <Feather name="clipboard" size={14} color={colors.light.text} />
              <Text style={styles.backupBtnText}>Paste</Text>
            </Pressable>
            <Pressable
              onPress={restoring ? undefined : doRestore}
              disabled={restoring || !restoreInput.trim()}
              style={[
                styles.copyBtn,
                {
                  flex: 1,
                  justifyContent: "center",
                  opacity: restoring || !restoreInput.trim() ? 0.5 : 1,
                },
              ]}
            >
              {restoring ? (
                <ActivityIndicator
                  size="small"
                  color={colors.light.primaryForeground}
                />
              ) : (
                <Feather
                  name="check"
                  size={14}
                  color={colors.light.primaryForeground}
                />
              )}
              <Text style={styles.copyBtnText}>
                {restoring ? "Switching…" : "Restore"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <Modal
        visible={pasteOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setPasteOpen(false)}
      >
        <View style={styles.pasteBackdrop}>
          <View style={styles.pasteCard}>
            <Text style={styles.pasteTitle}>Paste backup JSON</Text>
            <Text style={styles.hint}>
              Open the exported JSON file in any app (Files, Drive, Gmail), copy
              all the text, then paste it here. Long-press the box below and
              choose Paste, or tap "Paste from clipboard".
            </Text>
            <TextInput
              value={pasteText}
              onChangeText={setPasteText}
              placeholder='{"schema":"ashley-sidecar-export", ...}'
              placeholderTextColor={colors.light.mutedForeground}
              multiline
              autoCorrect={false}
              autoCapitalize="none"
              style={styles.pasteInput}
            />
            <Text style={styles.hint}>
              {pasteText.length > 0
                ? `${(pasteText.length / 1024).toFixed(1)} KB pasted`
                : "Nothing pasted yet"}
            </Text>
            <View style={styles.backupRow}>
              <Pressable
                onPress={onPasteBackupFromClipboard}
                style={styles.backupBtn}
              >
                <Feather name="clipboard" size={14} color={colors.light.text} />
                <Text style={styles.backupBtnText}>Paste from clipboard</Text>
              </Pressable>
              <Pressable
                onPress={() => setPasteText("")}
                style={styles.backupBtn}
              >
                <Feather name="x" size={14} color={colors.light.text} />
                <Text style={styles.backupBtnText}>Clear</Text>
              </Pressable>
            </View>
            <View style={[styles.backupRow, { marginTop: 12 }]}>
              <Pressable
                onPress={() => {
                  setPasteText("");
                  setPasteOpen(false);
                }}
                style={styles.backupBtn}
              >
                <Text style={styles.backupBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={onPasteImport}
                disabled={pasteBusy || pasteText.trim().length === 0}
                style={[
                  styles.backupBtn,
                  (pasteBusy || pasteText.trim().length === 0) && {
                    opacity: 0.4,
                  },
                ]}
              >
                {pasteBusy ? (
                  <ActivityIndicator size="small" color={colors.light.text} />
                ) : (
                  <Feather name="check" size={14} color={colors.light.text} />
                )}
                <Text style={styles.backupBtnText}>
                  {pasteBusy ? "Validating…" : "Import"}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
  },
  headerTitle: {
    flex: 1,
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 17,
    textAlign: "center",
  },
  iconBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  saveBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.light.primary,
    borderRadius: 999,
    minWidth: 64,
    alignItems: "center",
  },
  saveText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  scroll: { padding: 18, gap: 18 },
  intro: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 6,
  },
  fieldGroup: { gap: 6 },
  label: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  hint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  input: {
    backgroundColor: colors.light.muted,
    color: colors.light.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    marginTop: 4,
  },
  successText: {
    color: "#5fd97e",
    fontFamily: "Inter_500Medium",
    fontSize: 13,
    textAlign: "center",
    marginTop: 8,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 6,
  },
  toggleTrack: {
    width: 46,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#3a3a3a",
    padding: 3,
    justifyContent: "center",
  },
  toggleTrackOn: {
    backgroundColor: colors.light.primary,
  },
  toggleThumb: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#f5f5f5",
  },
  toggleThumbOn: {
    alignSelf: "flex-end",
  },
  toggleLabel: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  cadenceRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  cadenceChip: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: "#1f1f1f",
    alignItems: "center",
    justifyContent: "center",
  },
  cadenceChipSelected: {
    borderColor: colors.light.primary,
    backgroundColor: colors.light.primary,
  },
  cadenceChipLabel: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  cadenceChipLabelSelected: {
    color: "#0b0b0b",
    fontFamily: "Inter_700Bold",
  },
  cadenceDetail: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginTop: 8,
  },
  settingsSection: {
    marginTop: 24,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: colors.light.border,
    gap: 14,
  },
  sectionTitle: {
    color: colors.light.text,
    fontFamily: "Inter_700Bold",
    fontSize: 15,
    marginBottom: 2,
  },
  deviceIdRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.light.muted,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    gap: 10,
  },
  deviceIdText: {
    flex: 1,
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.light.primary,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  copyBtnText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  backupRow: {
    flexDirection: "row",
    gap: 10,
  },
  backupBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.light.muted,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
  },
  backupBtnText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  pasteBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    paddingHorizontal: 18,
  },
  pasteCard: {
    backgroundColor: colors.light.card,
    borderRadius: 16,
    padding: 18,
    gap: 8,
    maxHeight: "85%",
  },
  pasteTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 18,
  },
  pasteInput: {
    minHeight: 140,
    maxHeight: 260,
    borderWidth: 1,
    borderColor: colors.light.border,
    borderRadius: 10,
    padding: 10,
    color: colors.light.text,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 12,
    textAlignVertical: "top",
    backgroundColor: colors.light.background,
  },
  restoreBox: {
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    backgroundColor: colors.light.muted,
    gap: 10,
  },
  restoreInput: {
    backgroundColor: colors.light.background,
    color: colors.light.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
  },
  restoreBtnRow: {
    flexDirection: "row",
    gap: 10,
  },
  carryoverHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  carryoverNote: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    fontStyle: "italic",
  },
  carryoverSubmitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 999,
    marginTop: 8,
  },
  summaryBlock: {
    marginTop: 6,
    gap: 8,
  },
  summaryHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  summaryEditBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: colors.light.muted,
    borderRadius: 999,
  },
  summaryReadBox: {
    backgroundColor: colors.light.muted,
    borderRadius: 12,
    padding: 12,
  },
  summaryReadText: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  // ----- Adult mode section
  modeRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  modeChip: {
    flex: 1,
    backgroundColor: colors.light.muted,
    borderRadius: 12,
    padding: 12,
    gap: 4,
    borderWidth: 1,
    borderColor: "transparent",
  },
  modeChipActive: {
    borderColor: colors.light.primary,
    backgroundColor: colors.light.background,
  },
  modeChipLocked: {
    opacity: 0.6,
  },
  modeChipText: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  modeChipTextActive: {
    color: colors.light.primary,
  },
  modeChipHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    lineHeight: 15,
  },
  ageGateCta: {
    alignSelf: "flex-start",
    marginTop: 6,
  },
  intimacyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 8,
  },
  intimacyStep: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  intimacyTrack: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 4,
  },
  intimacyDot: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.light.muted,
  },
  intimacyDotOn: {
    backgroundColor: colors.light.primary,
  },
  intimacyDotLocked: {
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: colors.light.border,
    borderStyle: "dashed",
  },
  ageGateOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: 18,
    zIndex: 100,
  },
  ageGateCard: {
    backgroundColor: colors.light.background,
    borderRadius: 16,
    padding: 18,
    gap: 12,
    width: "100%",
    maxWidth: 420,
  },
  ageGateTitle: {
    color: colors.light.text,
    fontFamily: "Inter_700Bold",
    fontSize: 16,
  },
  ageGateBody: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  ageGateBtnRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 4,
  },
});
