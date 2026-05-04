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

import { useProfile, useUpdateProfile } from "@/lib/useProfile";
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

        <DeviceAndBackupSection />
      </ScrollView>
    </KeyboardAvoidingView>
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
});
