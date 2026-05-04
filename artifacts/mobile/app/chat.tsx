import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
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
import * as Clipboard from "expo-clipboard";
import * as FileSystem from "expo-file-system/legacy";
import * as MediaLibrary from "expo-media-library";
import * as ImagePicker from "expo-image-picker";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  useMessages,
  useSendMessage,
  useSendImage,
  useMarkImageRemembered,
  useClearMessages,
  useRetrySelfie,
  useRetryUnansweredReply,
  useSelfieInFlight,
} from "@/lib/useMessages";
import { useProfile, useUpdateProfile } from "@/lib/useProfile";
import { useVoiceRecorder, VOICE_MAX_DURATION_MS } from "@/lib/voiceInput";
import { useTranscribeAudioStream } from "@/lib/useVoice";
import { useTtsPlayback } from "@/lib/voiceOutput";
import type {
  ImageAnalysisMode,
  ImageCategory,
  Message,
  ReplyToRef,
} from "@/lib/storage";
import colors from "@/constants/colors";
import { SwipeToReply } from "@/components/SwipeToReply";

const RELATIONSHIP_MODE_PRESETS = [
  "Friend",
  "Best friend",
  "Companion",
  "Romantic partner",
  "Mentor/coach",
  "Creative partner",
];

// Maximum length of the quote preview we capture from a swiped message.
// Keeps storage and the on-screen quote header from getting unwieldy.
const REPLY_PREVIEW_MAX = 140;

// Stage 3 — local-only preference for spoken replies. No server roundtrip;
// pure UX toggle persisted per-device.
const VOICE_REPLY_STORAGE_KEY = "ashley.voiceReplyEnabled";

// Image picker — visible labels for category + analysis-mode chips.
const IMAGE_CATEGORIES: { value: ImageCategory; label: string }[] = [
  { value: "art_progress", label: "Art progress" },
  { value: "clothing_design", label: "Clothing design" },
  { value: "ashley_identity", label: "Ashley identity" },
  { value: "app_screenshot", label: "App screenshot" },
  { value: "medical", label: "Medical" },
  { value: "other", label: "Other" },
];

const IMAGE_MODES: { value: ImageAnalysisMode; label: string; hint: string }[] =
  [
    { value: "quick", label: "Quick reaction", hint: "short, warm, what jumps out" },
    { value: "critique", label: "Critique", hint: "honest feedback, what could shift" },
    { value: "stepbystep", label: "Step by step", hint: "walk through it methodically" },
    { value: "debug", label: "Debug", hint: "what's wrong + how to fix" },
    { value: "extract", label: "Extract", hint: "pull out text / numbers / structure" },
    { value: "compare", label: "Compare", hint: "compare with what came before" },
  ];

type PickedImage = {
  uri: string;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
};

function mimeFromUri(uri: string, fallback: string | undefined): string {
  if (fallback) return fallback;
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".heic")) return "image/heic";
  return "image/jpeg";
}

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
  const sendImageMutation = useSendImage();
  const markImageRemembered = useMarkImageRemembered();
  const clearMutation = useClearMessages();
  const retryUnanswered = useRetryUnansweredReply();

  // Paperclip / image-upload modal state. Held open from "picked an
  // image" until either Send or Cancel.
  const [pickedImage, setPickedImage] = useState<PickedImage | null>(null);
  const [imageCategory, setImageCategory] = useState<ImageCategory>("other");
  const [imageMode, setImageMode] = useState<ImageAnalysisMode>("quick");
  const [imageCaption, setImageCaption] = useState("");
  const [imagePickerError, setImagePickerError] = useState<string | null>(null);

  const profileQuery = useProfile();
  const updateProfile = useUpdateProfile();
  const relationshipMode = (profileQuery.data?.relationshipMode ?? "").trim();
  const ashleyName = (profileQuery.data?.name ?? "Ashley").trim() || "Ashley";
  const [relPickerOpen, setRelPickerOpen] = useState(false);
  const [customMode, setCustomMode] = useState("");
  const [showCustomInput, setShowCustomInput] = useState(false);
  const isPresetMode = RELATIONSHIP_MODE_PRESETS.includes(relationshipMode);
  const subtitleLabel = relationshipMode
    ? `${relationshipMode} mode`
    : "tap to set relationship mode";

  const applyMode = useCallback(
    async (value: string) => {
      const next = value.trim().slice(0, 80);
      try {
        await updateProfile.mutateAsync({ relationshipMode: next });
        setRelPickerOpen(false);
        setShowCustomInput(false);
        setCustomMode("");
      } catch (e) {
        Alert.alert("Couldn't save", e instanceof Error ? e.message : "Try again.");
      }
    },
    [updateProfile],
  );

  const messages = useMemo<Message[]>(
    () => messagesQuery.data ?? [],
    [messagesQuery.data],
  );

  const sendError =
    sendMutation.error instanceof Error ? sendMutation.error.message : null;

  // Scroll behaviour — the prior version called scrollToEnd on every
  // contentSize change AND on every messages.length change, which caused
  // visible jitter every time a bubble re-measured (image load, quote
  // expansion, "Ashley is typing..." footer mounting). New rule:
  //   - Track whether the user is currently near the bottom via onScroll.
  //   - When the message list grows: only auto-scroll if (a) the user is
  //     near the bottom OR (b) the most-recent message is from the user
  //     OR (c) we're mid-send.
  //   - On the very first render with messages, snap to bottom once.
  const isNearBottomRef = useRef(true);
  const prevMessagesLenRef = useRef(0);
  const didInitialScrollRef = useRef(false);

  const handleScroll = useCallback(
    (e: {
      nativeEvent: {
        contentOffset: { y: number };
        contentSize: { height: number };
        layoutMeasurement: { height: number };
      };
    }) => {
      const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
      const distanceFromBottom =
        contentSize.height - contentOffset.y - layoutMeasurement.height;
      isNearBottomRef.current = distanceFromBottom < 80;
    },
    [],
  );

  useEffect(() => {
    const grew = messages.length > prevMessagesLenRef.current;
    prevMessagesLenRef.current = messages.length;
    if (!didInitialScrollRef.current && messages.length > 0) {
      didInitialScrollRef.current = true;
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: false }),
      );
      return;
    }
    if (!grew && !sendMutation.isPending) return;
    const lastMsg = messages[messages.length - 1];
    const userJustSent = lastMsg?.role === "user";
    if (
      sendMutation.isPending ||
      sendImageMutation.isPending ||
      userJustSent ||
      isNearBottomRef.current
    ) {
      requestAnimationFrame(() =>
        listRef.current?.scrollToEnd({ animated: true }),
      );
    }
  }, [
    messages,
    sendMutation.isPending,
    sendImageMutation.isPending,
  ]);

  // Auto-retry: if the latest message is from the user (Ashley never
  // replied — common when the api-server gets recycled mid-request) keep
  // poking the server every ~12s until her reply lands. The retry
  // mutation handles the no-op case internally, and `appendIfStillCurrent`
  // makes sure we don't double-up if the user types something new while a
  // retry is in flight. We also dismiss the stale send-error banner once a
  // retry succeeds so the green path looks clean.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  // Image messages have their own dedicated /chat/image flow — text-only
  // /chat doesn't know what to do with them. So an unanswered image
  // message at the tail is NOT a candidate for the auto-retry; the user
  // can re-tap the paperclip if it really stalled. (See architect note
  // about /chat being unable to retry image-message ids.)
  const hasUnansweredTail = lastMessage?.role === "user" && !lastMessage?.imageUrl;
  const retryMutateRef = useRef(retryUnanswered.mutateAsync);
  retryMutateRef.current = retryUnanswered.mutateAsync;
  const sendResetRef = useRef(sendMutation.reset);
  sendResetRef.current = sendMutation.reset;
  const inFlightRetryRef = useRef(false);
  useEffect(() => {
    if (!hasUnansweredTail) return;
    if (sendMutation.isPending) return;
    let cancelled = false;
    const tryOnce = () => {
      if (cancelled || inFlightRetryRef.current) return;
      inFlightRetryRef.current = true;
      retryMutateRef
        .current()
        .then((result) => {
          if (result) {
            // The retry landed Ashley's reply — clear any stale error
            // banner from the original failed send.
            sendResetRef.current();
          }
        })
        .catch(() => {
          // Silent — the next tick will try again.
        })
        .finally(() => {
          inFlightRetryRef.current = false;
        });
    };
    const initial = setTimeout(tryOnce, 600);
    const interval = setInterval(tryOnce, 4000);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [hasUnansweredTail, sendMutation.isPending]);

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

  // ----- Voice push-to-talk (Stages 1 + 2) -------------------------------
  // Hold the mic to record, release to transcribe + insert into the draft.
  // Stage 2 streams partial transcripts back over SSE so words appear in
  // the recording banner while the model is still producing text instead
  // of the user sitting in silence for 2-3s after release. The hook
  // silently falls back to the Stage 1 endpoint if streaming fails, so
  // the user always gets a transcript. Text remains the canonical
  // fallback at all times.
  const voice = useVoiceRecorder();
  const transcribeMutation = useTranscribeAudioStream();
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voicePartial, setVoicePartial] = useState("");

  // Stage 3 — spoken replies. Toggle persisted per-device in AsyncStorage,
  // default OFF so Kane never gets ambushed by audio. The ref mirrors the
  // state so the send-mutation closure can read the current value without
  // being reconstructed on every toggle flip.
  const tts = useTtsPlayback();
  const [voiceReplyEnabled, setVoiceReplyEnabled] = useState(false);
  const voiceReplyEnabledRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem(VOICE_REPLY_STORAGE_KEY)
      .then((v) => {
        if (cancelled) return;
        const enabled = v === "true";
        voiceReplyEnabledRef.current = enabled;
        setVoiceReplyEnabled(enabled);
      })
      .catch(() => {
        // Silent — default OFF is the safe fallback.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const toggleVoiceReply = useCallback(() => {
    const next = !voiceReplyEnabledRef.current;
    voiceReplyEnabledRef.current = next;
    setVoiceReplyEnabled(next);
    void AsyncStorage.setItem(VOICE_REPLY_STORAGE_KEY, next ? "true" : "false");
    if (!next) {
      // Toggling off mid-playback should silence her immediately.
      tts.stop();
    }
  }, [tts]);
  // Buffer the partial text in a ref too so the onDelta callback (created
  // once per call below) can accumulate without going stale between
  // renders. The setVoicePartial call is just for UI redraw.
  const voicePartialRef = useRef("");

  const handleMicPressIn = useCallback(async () => {
    setVoiceError(null);
    setVoicePartial("");
    voicePartialRef.current = "";
    // Barge-in: re-opening the mic silences any in-flight spoken reply
    // so Kane isn't talking over Ashley.
    tts.stop();
    try {
      const granted = await voice.ensurePermission();
      if (!granted) {
        setVoiceError("Microphone permission denied");
        return;
      }
      await voice.start();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Couldn't start recording");
    }
  }, [voice, tts]);

  const handleMicPressOut = useCallback(async () => {
    let audio;
    try {
      audio = await voice.stop();
    } catch (e) {
      setVoiceError(e instanceof Error ? e.message : "Couldn't stop recording");
      return;
    }
    if (!audio) {
      // Tap (not hold) or empty clip — nothing to do.
      return;
    }
    try {
      const { transcript } = await transcribeMutation.mutateAsync({
        audio,
        onDelta: (chunk) => {
          voicePartialRef.current += chunk;
          setVoicePartial(voicePartialRef.current);
        },
      });
      // Clear the partial preview now that we have the authoritative
      // final transcript — the banner disappears and the text lands in
      // the draft below.
      voicePartialRef.current = "";
      setVoicePartial("");
      if (transcript.length === 0) {
        setVoiceError("Didn't catch that — try again");
        return;
      }
      // Append to existing draft so dictation can stack with typed text.
      setDraft((prev) => {
        const trimmed = prev.trim();
        if (trimmed.length === 0) return transcript;
        return `${trimmed} ${transcript}`;
      });
      requestAnimationFrame(() => inputRef.current?.focus());
    } catch (e) {
      voicePartialRef.current = "";
      setVoicePartial("");
      setVoiceError(e instanceof Error ? e.message : "Couldn't transcribe");
    }
  }, [voice, transcribeMutation]);

  // Auto-stop recording at the hard ceiling so the user can't accidentally
  // leave the mic open. We just call the same handler the press-out path uses.
  useEffect(() => {
    if (voice.state !== "recording") return;
    if (voice.elapsedMs < VOICE_MAX_DURATION_MS) return;
    void handleMicPressOut();
  }, [voice.state, voice.elapsedMs, handleMicPressOut]);

  const send = useCallback(() => {
    const content = draft.trim();
    if (!content || sendMutation.isPending) return;
    const replyToSnapshot = replyingTo;
    setDraft("");
    setReplyingTo(null);
    sendMutation.reset();
    // Sending a fresh message supersedes any reply Ashley is currently
    // speaking — silence her so the new turn isn't talked over.
    tts.stop();
    sendMutation
      .mutateAsync({ content, replyTo: replyToSnapshot })
      .then((result) => {
        if (!voiceReplyEnabledRef.current) return;
        const reply = result.ashley?.content?.trim() ?? "";
        if (reply.length === 0) return;
        // Cap at the server's 1500-char ceiling so we don't get a 400.
        tts.speak(reply.slice(0, 1500));
      })
      .catch(() => {
        // Send errors surface via sendMutation.error — TTS doesn't need
        // to speak anything for a failed send.
      });
  }, [draft, sendMutation, replyingTo, tts]);

  const confirmClear = useCallback(() => {
    if (clearMutation.isPending) return;
    Alert.alert(
      "Clear conversation?",
      "This will delete the conversation from both this device and our server. Older messages may have already been processed by the AI provider to generate replies and cannot be recalled from there.",
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

  // ---------------------------------------------------------------------
  // Paperclip / image-upload flow
  // ---------------------------------------------------------------------

  const openImagePicker = useCallback(async () => {
    setImagePickerError(null);
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Allow photo library access so you can send Ashley pictures.",
        );
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsMultipleSelection: false,
        base64: true,
        quality: 0.85,
        exif: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset || !asset.base64) {
        Alert.alert("Couldn't read image", "Try again with a different photo.");
        return;
      }
      // Base64 size cap mirrors the server (~7 MB of base64 string).
      if (asset.base64.length > 7 * 1024 * 1024) {
        Alert.alert(
          "Photo too large",
          "That image is over the 5 MB limit. Try a smaller one or take a new photo.",
        );
        return;
      }
      const mimeType = mimeFromUri(asset.uri, asset.mimeType ?? undefined);
      // Block HEIC at the picker — Claude vision can't read it. iOS users
      // can usually pick a JPEG version of the same photo.
      if (mimeType === "image/heic") {
        Alert.alert(
          "HEIC not supported",
          "iPhone HEIC photos can't be analysed yet. Try sharing the photo as JPEG.",
        );
        return;
      }
      setPickedImage({
        uri: asset.uri,
        base64: asset.base64,
        mimeType,
        width: asset.width,
        height: asset.height,
      });
      setImageCategory("other");
      setImageMode("quick");
      setImageCaption("");
    } catch (e) {
      Alert.alert(
        "Couldn't open photos",
        e instanceof Error ? e.message : "Try again.",
      );
    }
  }, []);

  const cancelImagePicker = useCallback(() => {
    setPickedImage(null);
    setImagePickerError(null);
  }, []);

  const sendPickedImage = useCallback(async () => {
    if (!pickedImage || sendImageMutation.isPending) return;
    const replyToSnapshot = replyingTo;
    const captionSnapshot = imageCaption.trim();
    const picked = pickedImage;
    const cat = imageCategory;
    const mode = imageMode;
    setImagePickerError(null);
    try {
      await sendImageMutation.mutateAsync({
        uri: picked.uri,
        base64: picked.base64,
        mimeType: picked.mimeType,
        category: cat,
        mode,
        caption: captionSnapshot,
        ...(replyToSnapshot ? { replyTo: replyToSnapshot } : {}),
      });
      setPickedImage(null);
      setImageCaption("");
      setReplyingTo(null);
    } catch (err) {
      setImagePickerError(
        err instanceof Error
          ? err.message
          : "Couldn't send the image — try again.",
      );
    }
  }, [
    pickedImage,
    sendImageMutation,
    imageCaption,
    imageCategory,
    imageMode,
    replyingTo,
  ]);

  // ---------------------------------------------------------------------
  // Remember card — shown under Ashley's reply when the previous message
  // is a user-uploaded image with an undecided imageRemembered flag.
  // ---------------------------------------------------------------------

  const onRemember = useCallback(
    (userMessageId: string, decision: "remember" | "visual" | "dismiss") => {
      markImageRemembered.mutate({ messageId: userMessageId, decision });
    },
    [markImageRemembered],
  );

  const renderItem = useCallback(
    ({ item, index }: { item: Message; index: number }) => {
      const prev = index > 0 ? messages[index - 1] : null;
      const showRememberCard =
        item.role === "ashley" &&
        prev &&
        prev.role === "user" &&
        !!prev.imageUrl &&
        prev.imageRemembered === null &&
        prev.imageCategory != null;
      return (
        <>
          <MessageBubble message={item} onSwipeReply={handleStartReply} />
          {showRememberCard && prev ? (
            <RememberCard
              userMessageId={prev.id}
              category={prev.imageCategory ?? "other"}
              onChoose={onRemember}
              isPending={markImageRemembered.isPending}
            />
          ) : null}
        </>
      );
    },
    [handleStartReply, messages, onRemember, markImageRemembered.isPending],
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
        <Pressable
          style={styles.headerCenter}
          onPress={() => {
            setCustomMode(isPresetMode ? "" : relationshipMode);
            setShowCustomInput(!!relationshipMode && !isPresetMode);
            setRelPickerOpen(true);
          }}
          accessibilityLabel="Change relationship mode"
        >
          <Text style={styles.headerTitle}>{ashleyName}</Text>
          <View style={styles.headerSubtitleRow}>
            <Text
              style={[
                styles.headerSubtitle,
                !relationshipMode && styles.headerSubtitleHint,
              ]}
              numberOfLines={1}
            >
              {subtitleLabel}
            </Text>
            <Feather
              name="chevron-down"
              size={11}
              color={colors.light.mutedForeground}
              style={{ marginLeft: 3 }}
            />
          </View>
        </Pressable>
        <Pressable
          onPress={toggleVoiceReply}
          style={styles.iconBtn}
          accessibilityLabel={
            voiceReplyEnabled
              ? "Turn off spoken replies"
              : "Turn on spoken replies"
          }
        >
          <Feather
            name={voiceReplyEnabled ? "volume-2" : "volume-x"}
            size={18}
            color={
              voiceReplyEnabled
                ? colors.light.primary
                : colors.light.mutedForeground
            }
          />
        </Pressable>
        <Pressable
          onPress={confirmClear}
          style={styles.iconBtn}
          accessibilityLabel="Clear conversation"
        >
          <Feather name="trash-2" size={18} color={colors.light.mutedForeground} />
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 8 : insets.top + 56}
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
                  messages are saved on our server (tied to your Device ID)
                  and sent to an AI provider so she can reply
                </Text>
              </View>
            }
            ListFooterComponent={
              sendMutation.isPending ||
              retryUnanswered.isPending ||
              hasUnansweredTail ? (
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
            onScroll={handleScroll}
            scrollEventThrottle={64}
          />
        )}

        {sendError && !hasUnansweredTail ? (
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
            <Text style={styles.errorText} numberOfLines={6}>
              {sendError}
              {"\n"}
              <Text style={styles.errorSubtext}>
                api: {process.env.EXPO_PUBLIC_DOMAIN || "(unset!)"} · tap to dismiss
              </Text>
            </Text>
          </Pressable>
        ) : null}

        {replyingTo ? (
          <View style={styles.replyPreview}>
            <View style={styles.replyAccent} />
            <View style={styles.replyTextWrap}>
              <Text style={styles.replyAuthor}>
                Replying to {replyingTo.role === "ashley" ? "Ashley" : "yourself"}
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
          <Pressable
            onPress={openImagePicker}
            disabled={sendMutation.isPending || sendImageMutation.isPending}
            style={({ pressed }) => [
              styles.attachBtn,
              (sendMutation.isPending || sendImageMutation.isPending) && {
                opacity: 0.4,
              },
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
            accessibilityLabel="Attach a photo"
            hitSlop={6}
          >
            <Feather
              name="paperclip"
              size={20}
              color={colors.light.mutedForeground}
            />
          </Pressable>
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
            editable={!sendMutation.isPending && !sendImageMutation.isPending}
            onSubmitEditing={send}
            blurOnSubmit={false}
          />
          <Pressable
            onPressIn={handleMicPressIn}
            onPressOut={handleMicPressOut}
            disabled={
              sendMutation.isPending ||
              sendImageMutation.isPending ||
              transcribeMutation.isPending
            }
            style={({ pressed }) => [
              styles.micBtn,
              voice.state === "recording" && styles.micBtnRecording,
              (sendMutation.isPending ||
                sendImageMutation.isPending ||
                transcribeMutation.isPending) && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.95 }] },
            ]}
            accessibilityLabel={
              voice.state === "recording"
                ? "Recording — release to send"
                : "Hold to dictate"
            }
            hitSlop={6}
          >
            {transcribeMutation.isPending ? (
              <ActivityIndicator
                size="small"
                color={colors.light.mutedForeground}
              />
            ) : (
              <Feather
                name="mic"
                size={20}
                color={
                  voice.state === "recording"
                    ? colors.light.destructiveForeground
                    : colors.light.mutedForeground
                }
              />
            )}
          </Pressable>
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
        {voice.state === "recording" ? (
          <View style={styles.voiceStatus} pointerEvents="none">
            <View style={styles.voiceDot} />
            <Text style={styles.voiceStatusText}>
              Listening… {Math.floor(voice.elapsedMs / 1000)}s
            </Text>
          </View>
        ) : transcribeMutation.isPending ? (
          // Stage 2 — show partial transcript live as the model produces
          // text. Shows "Transcribing…" until the first delta arrives,
          // then quotes the running partial so the user can see words
          // appearing instead of staring at a silent spinner.
          <View style={styles.voiceStatus} pointerEvents="none">
            <ActivityIndicator
              size="small"
              color={colors.light.mutedForeground}
            />
            <Text style={styles.voiceStatusText} numberOfLines={2}>
              {voicePartial.length > 0
                ? `“${voicePartial}”`
                : "Transcribing…"}
            </Text>
          </View>
        ) : null}
        {voiceError ? (
          <View style={styles.voiceStatus}>
            <Text style={styles.voiceErrorText}>{voiceError}</Text>
            <Pressable onPress={() => setVoiceError(null)} hitSlop={8}>
              <Feather name="x" size={14} color={colors.light.mutedForeground} />
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>

      <Modal
        visible={relPickerOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setRelPickerOpen(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setRelPickerOpen(false)}
        >
          <Pressable style={styles.modalCard} onPress={() => {}}>
            <Text style={styles.modalTitle}>Relationship Mode</Text>
            <Text style={styles.modalHint}>
              How Ashley relates to you right now. Change any time — she adapts, no guilt-trips.
            </Text>
            <View style={styles.chipsWrap}>
              {RELATIONSHIP_MODE_PRESETS.map((opt) => {
                const active = opt === relationshipMode;
                return (
                  <Pressable
                    key={opt}
                    onPress={() => applyMode(opt)}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        active && styles.chipTextActive,
                      ]}
                    >
                      {opt}
                    </Text>
                  </Pressable>
                );
              })}
              <Pressable
                onPress={() => setShowCustomInput(true)}
                style={[
                  styles.chip,
                  (showCustomInput || (relationshipMode && !isPresetMode)) &&
                    styles.chipActive,
                ]}
              >
                <Text
                  style={[
                    styles.chipText,
                    (showCustomInput || (relationshipMode && !isPresetMode)) &&
                      styles.chipTextActive,
                  ]}
                >
                  Custom
                </Text>
              </Pressable>
            </View>
            {showCustomInput || (relationshipMode && !isPresetMode) ? (
              <>
                <Text style={styles.modalLabel}>your own description</Text>
                <View style={styles.customRow}>
                  <TextInput
                    value={customMode}
                    onChangeText={setCustomMode}
                    placeholder="describe the relationship in your own words"
                    placeholderTextColor={colors.light.mutedForeground}
                    style={styles.customInput}
                    maxLength={80}
                    autoFocus={showCustomInput}
                    returnKeyType="done"
                    onSubmitEditing={() => {
                      if (customMode.trim()) applyMode(customMode);
                    }}
                  />
                  <Pressable
                    onPress={() => {
                      if (customMode.trim()) applyMode(customMode);
                    }}
                    disabled={!customMode.trim() || updateProfile.isPending}
                    style={[
                      styles.customSaveBtn,
                      (!customMode.trim() || updateProfile.isPending) && {
                        opacity: 0.4,
                      },
                    ]}
                  >
                    <Text style={styles.customSaveText}>Save</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
            {relationshipMode ? (
              <Pressable
                onPress={() => applyMode("")}
                style={styles.clearRelBtn}
              >
                <Text style={styles.clearRelText}>clear — no mode set</Text>
              </Pressable>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      <Modal
        visible={!!pickedImage}
        transparent
        animationType="slide"
        onRequestClose={cancelImagePicker}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.imagePickerCard}>
            <View style={styles.imagePickerHeader}>
              <Text style={styles.modalTitle}>Send a photo</Text>
              <Pressable
                onPress={cancelImagePicker}
                hitSlop={8}
                accessibilityLabel="Cancel"
                disabled={sendImageMutation.isPending}
              >
                <Feather
                  name="x"
                  size={20}
                  color={colors.light.mutedForeground}
                />
              </Pressable>
            </View>
            {pickedImage ? (
              <Image
                source={{ uri: pickedImage.uri }}
                style={styles.imagePickerPreview}
                resizeMode="cover"
                accessibilityLabel="Selected photo preview"
              />
            ) : null}
            <Text style={styles.modalLabel}>What is this?</Text>
            <View style={styles.chipsWrap}>
              {IMAGE_CATEGORIES.map((c) => {
                const active = c.value === imageCategory;
                return (
                  <Pressable
                    key={c.value}
                    onPress={() => setImageCategory(c.value)}
                    disabled={sendImageMutation.isPending}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text
                      style={[styles.chipText, active && styles.chipTextActive]}
                    >
                      {c.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.modalLabel}>How should she look at it?</Text>
            <View style={styles.chipsWrap}>
              {IMAGE_MODES.map((m) => {
                const active = m.value === imageMode;
                return (
                  <Pressable
                    key={m.value}
                    onPress={() => setImageMode(m.value)}
                    disabled={sendImageMutation.isPending}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text
                      style={[styles.chipText, active && styles.chipTextActive]}
                    >
                      {m.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.modeHint}>
              {IMAGE_MODES.find((m) => m.value === imageMode)?.hint ?? ""}
            </Text>
            <TextInput
              value={imageCaption}
              onChangeText={setImageCaption}
              placeholder="add a note for her (optional)"
              placeholderTextColor={colors.light.mutedForeground}
              style={styles.imageCaptionInput}
              maxLength={1000}
              multiline
              editable={!sendImageMutation.isPending}
            />
            {imagePickerError ? (
              <Text style={styles.imagePickerError} numberOfLines={3}>
                {imagePickerError}
              </Text>
            ) : null}
            {imageCategory === "medical" ? (
              <Text style={styles.medicalNotice}>
                Heads up: she won't diagnose. She'll help you organise what
                you're seeing and flag NHS 111 / 999 if anything looks
                acute.
              </Text>
            ) : null}
            <Pressable
              onPress={sendPickedImage}
              disabled={sendImageMutation.isPending || !pickedImage}
              style={({ pressed }) => [
                styles.imagePickerSendBtn,
                (sendImageMutation.isPending || !pickedImage) && {
                  opacity: 0.4,
                },
                pressed && { transform: [{ scale: 0.98 }] },
              ]}
              accessibilityLabel="Send the photo"
            >
              {sendImageMutation.isPending ? (
                <ActivityIndicator
                  size="small"
                  color={colors.light.primaryForeground}
                />
              ) : (
                <>
                  <Feather
                    name="send"
                    size={16}
                    color={colors.light.primaryForeground}
                  />
                  <Text style={styles.imagePickerSendText}>
                    Send to {ashleyName}
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ---------------------------------------------------------------------------
// "Should I remember anything?" card — appears under Ashley's reply to a
// user-uploaded image while the user hasn't decided yet. Three options:
// keep it as a memory, keep it as a visual reference (lighter weight), or
// dismiss the card. Tapping any option clears the card immediately.
// ---------------------------------------------------------------------------

function RememberCard({
  userMessageId,
  category,
  onChoose,
  isPending,
}: {
  userMessageId: string;
  category: ImageCategory;
  onChoose: (
    id: string,
    decision: "remember" | "visual" | "dismiss",
  ) => void;
  isPending: boolean;
}): React.JSX.Element {
  return (
    <View style={[styles.row, styles.rowLeft]}>
      <View style={styles.rememberCard}>
        <View style={styles.rememberHeader}>
          <Feather
            name="bookmark"
            size={14}
            color={colors.light.accent}
          />
          <Text style={styles.rememberHeaderText}>
            Should I remember anything?
          </Text>
        </View>
        <Text style={styles.rememberHint}>
          {category === "ashley_identity"
            ? "I can hold this as part of how I see myself."
            : category === "medical"
              ? "I can keep this so I can refer back to it next time."
              : "I can keep this in mind for next time we talk."}
        </Text>
        <View style={styles.rememberRow}>
          <Pressable
            onPress={() => onChoose(userMessageId, "remember")}
            disabled={isPending}
            style={({ pressed }) => [
              styles.rememberBtn,
              styles.rememberBtnPrimary,
              isPending && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.97 }] },
            ]}
          >
            <Text style={styles.rememberBtnPrimaryText}>Remember</Text>
          </Pressable>
          <Pressable
            onPress={() => onChoose(userMessageId, "visual")}
            disabled={isPending}
            style={({ pressed }) => [
              styles.rememberBtn,
              styles.rememberBtnSecondary,
              isPending && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.97 }] },
            ]}
          >
            <Text style={styles.rememberBtnSecondaryText}>Just visual</Text>
          </Pressable>
          <Pressable
            onPress={() => onChoose(userMessageId, "dismiss")}
            disabled={isPending}
            style={({ pressed }) => [
              styles.rememberBtn,
              styles.rememberBtnGhost,
              isPending && { opacity: 0.4 },
              pressed && { transform: [{ scale: 0.97 }] },
            ]}
          >
            <Text style={styles.rememberBtnGhostText}>Skip</Text>
          </Pressable>
        </View>
      </View>
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
  const autoInFlight = useSelfieInFlight(message.id);
  // Track retry state locally with React state so the spinner / error
  // message actually trigger re-renders. (The hook's underlying dedup Set
  // isn't reactive — that was the old bug where tapping looked dead.)
  const [retryingThis, setRetryingThis] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  // Guard against setting state after the bubble unmounts. The selfie
  // poll can run for up to 2 minutes, and the user might clear the chat
  // or navigate away mid-flight.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const onCopyText = useCallback(async () => {
    if (!hasText) return;
    try {
      await Clipboard.setStringAsync(message.content);
      Alert.alert("Copied", "Message copied to clipboard.");
    } catch {
      Alert.alert("Couldn't copy", "Try again in a moment.");
    }
  }, [hasText, message.content]);

  const onSaveImage = useCallback(async () => {
    if (!message.imageUrl) return;
    try {
      const perm = await MediaLibrary.requestPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          "Permission needed",
          "Allow photo library access to save Ashley's selfies.",
        );
        return;
      }
      const target =
        (FileSystem.cacheDirectory ?? "") +
        `ashley-${message.id}.jpg`;
      const dl = await FileSystem.downloadAsync(message.imageUrl, target);
      await MediaLibrary.saveToLibraryAsync(dl.uri);
      Alert.alert("Saved", "Photo saved to your library.");
    } catch (err) {
      Alert.alert(
        "Couldn't save",
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong saving the photo.",
      );
    }
  }, [message.id, message.imageUrl]);

  const onRetrySelfie = useCallback(() => {
    if (!pendingSelfieVibe || retryingThis) return;
    setRetryingThis(true);
    setRetryError(null);
    retry(message.id, pendingSelfieVibe)
      .catch((err: unknown) => {
        if (!isMountedRef.current) return;
        setRetryError(
          err instanceof Error && err.message
            ? err.message
            : "still couldn't reach her — tap again",
        );
      })
      .finally(() => {
        if (!isMountedRef.current) return;
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
          quoted && styles.bubbleWithQuote,
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
          <Pressable
            onLongPress={onSaveImage}
            delayLongPress={350}
            accessibilityLabel="Long-press to save photo"
          >
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
          </Pressable>
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
          (() => {
            const generating = retryingThis || autoInFlight;
            return (
              <Pressable
                onPress={generating ? undefined : onRetrySelfie}
                disabled={generating}
                hitSlop={8}
                style={styles.selfiePending}
                accessibilityLabel={
                  generating ? "Taking a selfie" : "Tap to retry sending photo"
                }
              >
                {generating ? (
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
                  {generating
                    ? "taking a selfie…"
                    : retryError
                      ? retryError
                      : "couldn't send the photo — tap to retry"}
                </Text>
              </Pressable>
            );
          })()
        ) : null}
        {hasText ? (
          <Text
            selectable
            onLongPress={onCopyText}
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
  headerSubtitleRow: { flexDirection: "row", alignItems: "center", marginTop: 1 },
  headerSubtitleHint: { fontStyle: "italic", opacity: 0.85 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: colors.light.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 28,
    gap: 10,
  },
  modalTitle: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 17,
  },
  modalHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    marginBottom: 4,
  },
  modalLabel: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: 8,
  },
  chipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: colors.light.muted,
  },
  chipActive: {
    backgroundColor: colors.light.primary,
  },
  chipText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  chipTextActive: {
    color: colors.light.primaryForeground,
  },
  customRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  customInput: {
    flex: 1,
    backgroundColor: colors.light.muted,
    color: colors.light.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
  },
  customSaveBtn: {
    backgroundColor: colors.light.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  customSaveText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  clearRelBtn: {
    alignSelf: "center",
    paddingVertical: 8,
    marginTop: 4,
  },
  clearRelText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    textDecorationLine: "underline",
  },
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
  bubbleWithQuote: {
    // Quoted reply previews need horizontal room or the inner Text wraps
    // character-by-character when the user's own message is very short
    // (e.g. just "?"), producing a bizarre tall narrow bubble. Force a
    // sensible floor; maxWidth still caps the upper bound.
    minWidth: 220,
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
    flex: 1,
  },
  errorSubtext: {
    color: colors.light.destructiveForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 10,
    opacity: 0.85,
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
  attachBtn: {
    width: 40,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.light.muted,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  micBtnRecording: {
    backgroundColor: colors.light.destructive,
  },
  voiceStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: colors.light.background,
  },
  voiceDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.light.destructive,
  },
  voiceStatusText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    flex: 1,
  },
  voiceErrorText: {
    color: colors.light.destructiveForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    flex: 1,
  },
  imagePickerCard: {
    backgroundColor: colors.light.background,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 26,
    gap: 8,
    maxHeight: "92%",
  },
  imagePickerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  imagePickerPreview: {
    width: "100%",
    height: 180,
    borderRadius: 12,
    backgroundColor: colors.light.muted,
    marginBottom: 4,
  },
  modeHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 11,
    fontStyle: "italic",
  },
  imageCaptionInput: {
    backgroundColor: colors.light.muted,
    color: colors.light.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontFamily: "Inter_400Regular",
    fontSize: 14,
    minHeight: 48,
    maxHeight: 110,
    marginTop: 6,
  },
  medicalNotice: {
    color: colors.light.accent,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    backgroundColor: "rgba(122, 92, 255, 0.10)",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  imagePickerError: {
    color: colors.light.destructive,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  imagePickerSendBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.light.primary,
    borderRadius: 14,
    paddingVertical: 14,
    marginTop: 10,
  },
  imagePickerSendText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  rememberCard: {
    maxWidth: "85%",
    marginLeft: 4,
    marginVertical: 6,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(122, 92, 255, 0.35)",
    backgroundColor: "rgba(122, 92, 255, 0.08)",
    gap: 10,
  },
  rememberHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  rememberHeaderText: {
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 13,
  },
  rememberHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  rememberRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  rememberBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
  },
  rememberBtnPrimary: {
    backgroundColor: colors.light.primary,
  },
  rememberBtnPrimaryText: {
    color: colors.light.primaryForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 12,
  },
  rememberBtnSecondary: {
    backgroundColor: colors.light.muted,
  },
  rememberBtnSecondaryText: {
    color: colors.light.text,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
  },
  rememberBtnGhost: {
    backgroundColor: "transparent",
  },
  rememberBtnGhostText: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    textDecorationLine: "underline",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
