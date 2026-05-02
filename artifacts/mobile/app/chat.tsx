import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
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
  useRetrySelfie,
} from "@/lib/useMessages";
import type { Message, ReplyToRef } from "@/lib/storage";
import colors from "@/constants/colors";
import { SwipeToReply } from "@/components/SwipeToReply";
// Gesture-aware Pressable from react-native-gesture-handler. We need this
// (instead of RN's built-in Pressable) for buttons that live INSIDE the
// SwipeToReply swipeable — RN's responder system loses to gesture-handler's
// native pan, so taps on a regular <Pressable> inside the bubble never
// reach onPress. The gesture-handler version cooperates with parent
// gesture handlers and fires reliably.
import { Pressable as GHPressable } from "react-native-gesture-handler";

// Maximum length of the quote preview we capture from a swiped message.
// Keeps storage and the on-screen quote header from getting unwieldy.
const REPLY_PREVIEW_MAX = 140;

function buildReplyPreview(message: Message): ReplyToRef {
  const raw = (message.content ?? "").trim();
  // If the swiped message is a photo with no caption, surface a friendly
  // placeholder so the quote bar isn't blank.
  const text = raw.length > 0 ? raw : message.imageUrl ? "Photo" : "Message";
  const collapsed = text.replace(/\s+/g, " ");
  const preview =
    collapsed.length > REPLY_PREVIEW_MAX
      ? `${collapsed.slice(0, REPLY_PREVIEW_MAX - 1).trimEnd()}…`
      : collapsed;
  return { id: message.id, role: message.role, preview };
}

export default function ChatScreen(): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState("");
  // When the user swipes a bubble, we stash a quote reference here. The
  // input bar grows to show the preview + an X to dismiss; sending the
  // next message attaches the quote and clears this state.
  const [replyingTo, setReplyingTo] = useState<ReplyToRef | null>(null);
  const inputRef = useRef<TextInput>(null);
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

  // Triggered when SwipeToReply commits inside a bubble. Captures a quote
  // preview, focuses the input so the keyboard stays up, and replaces any
  // previous in-progress quote.
  const handleStartReply = useCallback((message: Message) => {
    setReplyingTo(buildReplyPreview(message));
    // Slight delay so the keyboard doesn't fight the gesture's spring.
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const cancelReply = useCallback(() => {
    setReplyingTo(null);
  }, []);

  const send = useCallback(() => {
    const content = draft.trim();
    if (!content || sendMutation.isPending) return;
    const replyToSnapshot = replyingTo;
    setDraft("");
    setReplyingTo(null);
    sendMutation.reset();
    sendMutation.mutate({ content, replyTo: replyToSnapshot });
  }, [draft, sendMutation, replyingTo]);

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
    ({ item }: { item: Message }) => (
      <MessageBubble message={item} onSwipeReply={handleStartReply} />
    ),
    [handleStartReply],
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

        {replyingTo ? (
          <View style={styles.replyPreview}>
            <View style={styles.replyAccent} />
            <View style={styles.replyTextWrap}>
              <Text style={styles.replyAuthor}>
                Replying to {replyingTo.role === "ashley" ? "Ashley" : "you"}
              </Text>
              <Text style={styles.replyBody} numberOfLines={2}>
                {replyingTo.preview}
              </Text>
            </View>
            <Pressable
              onPress={cancelReply}
              style={styles.replyDismissBtn}
              accessibilityLabel="Cancel reply"
              hitSlop={8}
            >
              <Feather name="x" size={16} color={colors.light.mutedForeground} />
            </Pressable>
          </View>
        ) : null}

        <View style={[styles.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          <TextInput
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            placeholder={
              replyingTo ? "reply to her..." : "message her..."
            }
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

function MessageBubble({
  message,
  onSwipeReply,
}: {
  message: Message;
  onSwipeReply: (m: Message) => void;
}): React.JSX.Element {
  const isUser = message.role === "user";
  const hasImage = !!message.imageUrl;
  const hasText = !!message.content && message.content.trim().length > 0;
  const [imageFailed, setImageFailed] = useState(false);
  const showImage = hasImage && !imageFailed;

  // selfieVibe is set by the server when Ashley wanted to send a photo.
  // While the background generation is still running (or after it failed),
  // imageUrl is null and selfieVibe is the prompt. We use this to drive
  // either a "taking a selfie…" pending state or a retry button.
  const pendingSelfieVibe =
    !hasImage && message.selfieVibe ? message.selfieVibe : null;
  const { retry } = useRetrySelfie();
  // Track retry state locally with React state so the spinner / error
  // message actually trigger re-renders. (The hook's underlying dedup Set
  // isn't reactive — that was the old bug where tapping looked dead.)
  const [retryingThis, setRetryingThis] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const onRetrySelfie = useCallback(() => {
    if (!pendingSelfieVibe || retryingThis) return;
    setRetryingThis(true);
    setRetryError(null);
    retry(message.id, pendingSelfieVibe)
      .catch((err: unknown) => {
        setRetryError(
          err instanceof Error && err.message
            ? err.message
            : "still couldn't reach her — tap again",
        );
      })
      .finally(() => {
        setRetryingThis(false);
      });
  }, [retry, message.id, pendingSelfieVibe, retryingThis]);

  // User bubbles sit on the right and reveal the reply hint by being
  // dragged left; Ashley bubbles do the opposite. Mirrors iMessage.
  const swipeDirection: "left" | "right" = isUser ? "left" : "right";
  const handleSwipe = useCallback(() => {
    onSwipeReply(message);
  }, [onSwipeReply, message]);

  const quoted = message.replyTo;

  const bubbleContent = (
    <View style={[styles.row, isUser ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          isUser ? styles.bubbleUser : styles.bubbleAshley,
          (showImage || pendingSelfieVibe) && styles.bubbleWithImage,
        ]}
      >
        {quoted ? (
          <View
            style={[
              styles.quotedHeader,
              isUser ? styles.quotedHeaderUser : styles.quotedHeaderAshley,
            ]}
          >
            <View
              style={[
                styles.quotedAccent,
                isUser
                  ? styles.quotedAccentUser
                  : styles.quotedAccentAshley,
              ]}
            />
            <View style={styles.quotedTextWrap}>
              <Text
                style={[
                  styles.quotedAuthor,
                  isUser
                    ? styles.quotedAuthorUser
                    : styles.quotedAuthorAshley,
                ]}
              >
                {quoted.role === "ashley" ? "Ashley" : "You"}
              </Text>
              <Text
                style={[
                  styles.quotedBody,
                  isUser ? styles.quotedBodyUser : styles.quotedBodyAshley,
                ]}
                numberOfLines={2}
              >
                {quoted.preview}
              </Text>
            </View>
          </View>
        ) : null}
        {showImage ? (
          <Image
            source={{ uri: message.imageUrl! }}
            style={styles.bubbleImage}
            resizeMode="cover"
            accessibilityLabel="Selfie from Ashley"
            onError={(e) => {
              console.warn(
                "[chat] selfie image failed to load",
                message.imageUrl,
                e?.nativeEvent,
              );
              setImageFailed(true);
            }}
          />
        ) : null}
        {imageFailed ? (
          <View style={styles.imageError}>
            <Feather
              name="image"
              size={18}
              color={colors.light.mutedForeground}
            />
            <Text style={styles.imageErrorText}>
              couldn't load her photo — tap to retry?
            </Text>
            <Pressable
              onPress={() => setImageFailed(false)}
              style={styles.imageRetryBtn}
              accessibilityLabel="Retry loading photo"
            >
              <Feather
                name="refresh-cw"
                size={14}
                color={colors.light.text}
              />
            </Pressable>
          </View>
        ) : null}
        {pendingSelfieVibe && !showImage && !imageFailed ? (
          <GHPressable
            onPress={retryingThis ? undefined : onRetrySelfie}
            style={styles.selfiePending}
            accessibilityLabel={
              retryingThis
                ? "Taking a selfie"
                : "Tap to retry sending photo"
            }
          >
            {retryingThis ? (
              <ActivityIndicator
                size="small"
                color={colors.light.mutedForeground}
              />
            ) : (
              <Feather
                name="camera"
                size={18}
                color={colors.light.mutedForeground}
              />
            )}
            <Text style={styles.selfiePendingText} numberOfLines={2}>
              {retryingThis
                ? "taking a selfie…"
                : retryError
                  ? retryError
                  : "couldn't send the photo — tap to retry"}
            </Text>
          </GHPressable>
        ) : null}
        {hasText ? (
          <Text
            style={[
              styles.bubbleText,
              isUser ? styles.bubbleUserText : styles.bubbleAshleyText,
              (showImage || pendingSelfieVibe) && styles.bubbleTextWithImage,
            ]}
          >
            {message.content}
          </Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SwipeToReply direction={swipeDirection} onTrigger={handleSwipe}>
      {bubbleContent}
    </SwipeToReply>
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
  bubbleWithImage: {
    paddingHorizontal: 4,
    paddingTop: 4,
    paddingBottom: 6,
    overflow: "hidden",
  },
  bubbleImage: {
    width: 240,
    height: 320,
    borderRadius: 14,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
  bubbleTextWithImage: {
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 2,
  },
  imageError: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  imageErrorText: {
    flex: 1,
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    fontStyle: "italic",
  },
  imageRetryBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.light.muted,
  },
  selfiePending: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    width: 240,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  selfiePendingText: {
    flex: 1,
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    fontStyle: "italic",
  },
  replyPreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(122, 92, 255, 0.12)",
    borderTopWidth: 1,
    borderTopColor: colors.light.border,
  },
  replyAccent: {
    width: 3,
    alignSelf: "stretch",
    borderRadius: 2,
    backgroundColor: colors.light.accent,
  },
  replyTextWrap: { flex: 1, gap: 2 },
  replyAuthor: {
    color: colors.light.accent,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  replyBody: {
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    opacity: 0.85,
  },
  replyDismissBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  quotedHeader: {
    flexDirection: "row",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 10,
    marginBottom: 6,
  },
  quotedHeaderUser: {
    backgroundColor: "rgba(0,0,0,0.18)",
  },
  quotedHeaderAshley: {
    backgroundColor: "rgba(122, 92, 255, 0.18)",
  },
  quotedAccent: {
    width: 2,
    alignSelf: "stretch",
    borderRadius: 1,
  },
  quotedAccentUser: { backgroundColor: "rgba(26,19,37,0.6)" },
  quotedAccentAshley: { backgroundColor: colors.light.accent },
  quotedTextWrap: { flex: 1, gap: 2 },
  quotedAuthor: {
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
  },
  quotedAuthorUser: { color: "rgba(26,19,37,0.85)" },
  quotedAuthorAshley: { color: colors.light.accent },
  quotedBody: {
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  quotedBodyUser: { color: "rgba(26,19,37,0.75)" },
  quotedBodyAshley: { color: "rgba(245,232,216,0.85)" },
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
