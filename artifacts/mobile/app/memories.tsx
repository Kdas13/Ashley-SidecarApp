import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon as Feather } from "@/components/Icon";
import { router } from "expo-router";

import {
  useMemories,
  useCreateMemory,
  useUpdateMemory,
  useDeleteMemory,
} from "@/lib/useMemories";
import {
  useSummaries,
  useUpdateSummary,
  useDeleteSummary,
} from "@/lib/useSummaries";
import type { ConversationSummary, Memory, MemoryTag } from "@/lib/storage";
import colors from "@/constants/colors";

const TAGS: MemoryTag[] = [
  "general",
  "preference",
  "user_fact",
  "event",
  "relationship",
];

export default function MemoriesScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [content, setContent] = useState("");
  const [tag, setTag] = useState<MemoryTag>("general");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [editTag, setEditTag] = useState<MemoryTag>("general");
  const [editImportance, setEditImportance] = useState<number>(3);
  const [editingSummaryId, setEditingSummaryId] = useState<string | null>(null);
  const [editSummaryText, setEditSummaryText] = useState("");

  const memoriesQuery = useMemories();
  const create = useCreateMemory();
  const update = useUpdateMemory();
  const remove = useDeleteMemory();

  const summariesQuery = useSummaries();
  const updateSummary = useUpdateSummary();
  const deleteSummary = useDeleteSummary();

  const orderedSummaries = React.useMemo<ConversationSummary[]>(() => {
    const list = summariesQuery.data ?? [];
    return list
      .slice()
      .sort(
        (a, b) =>
          Date.parse(a.coveredThroughCreatedAt) -
          Date.parse(b.coveredThroughCreatedAt),
      );
  }, [summariesQuery.data]);

  const startEditSummary = (s: ConversationSummary) => {
    setEditingSummaryId(s.id);
    setEditSummaryText(s.summary);
  };

  const cancelEditSummary = () => {
    setEditingSummaryId(null);
  };

  const saveEditSummary = () => {
    if (editingSummaryId === null) return;
    const s = editSummaryText.trim();
    if (!s) return;
    updateSummary.mutate(
      { id: editingSummaryId, summary: s },
      { onSuccess: () => setEditingSummaryId(null) },
    );
  };

  const confirmDeleteSummary = (s: ConversationSummary) => {
    Alert.alert(
      "Forget this chapter?",
      "This summary covers a stretch of older messages — Ashley will stop referencing it.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => deleteSummary.mutate(s.id),
        },
      ],
    );
  };

  const submit = () => {
    const c = content.trim();
    if (!c) return;
    create.mutate(
      { content: c, tag, importance: 4 },
      {
        onSuccess: () => setContent(""),
      },
    );
  };

  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditContent(m.content);
    setEditTag(m.tag);
    setEditImportance(m.importance);
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = () => {
    if (editingId === null) return;
    const c = editContent.trim();
    if (!c) return;
    update.mutate(
      {
        id: editingId,
        content: c,
        tag: editTag,
        importance: editImportance,
      },
      {
        onSuccess: () => setEditingId(null),
      },
    );
  };

  const confirmDelete = (m: Memory) => {
    Alert.alert(
      "Forget this?",
      `"${m.content}" will be removed.`,
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => remove.mutate(m.id),
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={{ flex: 1, backgroundColor: colors.light.background }}
    >
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            style={styles.iconBtn}
            accessibilityLabel="Back"
          >
            <Feather name="chevron-left" size={22} color={colors.light.text} />
          </Pressable>
          <Text style={styles.headerTitle}>What she remembers</Text>
          <View style={styles.iconBtn} />
        </View>

        {memoriesQuery.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        ) : (
          <FlatList
            data={memoriesQuery.data ?? []}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListHeaderComponent={
              <SummariesSection
                summaries={orderedSummaries}
                editingId={editingSummaryId}
                editText={editSummaryText}
                setEditText={setEditSummaryText}
                onStartEdit={startEditSummary}
                onCancelEdit={cancelEditSummary}
                onSaveEdit={saveEditSummary}
                onDelete={confirmDeleteSummary}
                isSaving={updateSummary.isPending}
              />
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No memories yet</Text>
                <Text style={styles.emptyText}>
                  Add anything you want her to remember about you, your life,
                  or the two of you.
                </Text>
              </View>
            }
            renderItem={({ item }) => {
              const isEditing = editingId === item.id;
              if (isEditing) {
                return (
                  <View style={[styles.card, styles.cardEditing]}>
                    <TextInput
                      value={editContent}
                      onChangeText={setEditContent}
                      style={styles.editInput}
                      multiline
                      autoFocus
                      maxLength={500}
                      placeholderTextColor={colors.light.mutedForeground}
                    />
                    <View style={styles.editControls}>
                      <View style={styles.tagPicker}>
                        {TAGS.map((t) => (
                          <Pressable
                            key={t}
                            onPress={() => setEditTag(t)}
                            style={[
                              styles.tagChip,
                              editTag === t && styles.tagChipActive,
                            ]}
                          >
                            <Text
                              style={[
                                styles.tagChipText,
                                editTag === t && styles.tagChipTextActive,
                              ]}
                            >
                              {t.replace("_", " ")}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                      <View style={styles.importanceRow}>
                        <Text style={styles.importanceLabel}>importance</Text>
                        <View style={styles.starsRow}>
                          {[1, 2, 3, 4, 5].map((n) => (
                            <Pressable
                              key={n}
                              onPress={() => setEditImportance(n)}
                              style={styles.starBtn}
                              accessibilityLabel={`Set importance ${n}`}
                            >
                              <Feather
                                name="star"
                                size={18}
                                color={
                                  n <= editImportance
                                    ? colors.light.primary
                                    : colors.light.mutedForeground
                                }
                              />
                            </Pressable>
                          ))}
                        </View>
                      </View>
                    </View>
                    <View style={styles.editActions}>
                      <Pressable
                        onPress={cancelEdit}
                        style={[styles.editBtn, styles.cancelBtn]}
                        disabled={update.isPending}
                      >
                        <Text style={styles.cancelText}>cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={saveEdit}
                        style={[styles.editBtn, styles.saveBtn]}
                        disabled={update.isPending || !editContent.trim()}
                      >
                        {update.isPending ? (
                          <ActivityIndicator
                            size="small"
                            color={colors.light.primaryForeground}
                          />
                        ) : (
                          <Text style={styles.saveText}>save</Text>
                        )}
                      </Pressable>
                    </View>
                  </View>
                );
              }
              return (
                <Pressable
                  onPress={() => startEdit(item)}
                  style={({ pressed }) => [
                    styles.card,
                    pressed && { opacity: 0.85 },
                  ]}
                  accessibilityLabel={`Edit memory: ${item.content}`}
                >
                  <View style={{ flex: 1 }}>
                    <View style={styles.tagRow}>
                      <View style={styles.tagBadge}>
                        <Text style={styles.tagText}>{item.tag.replace("_", " ")}</Text>
                      </View>
                      <View style={styles.starsRow}>
                        {[1, 2, 3, 4, 5].map((n) => (
                          <Feather
                            key={n}
                            name="star"
                            size={11}
                            color={
                              n <= item.importance
                                ? colors.light.primary
                                : "rgba(245, 232, 216, 0.2)"
                            }
                          />
                        ))}
                      </View>
                      <View style={{ flex: 1 }} />
                      <Feather
                        name="edit-2"
                        size={13}
                        color={colors.light.mutedForeground}
                      />
                    </View>
                    <Text style={styles.cardText}>{item.content}</Text>
                  </View>
                  <Pressable
                    onPress={() => confirmDelete(item)}
                    style={styles.deleteBtn}
                    accessibilityLabel="Forget memory"
                    hitSlop={8}
                  >
                    <Feather
                      name="x"
                      size={16}
                      color={colors.light.mutedForeground}
                    />
                  </Pressable>
                </Pressable>
              );
            }}
          />
        )}

        <View style={[styles.inputCard, { paddingBottom: insets.bottom + 12 }]}>
          <Text style={styles.inputLabel}>Add a memory</Text>
          <TextInput
            value={content}
            onChangeText={setContent}
            placeholder="e.g. my favorite coffee is oat-milk latte"
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.input}
            multiline
            maxLength={500}
          />
          <View style={styles.row}>
            <View style={styles.tagPicker}>
              {TAGS.map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTag(t)}
                  style={[styles.tagChip, tag === t && styles.tagChipActive]}
                >
                  <Text
                    style={[
                      styles.tagChipText,
                      tag === t && styles.tagChipTextActive,
                    ]}
                  >
                    {t.replace("_", " ")}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <Pressable
            onPress={submit}
            disabled={!content.trim() || create.isPending}
            style={({ pressed }) => [
              styles.addBtn,
              (!content.trim() || create.isPending) && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.98 }] },
            ]}
          >
            <Feather
              name="plus"
              size={18}
              color={colors.light.primaryForeground}
            />
            <Text style={styles.addBtnText}>Remember this</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

type SummariesSectionProps = {
  summaries: ConversationSummary[];
  editingId: string | null;
  editText: string;
  setEditText: (s: string) => void;
  onStartEdit: (s: ConversationSummary) => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: (s: ConversationSummary) => void;
  isSaving: boolean;
};

function SummariesSection({
  summaries,
  editingId,
  editText,
  setEditText,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  isSaving,
}: SummariesSectionProps): React.JSX.Element | null {
  if (summaries.length === 0) return null;
  return (
    <View style={styles.summarySection}>
      <Text style={styles.summarySectionTitle}>The story so far</Text>
      <Text style={styles.summarySectionSubtitle}>
        Older chapters of your conversation, distilled so Ashley keeps the
        thread.
      </Text>
      {summaries.map((s) => {
        const isEditing = editingId === s.id;
        const covered = new Date(s.coveredThroughCreatedAt);
        const dateLabel = isNaN(covered.getTime())
          ? ""
          : covered.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "numeric",
            });
        if (isEditing) {
          return (
            <View key={s.id} style={[styles.summaryCard, styles.summaryEditing]}>
              <Text style={styles.summaryMeta}>
                {`${s.messageCount} messages${dateLabel ? ` · through ${dateLabel}` : ""}`}
              </Text>
              <TextInput
                value={editText}
                onChangeText={setEditText}
                style={styles.editInput}
                multiline
                maxLength={2000}
                accessibilityLabel="Edit summary text"
              />
              <View style={styles.editActions}>
                <Pressable
                  onPress={onCancelEdit}
                  style={[styles.editBtn, styles.cancelBtn]}
                  accessibilityLabel="Cancel summary edit"
                >
                  <Text style={styles.cancelText}>cancel</Text>
                </Pressable>
                <Pressable
                  onPress={onSaveEdit}
                  disabled={isSaving || !editText.trim()}
                  style={[
                    styles.editBtn,
                    styles.saveBtn,
                    (isSaving || !editText.trim()) && { opacity: 0.5 },
                  ]}
                  accessibilityLabel="Save summary edit"
                >
                  {isSaving ? (
                    <ActivityIndicator
                      size="small"
                      color={colors.light.primaryForeground}
                    />
                  ) : (
                    <Text style={styles.saveText}>save</Text>
                  )}
                </Pressable>
              </View>
            </View>
          );
        }
        return (
          <Pressable
            key={s.id}
            onPress={() => onStartEdit(s)}
            style={({ pressed }) => [
              styles.summaryCard,
              pressed && { opacity: 0.85 },
            ]}
            accessibilityLabel="Edit summary"
          >
            <View style={{ flex: 1 }}>
              <View style={styles.summaryMetaRow}>
                <Text style={styles.summaryMeta}>
                  {`${s.messageCount} messages${dateLabel ? ` · through ${dateLabel}` : ""}`}
                </Text>
                <Feather
                  name="edit-2"
                  size={13}
                  color={colors.light.mutedForeground}
                />
              </View>
              <Text style={styles.summaryText}>{s.summary}</Text>
            </View>
            <Pressable
              onPress={() => onDelete(s)}
              style={styles.deleteBtn}
              accessibilityLabel="Forget summary"
              hitSlop={8}
            >
              <Feather
                name="x"
                size={16}
                color={colors.light.mutedForeground}
              />
            </Pressable>
          </Pressable>
        );
      })}
      <View style={styles.summaryDivider} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  summarySection: { marginBottom: 12 },
  summarySectionTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 4,
  },
  summarySectionSubtitle: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 16,
    marginBottom: 10,
  },
  summaryCard: {
    flexDirection: "row",
    backgroundColor: colors.light.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    alignItems: "flex-start",
    gap: 10,
  },
  summaryEditing: {
    flexDirection: "column",
    borderColor: colors.light.primary,
    gap: 12,
  },
  summaryMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  summaryMeta: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  summaryText: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
  },
  summaryDivider: {
    height: 1,
    backgroundColor: colors.light.border,
    marginTop: 4,
    marginBottom: 14,
    opacity: 0.6,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
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
  list: { padding: 14, paddingBottom: 24, flexGrow: 1 },
  empty: { padding: 32, alignItems: "center" },
  emptyTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 16,
    marginBottom: 8,
  },
  emptyText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  card: {
    flexDirection: "row",
    backgroundColor: colors.light.card,
    borderRadius: 16,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.light.border,
    alignItems: "flex-start",
    gap: 10,
  },
  cardEditing: {
    flexDirection: "column",
    borderColor: colors.light.primary,
    gap: 12,
  },
  cardText: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  tagRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  tagBadge: {
    backgroundColor: colors.light.secondary,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  tagText: {
    color: colors.light.accent,
    fontFamily: "Inter_500Medium",
    fontSize: 11,
  },
  deleteBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.muted,
  },
  editInput: {
    backgroundColor: colors.light.muted,
    color: colors.light.text,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    minHeight: 64,
  },
  editControls: { gap: 10 },
  importanceRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  importanceLabel: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  starsRow: { flexDirection: "row", gap: 2 },
  starBtn: { padding: 4 },
  editActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  editBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelBtn: { backgroundColor: colors.light.muted },
  cancelText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  saveBtn: { backgroundColor: colors.light.primary },
  saveText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  inputCard: {
    padding: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: colors.light.border,
    gap: 10,
    backgroundColor: colors.light.background,
  },
  inputLabel: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    backgroundColor: colors.light.muted,
    color: colors.light.text,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    minHeight: 56,
  },
  row: { flexDirection: "row" },
  tagPicker: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  tagChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.light.muted,
  },
  tagChipActive: {
    backgroundColor: colors.light.accent,
  },
  tagChipText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  tagChipTextActive: { color: "#fff" },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    paddingVertical: 14,
    borderRadius: 999,
  },
  addBtnText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 15,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
});
