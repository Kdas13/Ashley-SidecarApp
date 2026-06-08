import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
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
import { fetchTestSelfie, insertAshleyImageMessage, type ReplikaCarryoverInput } from "@/lib/aiClient";
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

// ---------------------------------------------------------------------------
// Image defaults types
// ---------------------------------------------------------------------------

// Activity value → implied environment. Used by handleActivitySelect to
// auto-set Section 2 when Kane picks an activity with a known environment.
const ACTIVITY_ENV_MAP: Record<string, { value: string; label: string }> = {
  "watching football in stadium": { value: "football-stadium",   label: "Football Stadium" },
  "watching rugby at ground":     { value: "rugby-ground",       label: "Rugby Ground" },
  "playing football":             { value: "football-pitch",     label: "Football Pitch" },
  "playing rugby":                { value: "rugby-ground",       label: "Rugby Ground" },
  "photography walk":             { value: "walking-trail",      label: "Walking Trail" },
  "visiting a museum":            { value: "museum",             label: "Museum" },
  "visiting an art gallery":      { value: "art-gallery",        label: "Art Gallery" },
  "having coffee at a cafe":      { value: "cafe",               label: "Cafe" },
  "having a meal at a restaurant":{ value: "restaurant",         label: "Restaurant" },
  "at the pub":                   { value: "pub",                label: "Pub" },
  "wine tasting":                 { value: "vineyard",           label: "Vineyard" },
  "whisky tasting":               { value: "whisky-distillery",  label: "Whisky Distillery" },
  "at a party":                   { value: "house-party",        label: "House Party / Event Venue" },
};

type ImageDefaultsExtra = {
  timeOfDay?: string | null;
  season?: string | null;
  activity?: string | null;
  shotDistance?: string | null;
  cameraAwareness?: string | null;
};

function parseImageDefaultsExtra(raw: string | null | undefined): ImageDefaultsExtra {
  if (!raw) return {};
  try { return JSON.parse(raw) as ImageDefaultsExtra; } catch { return {}; }
}

function encodeImageDefaultsExtra(extra: ImageDefaultsExtra): string {
  return JSON.stringify(extra);
}

// Camera mode can be multi-select (stored as comma-separated string).
// "auto" means the set is empty (server decides).
function parseCameraSet(raw: string | null | undefined): Set<string> {
  if (!raw || raw === "auto") return new Set(["wide-room"]);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function encodeCameraSet(set: Set<string>): string {
  if (set.size === 0) return "auto";
  return [...set].join(",");
}

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

  // ---------------------------------------------------------------------------
  // Image defaults — full accordion state (9 sections). All auto-save on tap.
  // ---------------------------------------------------------------------------
  const compositionMode = draft.imageCompositionMode ?? "auto";
  const environmentDefault = draft.imageEnvironmentDefault ?? "auto";
  const occupancyDefault = draft.imageOccupancyDefault ?? "auto";
  // Camera mode is multi-select stored as comma-separated string.
  const cameraSet = parseCameraSet(draft.imageCameraDefault);

  const imgExtra = parseImageDefaultsExtra(draft.imageDefaultsExtra);
  const timeOfDay = imgExtra.timeOfDay ?? "auto";
  const season = imgExtra.season ?? "auto";
  const activity = imgExtra.activity ?? "auto";
  const shotDistance = imgExtra.shotDistance ?? "auto";
  const cameraAwareness = imgExtra.cameraAwareness ?? "unaware";

  // Accordion open/close state for each section.
  const [openSection, setOpenSection] = React.useState<number | null>(null);
  const toggleSection = (n: number) => setOpenSection((prev) => (prev === n ? null : n));

  const setCompositionMode = (v: string) => {
    const next = v as typeof draft.imageCompositionMode;
    setDraft((prev) => ({ ...prev, imageCompositionMode: next }));
    void update.mutateAsync({ imageCompositionMode: next }).catch(() => undefined);
  };
  const setEnvironmentDefault = (v: string) => {
    const next = v as typeof draft.imageEnvironmentDefault;
    setDraft((prev) => ({ ...prev, imageEnvironmentDefault: next }));
    void update.mutateAsync({ imageEnvironmentDefault: next }).catch(() => undefined);
  };
  const setOccupancyDefault = (v: string) => {
    const next = v as typeof draft.imageOccupancyDefault;
    setDraft((prev) => ({ ...prev, imageOccupancyDefault: next }));
    void update.mutateAsync({ imageOccupancyDefault: next }).catch(() => undefined);
  };

  // Camera mode is multi-select. Toggling a value adds/removes from the set.
  const toggleCameraMode = (v: string) => {
    const next = new Set(cameraSet);
    if (next.has(v)) { next.delete(v); } else { next.add(v); }
    const encoded = encodeCameraSet(next) as typeof draft.imageCameraDefault;
    setDraft((prev) => ({ ...prev, imageCameraDefault: encoded }));
    void update.mutateAsync({ imageCameraDefault: encoded }).catch(() => undefined);
  };

  const setExtra = (patch: Partial<ImageDefaultsExtra>) => {
    const next = { ...imgExtra, ...patch };
    const encoded = encodeImageDefaultsExtra(next);
    setDraft((prev) => ({ ...prev, imageDefaultsExtra: encoded }));
    void update.mutateAsync({ imageDefaultsExtra: encoded }).catch(() => undefined);
  };

  const [activityImpliedEnvNote, setActivityImpliedEnvNote] = React.useState<string | null>(null);
  const [testImageLoading, setTestImageLoading] = React.useState(false);
  const [testImageUrl, setTestImageUrl] = React.useState<string | null>(null);
  const [testImageZoomed, setTestImageZoomed] = React.useState(false);
  const [testImageSending, setTestImageSending] = React.useState(false);

  const handleActivitySelect = (value: string): void => {
    setExtra({ activity: value });
    const implied = ACTIVITY_ENV_MAP[value];
    if (implied) {
      setEnvironmentDefault(implied.value);
      setActivityImpliedEnvNote(`Environment auto-set to ${implied.label} based on activity.`);
    } else {
      setActivityImpliedEnvNote(null);
    }
  };

  const onGenerateTestImage = async (): Promise<void> => {
    if (testImageLoading) return;
    setTestImageUrl(null);
    setTestImageLoading(true);
    try {
      // Build governance snapshot directly from draft state.
      // Do NOT rely on _governanceParams from imageGate — that module-level
      // variable is only synced while chat.tsx is mounted, not profile.tsx.
      const governanceSnapshot = {
        imageCompositionMode: compositionMode !== "auto" ? compositionMode : null,
        imageEnvironmentDefault: environmentDefault !== "auto" ? environmentDefault : null,
        imageOccupancyDefault: occupancyDefault !== "auto" ? occupancyDefault : null,
        imageCameraDefault: draft.imageCameraDefault ?? null,
        imageDefaultsExtra: {
          timeOfDay: timeOfDay !== "auto" ? timeOfDay : null,
          season: season !== "auto" ? season : null,
          activity: activity !== "auto" ? activity : null,
          shotDistance: shotDistance !== "auto" ? shotDistance : null,
          cameraAwareness: cameraAwareness,
        },
      };
      const result = await fetchTestSelfie(governanceSnapshot);
      setTestImageUrl(result.imageUrl);
    } catch {
      Alert.alert("Generation failed", "Could not generate a test image. Try again.");
    } finally {
      setTestImageLoading(false);
    }
  };

  const onSendToChat = async (): Promise<void> => {
    if (!testImageUrl || testImageSending) return;
    setTestImageSending(true);
    try {
      await insertAshleyImageMessage(testImageUrl);
      router.push("/chat" as never);
    } catch {
      Alert.alert("Send failed", "Could not send to chat. Try again.");
    } finally {
      setTestImageSending(false);
    }
  };

  const resetImageDefaults = () => {
    const defaults = {
      imageCompositionMode: "environment-centric" as typeof draft.imageCompositionMode,
      imageEnvironmentDefault: "auto" as typeof draft.imageEnvironmentDefault,
      imageOccupancyDefault: "auto" as typeof draft.imageOccupancyDefault,
      imageCameraDefault: "wide-room" as typeof draft.imageCameraDefault,
      imageDefaultsExtra: encodeImageDefaultsExtra({
        timeOfDay: "auto",
        season: "auto",
        activity: "auto",
        shotDistance: "auto",
        cameraAwareness: "unaware",
      }),
    };
    setDraft((prev) => ({ ...prev, ...defaults }));
    void update.mutateAsync(defaults).catch(() => undefined);
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

        {/* ================================================================
            IMAGE DEFAULTS — 9-section accordion
            ================================================================ */}
        <View style={styles.fieldGroup}>
          <Text style={styles.label}>Image defaults</Text>
          <Text style={styles.hint}>
            Tick what you want. Untick what you don&apos;t. Each selection
            becomes a direct instruction to the image generator. Auto means
            the server picks a sensible value. Tap a section header to expand.
          </Text>

          {/* Summary line */}
          {(() => {
            const parts: string[] = [];
            if (compositionMode !== "auto") {
              const COMP_LABELS: Record<string, string> = {
                "ashley-centric": "Ashley-Centric",
                "balanced": "Balanced",
                "environment-centric": "Environment-Centric",
                "architectural": "Architectural",
                "social": "Social",
                "documentary": "Documentary",
              };
              parts.push(COMP_LABELS[compositionMode] ?? compositionMode);
            }
            if (environmentDefault !== "auto") {
              const ENV_LABELS: Record<string, string> = {
                "living-room": "Living Room", "bedroom": "Bedroom",
                "kitchen": "Kitchen", "study": "Study", "garden": "Garden",
                "bathroom": "Bathroom", "cafe": "Cafe", "restaurant": "Restaurant",
                "pub": "Pub", "bar": "Bar", "vineyard": "Vineyard",
                "nightclub": "Nightclub", "music-gig": "Music Gig",
                "festival": "Festival", "concert": "Concert",
                "sporting-event": "Sporting Event", "cinema": "Cinema",
                "museum": "Museum", "art-gallery": "Art Gallery",
                "library": "Library", "market": "Market",
                "high-street": "High Street", "train-station": "Train Station",
                "park": "Park", "woodland": "Woodland", "beach": "Beach",
                "city-centre": "City Centre", "walking-trail": "Walking Trail",
                "hotel": "Hotel", "holiday-cottage": "Holiday Cottage",
                "beach-holiday": "Beach Holiday", "mountain-retreat": "Mountain Retreat",
              };
              parts.push(ENV_LABELS[environmentDefault] ?? environmentDefault);
            }
            if (timeOfDay !== "auto") parts.push(timeOfDay.charAt(0).toUpperCase() + timeOfDay.slice(1));
            if (cameraSet.size > 0) {
              const CAMERA_LABELS: Record<string, string> = {
                "selfie": "Selfie", "portrait": "Portrait", "lifestyle": "Lifestyle",
                "wide-room": "Wide Angle", "architectural": "Architectural",
                "documentary": "Documentary / Candid", "group-shot": "Group Shot",
                "action": "Action / Sport", "event": "Event Photography",
              };
              parts.push([...cameraSet].map((c) => CAMERA_LABELS[c] ?? c).join(", "));
            }
            const summary = parts.length > 0 ? parts.join(" · ") : "All Auto";
            return (
              <Text style={styles.imgDefaultsSummary} numberOfLines={2}>{summary}</Text>
            );
          })()}

          {/* SECTION 1 — Composition Mode */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(1)}>
            <Text style={styles.accordionHeaderText}>Composition Mode</Text>
            <Text style={styles.accordionChevron}>{openSection === 1 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 1 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",                label: "Auto (server decides)" },
                { value: "ashley-centric",      label: "Ashley-Centric (Ashley fills most of frame)" },
                { value: "balanced",            label: "Balanced (Ashley and room share frame)" },
                { value: "environment-centric", label: "Environment-Centric (room is the subject, Ashley is small)" },
                { value: "architectural",       label: "Architectural (room only, Ashley minimal or absent)" },
                { value: "social",              label: "Social (group setting, Ashley is one of many)" },
                { value: "documentary",         label: "Documentary (candid moment, natural behaviour)" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === compositionMode;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setCompositionMode(opt.value)}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 2 — Environment */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(2)}>
            <Text style={styles.accordionHeaderText}>Environment</Text>
            <Text style={styles.accordionChevron}>{openSection === 2 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 2 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto", label: "Auto" },
                { value: "__home__", label: "— HOME —", divider: true },
                { value: "living-room", label: "Living Room" },
                { value: "bedroom", label: "Bedroom" },
                { value: "kitchen", label: "Kitchen" },
                { value: "study", label: "Study" },
                { value: "garden", label: "Garden" },
                { value: "bathroom", label: "Bathroom" },
                { value: "__food__", label: "— FOOD & DRINK —", divider: true },
                { value: "cafe", label: "Cafe" },
                { value: "restaurant", label: "Restaurant" },
                { value: "pub", label: "Pub" },
                { value: "bar", label: "Bar" },
                { value: "vineyard", label: "Vineyard" },
                { value: "whisky-distillery", label: "Whisky Distillery" },
                { value: "__ent__", label: "— ENTERTAINMENT —", divider: true },
                { value: "nightclub", label: "Nightclub" },
                { value: "music-gig", label: "Music Gig" },
                { value: "festival", label: "Festival" },
                { value: "concert", label: "Concert" },
                { value: "sporting-event", label: "Sporting Event" },
                { value: "cinema", label: "Cinema" },
                { value: "house-party", label: "House Party" },
                { value: "__sports__", label: "— SPORTS VENUES —", divider: true },
                { value: "football-pitch", label: "Football Pitch" },
                { value: "football-stadium", label: "Football Stadium" },
                { value: "rugby-ground", label: "Rugby Ground" },
                { value: "__pub__", label: "— PUBLIC —", divider: true },
                { value: "museum", label: "Museum" },
                { value: "art-gallery", label: "Art Gallery" },
                { value: "library", label: "Library" },
                { value: "market", label: "Market" },
                { value: "high-street", label: "High Street" },
                { value: "train-station", label: "Train Station" },
                { value: "__outdoor__", label: "— OUTDOOR —", divider: true },
                { value: "park", label: "Park" },
                { value: "woodland", label: "Woodland" },
                { value: "beach", label: "Beach" },
                { value: "city-centre", label: "City Centre" },
                { value: "walking-trail", label: "Walking Trail" },
                { value: "__travel__", label: "— TRAVEL —", divider: true },
                { value: "hotel", label: "Hotel" },
                { value: "holiday-cottage", label: "Holiday Cottage" },
                { value: "beach-holiday", label: "Beach Holiday" },
                { value: "mountain-retreat", label: "Mountain Retreat" },
              ] as { value: string; label: string; divider?: boolean }[]).map((opt) => {
                if (opt.divider) {
                  return <Text key={opt.value} style={styles.accordionDivider}>{opt.label}</Text>;
                }
                const sel = opt.value === environmentDefault;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setEnvironmentDefault(opt.value)}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 3 — Time of Day */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(3)}>
            <Text style={styles.accordionHeaderText}>Time of Day</Text>
            <Text style={styles.accordionChevron}>{openSection === 3 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 3 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",      label: "Auto (uses real device clock)" },
                { value: "morning",   label: "Morning" },
                { value: "afternoon", label: "Afternoon" },
                { value: "evening",   label: "Evening" },
                { value: "night",     label: "Night" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === timeOfDay;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setExtra({ timeOfDay: opt.value })}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 4 — Season */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(4)}>
            <Text style={styles.accordionHeaderText}>Season</Text>
            <Text style={styles.accordionChevron}>{openSection === 4 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 4 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",   label: "Auto (uses real calendar month)" },
                { value: "spring", label: "Spring" },
                { value: "summer", label: "Summer" },
                { value: "autumn", label: "Autumn" },
                { value: "winter", label: "Winter" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === season;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setExtra({ season: opt.value })}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 5 — Activity */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(5)}>
            <Text style={styles.accordionHeaderText}>Activity</Text>
            <Text style={styles.accordionChevron}>{openSection === 5 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 5 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto", label: "Auto" },
                { value: "__football__", label: "— FOOTBALL —", divider: true },
                { value: "watching football in stadium",  label: "Watching football (in stadium)" },
                { value: "watching football at home",     label: "Watching football (at home / pub)" },
                { value: "playing football",              label: "Playing football" },
                { value: "match day socialising",         label: "Match day socialising" },
                { value: "__rugby__", label: "— RUGBY —", divider: true },
                { value: "watching rugby at ground",      label: "Watching rugby (at ground)" },
                { value: "watching rugby at home",        label: "Watching rugby (at home / pub)" },
                { value: "playing rugby",                 label: "Playing rugby" },
                { value: "match day socialising rugby",   label: "Match day socialising" },
                { value: "__othersport__", label: "— OTHER SPORT —", divider: true },
                { value: "at a sporting event",           label: "At a sporting event (spectator)" },
                { value: "playing sport",                 label: "Playing sport (general)" },
                { value: "__home__", label: "— AT HOME —", divider: true },
                { value: "reading",                       label: "Reading" },
                { value: "making coffee",                 label: "Making coffee / tea" },
                { value: "cooking",                       label: "Cooking" },
                { value: "baking",                        label: "Baking" },
                { value: "watching tv",                   label: "Watching TV" },
                { value: "listening to music",            label: "Listening to music" },
                { value: "relaxing on sofa",              label: "Relaxing on sofa" },
                { value: "photo editing",                 label: "Photo editing" },
                { value: "gaming",                        label: "Gaming" },
                { value: "decorating",                    label: "Decorating / tidying" },
                { value: "__food__", label: "— FOOD & DRINK —", divider: true },
                { value: "having coffee at a cafe",        label: "Having coffee at a cafe" },
                { value: "having a meal at a restaurant",  label: "Having a meal at a restaurant" },
                { value: "at the pub",                     label: "At the pub" },
                { value: "wine tasting",                   label: "Wine tasting" },
                { value: "whisky tasting",                 label: "Whisky tasting" },
                { value: "__culture__", label: "— CULTURE & LEISURE —", divider: true },
                { value: "visiting a museum",              label: "Visiting a museum" },
                { value: "visiting an art gallery",        label: "Visiting an art gallery" },
                { value: "watching live music",            label: "Watching live music / gig" },
                { value: "day trip",                       label: "Day trip / exploring" },
                { value: "walking",                        label: "Walking / hiking" },
                { value: "photography walk",               label: "Photography walk" },
                { value: "shopping",                       label: "Shopping" },
                { value: "__social__", label: "— SOCIAL —", divider: true },
                { value: "at a party",                     label: "At a party" },
                { value: "catching up with friends",       label: "Catching up with friends" },
                { value: "group night out",                label: "Group night out" },
                { value: "__cats__", label: "— WITH CATS —", divider: true },
                { value: "playing with dixie and nimbus",  label: "Playing with Dixie and Nimbus" },
                { value: "relaxing with dixie and nimbus", label: "Relaxing with Dixie and Nimbus" },
                { value: "feeding the cats",               label: "Feeding the cats" },
                { value: "taking photos of the cats",      label: "Taking photos of the cats" },
              ] as { value: string; label: string; divider?: boolean }[]).map((opt) => {
                if (opt.divider) {
                  return <Text key={opt.value} style={styles.accordionDivider}>{opt.label}</Text>;
                }
                const sel = opt.value === activity;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => handleActivitySelect(opt.value)}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {activityImpliedEnvNote ? (
            <Text style={styles.impliedEnvNote}>{activityImpliedEnvNote}</Text>
          ) : null}

          {/* SECTION 6 — Who Is In The Scene */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(6)}>
            <Text style={styles.accordionHeaderText}>Who Is In The Scene</Text>
            <Text style={styles.accordionChevron}>{openSection === 6 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 6 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",                label: "Auto (server decides — defaults to Ashley + Kane + cats)" },
                { value: "solo",                label: "Ashley only" },
                { value: "with-kane",           label: "Ashley + Kane" },
                { value: "with-cats",           label: "Ashley + Dixie and Nimbus (cats)" },
                { value: "with-kane-and-cats",  label: "Ashley + Kane + Dixie and Nimbus" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === occupancyDefault;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setOccupancyDefault(opt.value)}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 7 — Camera Mode (multi-select) */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(7)}>
            <Text style={styles.accordionHeaderText}>Camera Mode</Text>
            <Text style={styles.accordionHeaderHint}> (multi-select)</Text>
            <Text style={styles.accordionChevron}>{openSection === 7 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 7 && (
            <View style={styles.accordionBody}>
              <Text style={styles.accordionBodyHint}>
                Tick every mode that should be in the pool. Server picks from ticked options.
                Portrait and Selfie are unticked by default — tick them to enable.
              </Text>
              {([
                { value: "selfie",        label: "Selfie" },
                { value: "portrait",      label: "Portrait" },
                { value: "lifestyle",     label: "Lifestyle" },
                { value: "wide-room",     label: "Wide Angle" },
                { value: "architectural", label: "Architectural" },
                { value: "documentary",   label: "Documentary / Candid" },
                { value: "group-shot",    label: "Group Shot" },
                { value: "action",        label: "Action / Sport" },
                { value: "event",         label: "Event Photography" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = cameraSet.has(opt.value);
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => toggleCameraMode(opt.value)}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 8 — Shot Distance */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(8)}>
            <Text style={styles.accordionHeaderText}>Shot Distance</Text>
            <Text style={styles.accordionChevron}>{openSection === 8 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 8 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",           label: "Auto" },
                { value: "close-up",       label: "Close-Up" },
                { value: "half-body",      label: "Half Body" },
                { value: "full-body",      label: "Full Body" },
                { value: "wide-room",      label: "Wide Angle" },
                { value: "architectural",  label: "Architectural" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === shotDistance;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setExtra({ shotDistance: opt.value })}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* SECTION 9 — Camera Awareness */}
          <Pressable style={styles.accordionHeader} onPress={() => toggleSection(9)}>
            <Text style={styles.accordionHeaderText}>Camera Awareness</Text>
            <Text style={styles.accordionChevron}>{openSection === 9 ? "▲" : "▼"}</Text>
          </Pressable>
          {openSection === 9 && (
            <View style={styles.accordionBody}>
              {([
                { value: "auto",     label: "Auto" },
                { value: "unaware",  label: "Unaware (Ashley does not know camera is there)" },
                { value: "indirect", label: "Indirect (Ashley glancing toward camera)" },
                { value: "direct",   label: "Direct (Ashley looking at camera)" },
              ] as { value: string; label: string }[]).map((opt) => {
                const sel = opt.value === cameraAwareness;
                return (
                  <Pressable key={opt.value} style={styles.checkRow} onPress={() => setExtra({ cameraAwareness: opt.value })}>
                    <View style={[styles.checkbox, sel && styles.checkboxOn]}>
                      {sel && <Text style={styles.checkmark}>✓</Text>}
                    </View>
                    <Text style={styles.checkLabel}>{opt.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Reset button */}
          <Pressable style={styles.imgDefaultsResetBtn} onPress={resetImageDefaults}>
            <Text style={styles.imgDefaultsResetLabel}>Reset all to defaults</Text>
          </Pressable>

          {/* Generate test image */}
          <Pressable
            style={[styles.imgDefaultsResetBtn, { marginTop: 8, backgroundColor: colors.light.primary }]}
            onPress={() => { void onGenerateTestImage(); }}
            disabled={testImageLoading}
          >
            {testImageLoading
              ? <ActivityIndicator color="#fff" size="small" />
              : <Text style={[styles.imgDefaultsResetLabel, { color: "#fff" }]}>Generate test image</Text>
            }
          </Pressable>

          {testImageUrl ? (
            <View style={{ marginTop: 12 }}>
              <Pressable onPress={() => setTestImageZoomed(true)}>
                <Image
                  source={{ uri: testImageUrl }}
                  style={{ width: "100%", aspectRatio: 1, borderRadius: 8 }}
                  resizeMode="cover"
                />
              </Pressable>
              <Pressable
                style={[styles.imgDefaultsResetBtn, { marginTop: 8, backgroundColor: "#2a2a2a" }]}
                onPress={() => { void onSendToChat(); }}
                disabled={testImageSending}
              >
                {testImageSending
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={[styles.imgDefaultsResetLabel, { color: "#fff" }]}>Send to chat</Text>
                }
              </Pressable>
            </View>
          ) : null}

          <Modal
            visible={testImageZoomed}
            transparent
            animationType="fade"
            onRequestClose={() => setTestImageZoomed(false)}
          >
            <Pressable
              style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)", justifyContent: "center", alignItems: "center" }}
              onPress={() => setTestImageZoomed(false)}
            >
              {testImageUrl ? (
                <Image
                  source={{ uri: testImageUrl }}
                  style={{ width: "100%", aspectRatio: 1 }}
                  resizeMode="contain"
                />
              ) : null}
            </Pressable>
          </Modal>
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
  // Image defaults accordion styles
  imgDefaultsSummary: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 12,
    marginTop: 8,
    marginBottom: 4,
    lineHeight: 18,
  },
  accordionHeader: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.light.border,
    marginTop: 2,
  },
  accordionHeaderText: {
    flex: 1,
    color: colors.light.text,
    fontFamily: "Inter_600SemiBold",
    fontSize: 14,
  },
  accordionHeaderHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
  },
  accordionChevron: {
    color: colors.light.mutedForeground,
    fontSize: 11,
    marginLeft: 8,
  },
  accordionBody: {
    paddingVertical: 4,
    paddingLeft: 4,
    gap: 0,
  },
  accordionBodyHint: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_400Regular",
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 6,
    marginTop: 2,
  },
  accordionDivider: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_600SemiBold",
    fontSize: 11,
    marginTop: 10,
    marginBottom: 2,
    paddingLeft: 2,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 44,
    paddingVertical: 8,
    gap: 12,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.light.border,
    backgroundColor: colors.light.background,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  checkboxOn: {
    backgroundColor: colors.light.primary,
    borderColor: colors.light.primary,
  },
  checkmark: {
    color: "#fff",
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    lineHeight: 16,
  },
  checkLabel: {
    flex: 1,
    color: colors.light.text,
    fontFamily: "Inter_400Regular",
    fontSize: 13,
    lineHeight: 19,
  },
  imgDefaultsResetBtn: {
    marginTop: 14,
    alignSelf: "flex-start",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.light.border,
    backgroundColor: colors.light.muted,
  },
  imgDefaultsResetLabel: {
    color: colors.light.mutedForeground,
    fontFamily: "Inter_500Medium",
    fontSize: 13,
  },
  impliedEnvNote: {
    marginTop: 6,
    marginHorizontal: 4,
    fontSize: 12,
    fontFamily: "Inter_400Regular",
    color: colors.light.primary,
    fontStyle: "italic",
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
