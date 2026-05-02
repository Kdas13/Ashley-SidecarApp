import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";

import {
  useMessages,
  useSendMessage,
  useClearMessages,
} from "@/lib/useMessages";
import type { Message } from "@/lib/storage";
import colors from "@/constants/colors";

export default function ChatScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList<Message>>(null);

  const messagesQuery = useMessages();
  const sendMutation = useSendMessage();
  const clearMutation = useClearMessages();

  const messages = useMemo<Message[]>(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );

  const sendError =
    sendMutation.error instanceof Error ? sendMutation.error.message : null;

  useEffect(() => {
    if (messages.length === 0 && !sendMutation.isPending) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, sendMutation.isPending]);

  const send = useCallback(() => {
    const content = draft.trim();
    if (!content || sendMutation.isPending) return;
    setDraft("");
    sendMutation.reset();
    sendMutation.mutate(content);
  }, [draft, sendMutation]);

  const confirmClear = useCallback(() => {
    if (clearMutation.isPending) return;
    Alert.alert(
      "Clear conversation?",
      "All messages on this device will be removed.",
      [
        { text: "Keep", style: "cancel" },
        {
          text: "Clear",
          style: "destructive",
          onPress: () => clearMutation.mutate(),
        },
      ],
    );
  }, [clearMutation]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => <MessageBubble message={item} />,
    [],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.iconBtn}
          accessibilityLabel="Back"
        >
          <Feather name="chevron-left" size={22} color={colors.light.text} />
        </Pressable>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Ashley</Text>
          <Text style={styles.headerSubtitle}>here with you</Text>
        </View>
        <Pressable
          onPress={confirmClear}
          style={styles.iconBtn}
          accessibilityLabel="Clear conversation"
        >
          <Feather name="trash-2" size={18} color={colors.light.mutedForeground} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}
        style={{ flex: 1 }}
      >
        {messagesQuery.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.light.primary} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            renderItem={renderItem}
            keyExtractor={(m) => m.id}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyText}>say something to her</Text>
                <Text style={styles.emptyHint}>
                  this is your space — messages stay on this device
                </Text>
              </View>
            }
            ListFooterComponent={
              sendMutation.isPending ? (
                <View style={[styles.row, styles.rowLeft]}>
                  <View style={[styles.bubble, styles.bubbleAshley, styles.typingBubble]}>
                    <ActivityIndicator
                      size="small"
                      color={colors.light.mutedForeground}
                    />
                    <Text style={styles.typingText}>Ashley is typing…</Text>
                  </View>
                </View>
              ) : null
            }
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
          />
        )}

        {sendError ? (
          <Pressable
            onPress={() => sendMutation.reset()}
            style={styles.errorBanner}
            accessibilityLabel="Dismiss error"
          >
            <Feather
              name="alert-circle"
              size={12}
              color={colors.light.destructiveForeground}
            />
            <Text style={styles.errorText} numberOfLines={2}>
              couldn't reach Ashley — tap to dismiss
            </Text>
          </Pressable>
        ) : null}

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="message her..."
            placeholderTextColor={colors.light.mutedForeground}
            style={styles.input}
            multiline
            maxLength={4000}
            editable={!sendMutation.isPending}
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <Pressable
            onPress={send}
            disabled={!draft.trim() || sendMutation.isPending}
            style={({ pressed }) => [
              styles.sendBtn,
              (!draft.trim() || sendMutation.isPending) && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
            accessibilityLabel="Send message"
          >
            <Feather name="send" size={18} color={colors.light.primaryForeground} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function MessageBubble({ message }: { message: Message }): React.JSX.Element {
  const isUser = message.role === "user";
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAshley,
        ]}
      >
        <Text
          style={[
            styles.bubbleText,
            isUser ? styles.bubbleUserText : styles.bubbleAshleyText,
          ]}
        >
          {message.content}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.light.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
  },
  headerCenter: { flex: 1, alignItems: "center" },
  headerTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 17,
  },
  headerSubtitle: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  list: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    flexGrow: 1,
  },
  row: {
    flexDirection: "row",
    marginVertical: 4,
  },
  rowLeft: { justifyContent: "flex-start" },
  rowRight: { justifyContent: "flex-end" },
  bubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 18,
  },
  bubbleUser: {
    backgroundColor: colors.light.bubbleUser,
    borderBottomRightRadius: 6,
  },
  bubbleAshley: {
    backgroundColor: colors.light.bubbleAshley,
    borderBottomLeftRadius: 6,
  },
  bubbleText: {
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    lineHeight: 21,
  },
  bubbleUserText: { color: colors.light.bubbleUserText },
  bubbleAshleyText: { color: colors.light.bubbleAshleyText },
  emptyWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 16,
    textAlign: "center",
  },
  emptyHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    textAlign: "center",
  },
  typingBubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  typingText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    fontStyle: "italic",
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: colors.light.destructive,
  },
  errorText: {
    color: colors.light.destructiveForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.light.border,
    backgroundColor: colors.light.background,
  },
  input: {
    flex: 1,
    color: colors.light.text,
    backgroundColor: colors.light.muted,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 15,
    maxHeight: 140,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.light.primary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
