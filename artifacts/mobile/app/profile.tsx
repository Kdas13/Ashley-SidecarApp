import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import * as Clipboard from "expo-clipboard";

import { useQueryClient } from "@tanstack/react-query";

import {
  useProfile,
  useReplikaCarryover,
  useUpdateProfile,
} from "@/lib/useProfile";
import type { ReplikaCarryoverInput } from "@/lib/aiClient";
import type { AshleyProfile } from "@/lib/storage";
import { getDeviceIdSync, hasDeviceId, setDeviceId } from "@/lib/deviceId";
import colors from "@/constants/colors";

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
    await update.mutateAsync(payload);
    setShowSaved(true);
    setTimeout(() => setShowSaved(false), 1800);
  };

  const builderAwareOn = draft.builderAwareMode !== false;
  const toggleBuilderAware = () => {
    setDraft((prev) => ({ ...prev, builderAwareMode: !builderAwareOn }));
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

        {showSaved ? (
          <Text style={styles.successText}>Saved</Text>
        ) : null}

        <CarryoverSection
          existingCarryover={profileQuery.data.replikaCarryover}
          existingSummary={profileQuery.data.replikaCarryoverSummary}
        />

        <DeviceAndBackupSection />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

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

  const showExportPlaceholder = () => {
    Alert.alert(
      "Export backup (coming soon)",
      "A one-tap export is on the way. For now, copy your Device ID — that's the only thing you need to recover this Ashley on another phone (or after Expo Go clears its storage). Use Restore below to paste it back in.",
    );
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
        <Pressable onPress={showExportPlaceholder} style={styles.backupBtn}>
          <Feather name="download" size={14} color={colors.light.text} />
          <Text style={styles.backupBtnText}>Export backup</Text>
          <Text style={styles.comingSoonPill}>Soon</Text>
        </Pressable>
        <Pressable
          onPress={() => setRestoreOpen((v) => !v)}
          style={styles.backupBtn}
        >
          <Feather
            name={restoreOpen ? "x" : "upload"}
            size={14}
            color={colors.light.text}
          />
          <Text style={styles.backupBtnText}>
            {restoreOpen ? "Cancel" : "Restore from Device ID"}
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
  comingSoonPill: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 10,
    backgroundColor: colors.light.background,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: "hidden",
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
});
