import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";

import {
  useListMessages,
  useSendMessage,
  useGenerateSelfie,
  useClearMessages,
  getListMessagesQueryKey,
  type Message,
} from "@workspace/api-client-react";
import colors from "@/constants/colors";
import { resolveImageUrl } from "@/lib/api";

export default function ChatScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const listRef = useRef<FlatList<Message>>(null);

  const messagesQuery = useListMessages({});

  const sendMutation = useSendMessage({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
        // a memory may have been distilled — refresh later
        setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ["/api/memories"] });
        }, 4000);
      },
    },
  });

  const selfieMutation = useGenerateSelfie({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
      },
    },
  });

  const clearMutation = useClearMessages({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey() });
      },
    },
  });

  const messages = useMemo<Message[]>(() => messagesQuery.data ?? [], [messagesQuery.data]);

  useEffect(() => {
    if (messages.length === 0) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd({ animated: true });
    });
  }, [messages.length, sendMutation.isPending]);

  const send = useCallback(() => {
    const content = draft.trim();
    if (!content || sendMutation.isPending) return;
    setDraft("");
    sendMutation.mutate({ data: { content } });
  }, [draft, sendMutation]);

  const askForSelfie = useCallback(() => {
    const prompt = draft.trim() || "a sweet selfie of you in your cozy sweater";
    setDraft("");
    selfieMutation.mutate({ data: { prompt } });
  }, [draft, selfieMutation]);

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
          <Text style={styles.headerSubtitle}>online</Text>
        </View>
        <Pressable
          onPress={() => {
            if (clearMutation.isPending) return;
            clearMutation.mutate();
          }}
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
            keyExtractor={(m) => String(m.id)}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.emptyWrap}>
                <Text style={styles.emptyText}>
                  start your first conversation with Ashley
                </Text>
                <Text style={styles.emptyHint}>
                  she remembers everything you tell her 💛
                </Text>
              </View>
            }
            ListFooterComponent={
              sendMutation.isPending || selfieMutation.isPending ? (
                <View style={styles.typing}>
                  <Text style={styles.typingDot}>•••</Text>
                  <Text style={styles.typingHint}>
                    {selfieMutation.isPending ? "taking a selfie..." : "typing..."}
                  </Text>
                </View>
              ) : null
            }
            onContentSizeChange={() =>
              listRef.current?.scrollToEnd({ animated: false })
            }
          />
        )}

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          <Pressable
            onPress={askForSelfie}
            style={styles.attachBtn}
            disabled={selfieMutation.isPending}
            accessibilityLabel="Ask for a selfie"
          >
            <Feather name="camera" size={20} color={colors.light.text} />
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="message ashley..."
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
  const imgUrl = resolveImageUrl(message.imageUrl);
  return (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAshley,
        ]}
      >
        {imgUrl ? (
          <Image
            source={{ uri: imgUrl }}
            style={styles.bubbleImage}
            contentFit="cover"
            transition={200}
          />
        ) : null}
        {message.content ? (
          <Text
            style={[
              styles.bubbleText,
              isUser ? styles.bubbleUserText : styles.bubbleAshleyText,
              imgUrl ? { marginTop: 8 } : null,
            ]}
          >
            {message.content}
          </Text>
        ) : null}
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
    color: "#5fd97e",
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
  bubbleImage: {
    width: 240,
    height: 320,
    borderRadius: 12,
    backgroundColor: "rgba(245, 232, 216, 0.05)",
  },
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
  typing: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  typingDot: {
    color: colors.light.primary,
    fontSize: 24,
    lineHeight: 22,
  },
  typingHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
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
  attachBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
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
