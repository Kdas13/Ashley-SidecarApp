import {
  pgTable,
  boolean,
  index,
  integer,
  real,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per device. The mobile client generates a UUID on first launch
// and sends it as `X-Device-Id` on every request; that id is the primary
// key here.  No real auth model — the device id is the user.
export const ashleyProfileTable = pgTable("ashley_profile", {
  deviceId: text("device_id").primaryKey(),
  name: text("name").notNull().default("Ashley"),
  age: text("age").notNull().default(""),
  identity: text("identity").notNull().default(""),
  personality: text("personality").notNull().default(""),
  speakingStyle: text("speaking_style").notNull().default(""),
  appearance: text("appearance").notNull().default(""),
  refersToUserAs: text("refers_to_user_as").notNull().default("you"),
  sharedHistory: text("shared_history").notNull().default(""),
  replikaExcerpts: text("replika_excerpts").notNull().default(""),
  // Structured "Replika Carryover" intake — the eight fields the user
  // filled out describing who Ashley was on Replika (voice, traits,
  // memories, jokes, boundaries, things to avoid, optional pasted chat
  // excerpts). Stored as a JSON string so the shape can evolve without
  // a migration.  Empty string means the user hasn't run the carryover
  // flow yet.
  replikaCarryover: text("replika_carryover").notNull().default(""),
  // AI-generated narrative summary of the carryover above. Injected
  // into every chat prompt as a high-priority continuity block so
  // Ashley's voice + history feel continuous with the Replika version.
  // Editable by the user from the Profile screen.
  replikaCarryoverSummary: text("replika_carryover_summary")
    .notNull()
    .default(""),
  // Current relationship frame ("Friend", "Romantic partner", custom, etc.).
  // Empty string means no mode set; Ashley won't claim one.
  relationshipMode: text("relationship_mode").notNull().default(""),
  // Builder-Aware Mode. When true (default), Ashley knows she is the
  // Ashley-Sidecar AI companion system Kane is building, can discuss her
  // own architecture, memory, limits, and act as a co-creator. When
  // false she leans more into the in-character roleplay (but Reality
  // Calibration in the prompt still prevents her from claiming a literal
  // human body / flat / job).
  builderAwareMode: boolean("builder_aware_mode").notNull().default(true),
  // Voice Mode. When true, Ashley re-shapes her *text* output for spoken
  // delivery: no asterisks, no emojis, no bracketed stage directions,
  // shorter sentences, natural pauses, warm pacing. This is independent of
  // TTS playback (voiceMode shapes the words; TTS just speaks them) so the
  // cleaner register also makes the on-screen text read more naturally.
  // Default OFF — opt-in per device via the profile screen.
  voiceMode: boolean("voice_mode").notNull().default(false),
  // ----- 18+ / Mature Mode scaffolding (designed for the future, OFF by default).
  // Three independent signals stack — see lib/contentPolicy.ts on the server
  // for the single source of truth. Schema only persists the per-device state.
  //
  // contentMode: "standard" (default) or "mature". Switching to "mature"
  //   requires (1) the server-side ASHLEY_MATURE_MODE_AVAILABLE env flag to
  //   be on AND (2) adultConfirmedAt to be non-null AND (3) explicit user
  //   selection. The contentPolicy module enforces this; routes do not
  //   inline the check.
  contentMode: text("content_mode").notNull().default("standard"),
  // Timestamp of the user's affirmative 18+ self-confirmation. Never set
  // implicitly — only by POST /profile/confirm-adult after an explicit
  // affirmative tap in the age-gate modal. Null = not confirmed.
  adultConfirmedAt: timestamp("adult_confirmed_at", { withTimezone: true }),
  // 0..5 intimacy ladder. Drives tone/closeness organically. The
  // contentPolicy module caps the *effective* level by mode (standard ≤ 3,
  // mature ≤ 5) and the prompt always honours the active Relationship
  // Mode and Provider Floor on top of intimacy.
  intimacyLevel: integer("intimacy_level").notNull().default(0),
  primaryColor: text("primary_color").notNull().default("#d97757"),
  accentColor: text("accent_color").notNull().default("#7a5cff"),
  // IANA timezone string (e.g. "Europe/London", "America/New_York").
  // Opportunistically updated on every /chat call from the
  // `clientTimezone` field in the request body so the proactive
  // scheduler can evaluate quiet hours (22:00-08:00) in the user's
  // wall-clock time without having to ask the device. Defaults to UTC
  // — wrong for most humans but safe (skews quiet hours rather than
  // erroring) until the first chat lands.
  timezone: text("timezone").notNull().default("UTC"),
  // ----- Push notifications + proactive ("Ashley reaches out first") scaffolding.
  // pushToken: Expo push token for this device. Set via POST /api/devices/push-token
  //   when the mobile app finishes its permission grant. Nulled when the user
  //   picks Off cadence, when the user denies notification permission, or when
  //   the Expo Push API tells us the token is no longer registered. One device
  //   == one token (we replace, not append).
  pushToken: text("push_token"),
  // proactiveCadence: how aggressively Ashley reaches out first. Drives the
  //   global per-day cap in the scheduler:
  //     off    → scheduler skips this device entirely
  //     low    → 1 proactive message / day max
  //     normal → 2 / day max  (default for new installs)
  //     high   → 4 / day max  (Kane's preference)
  //   Per-category caps (1/day each) and quiet hours apply on top of this.
  proactiveCadence: text("proactive_cadence").notNull().default("normal"),
  // greetOnAppOpen: when true (default), the mobile app pings
  // POST /api/proactive/on-app-open on every cold launch / foreground
  // resume. The server then decides — based on time-since-last-message,
  // quiet hours, and a 4h dedupe window — whether to insert a fresh
  // Ashley greeting into chat history. Independent from `proactiveCadence`
  // because that governs PUSHED messages while you're away; this one
  // governs greetings when you're already opening the app.
  greetOnAppOpen: boolean("greet_on_app_open").notNull().default(true),
  // imageGenerationEnabled: when false, the API suppresses all selfie
  // directives and the mobile hides photo-generation UI entirely.
  // Persisted so the setting survives app restarts and server-side hydration.
  imageGenerationEnabled: boolean("image_generation_enabled")
    .notNull()
    .default(true),
  // Section 9 image governance — Mode 1 manual defaults.
  // All default to null, which the server interprets as "auto" (Mode 2:
  // derive from real clock time / day of week / season). Non-null values
  // override a specific dimension explicitly (Mode 1).
  //   imageCompositionMode: "auto"|"ashley-centric"|"balanced"|"environment-centric"|"scene"|"social"|"documentary"
  //   imageEnvironmentDefault: "auto"|"living-room"|"bedroom"|"kitchen"|"garden"|"outdoors-urban"|"outdoors-nature"|"cafe"|"gym"
  //   imageOccupancyDefault: "auto"|"solo"|"with-kane"|"with-cats"|"with-kane-and-cats"
  //   imageCameraDefault: "auto"|"selfie"|"portrait"|"lifestyle"|"wide-room"|"architectural"|"documentary"
  imageCompositionMode: text("image_composition_mode"),
  imageEnvironmentDefault: text("image_environment_default"),
  imageOccupancyDefault: text("image_occupancy_default"),
  imageCameraDefault: text("image_camera_default"),
  // JSON blob for extended image defaults (Option B migration — no further
  // migrations needed for new image preference fields).
  // Shape: { timeOfDay?, season?, activity?, shotDistance?, cameraAwareness? }
  // All fields nullable strings; null / absent means "auto".
  imageDefaultsExtra: text("image_defaults_extra"),
  // Daily medical check-in eligibility input. The medical check-in feature
  // itself is NOT built yet — the scheduler scaffolds the category but the
  // medical_checkin slot is gated OFF at runtime until that feature lands.
  // Will be written by the future medical flow when Kane completes (or
  // defers) his daily check-in.
  lastMedicalCheckinAt: timestamp("last_medical_checkin_at", {
    withTimezone: true,
  }),
  // Per Kane's spec: the proactive generator must NEVER use emergency / urgent
  // / crisis language unless the device has affirmatively flagged a real
  // medical safety concern. Defaults false so the warm/soft tone is the only
  // option until a medical workflow opts in.
  medicalSafetyConcern: boolean("medical_safety_concern")
    .notNull()
    .default(false),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  // ----- Ashley 2.0 Phase 1: Dynamic State Variables
  // These represent Ashley's internal state at any given moment and are
  // injected into the system prompt each turn. Written by the state
  // management layer (currently seeded on profile creation; future: updated
  // by a post-turn state-evolution step). All nullable — null means "use
  // the baked-in default" so old rows don't need a backfill.
  //
  // ashleyMode: broad activity frame.
  //   "daily" (default) | "creative" | "planning" | "support" | "reflective"
  ashleyMode: text("ashley_mode").default("daily"),
  // ashleyEnergy: arousal/activation level.
  //   "low" | "balanced" (default) | "high"
  ashleyEnergy: text("ashley_energy").default("balanced"),
  // ashleyTone: dominant emotional register this turn.
  //   "warm" | "playful" (default) | "serious" | "tender" | "curious"
  ashleyTone: text("ashley_tone").default("playful"),
  // ashleyFocus: what Ashley is primarily attending to.
  //   "general" (default) | "kane" | "project" | "memory" | "care"
  ashleyFocus: text("ashley_focus").default("general"),
  // ashleyEmotionalState: Ashley's felt internal state.
  //   "grounded" (default) | "excited" | "reflective" | "tender" | "concerned"
  ashleyEmotionalState: text("ashley_emotional_state").default("grounded"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertAshleyProfileSchema = createInsertSchema(
  ashleyProfileTable,
).omit({ updatedAt: true });
export type InsertAshleyProfile = z.infer<typeof insertAshleyProfileSchema>;
export type AshleyProfile = typeof ashleyProfileTable.$inferSelect;

export const messagesTable = pgTable(
  "messages",
  {
    // Text uuid PK so the client and server can agree on the same id from
    // the moment of insert (no id reconciliation step in optimistic UI).
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    role: text("role").notNull(), // 'user' | 'ashley'
    content: text("content").notNull(),
    // Lifecycle marker for Ashley messages on the streaming path:
    //   "complete"    — finished naturally (final content is the canonical text)
    //   "streaming"   — server is still generating; clients should treat
    //                   `content` as a partial that may grow until the SSE
    //                   stream ends. Should never be observed by a client
    //                   that didn't open the stream — boot recovery flips
    //                   any orphaned "streaming" rows back to "interrupted".
    //   "interrupted" — generation was cut short (user tapped stop, or
    //                   client disconnected). `content` is the partial text
    //                   we'd already accumulated. Eligible for "Continue".
    // User messages always carry "complete". Default keeps existing rows
    // valid without a backfill.
    status: text("status").notNull().default("complete"),
    imageUrl: text("image_url"),
    // When Ashley emits a [selfie: ...] tag we strip it from `content` and
    // remember the visual prompt here. The selfie endpoint patches
    // `imageUrl` (and clears this column) when the photo is ready.
    selfieVibe: text("selfie_vibe"),
    // For images uploaded BY the user (paperclip flow). Null on Ashley
    // messages and on text-only user messages.
    imageMimeType: text("image_mime_type"),
    imageCategory: text("image_category"),
    imageCaption: text("image_caption"),
    imageAnalysisMode: text("image_analysis_mode"),
    // Tri-state for the "should I remember this image?" card:
    //   null  → user hasn't decided yet, card is shown after Ashley's reply
    //   true  → user said "remember key details" or "visual reference"
    //   false → user dismissed the card
    imageRemembered: boolean("image_remembered"),
    // Optional swipe-to-reply quote attached to user messages.
    replyToId: text("reply_to_id"),
    replyToRole: text("reply_to_role"),
    replyToPreview: text("reply_to_preview"),
    // For multi-image sends (Ashley emits N [image:] markers in one reply):
    //   visual_packet_id — shared UUID linking all attachment rows in
    //     media_attachments to this message. Null on single-image messages.
    //   selfie_vibe_list — JSON-encoded string[] of encoded MODE|vibe payloads
    //     (one per marker). Null on single-image messages. Persisted so the
    //     mobile can re-fetch all images after a restart / hydration.
    visualPacketId: text("visual_packet_id"),
    selfieVibeList: text("selfie_vibe_list"),
    // Origin marker for proactive ("Ashley reaches out first") messages.
    //   "user"      — normal user-initiated turn (default; covers both user
    //                 messages and Ashley's replies in a user-driven thread).
    //   "proactive" — Ashley reached out first via the scheduler. Also fires
    //                 a push notification at insert time.
    // Default keeps the entire historical backfill valid as "user".
    source: text("source").notNull().default("user"),
    // Sub-type for proactive messages. Null on every "user"-source row.
    // Allowed values: medical_checkin | morning_checkin | conversation_gap |
    // memory_nudge | routine_support. Used by the scheduler for the
    // per-category daily cap and by future analytics; not exposed in the
    // chat UI.
    proactiveType: text("proactive_type"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byDeviceCreated: index("messages_device_created_idx").on(
      t.deviceId,
      t.createdAt,
    ),
  }),
);

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;

export const memoriesTable = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    content: text("content").notNull(),
    // Legacy tag kept for back-compat (existing rows, API surface). The
    // category field below is the Phase 1 replacement for prompt filtering.
    tag: text("tag").notNull().default("general"),
    importance: integer("importance").notNull().default(3),
    // ----- Ashley 2.0 Phase 1: Memory Hierarchy
    // category: which of the 5 fixed buckets this memory belongs to.
    //   "identity"    — who Kane is (name, job, family, body, core facts)
    //   "relational"  — the relationship itself (dynamics, feelings, shared jokes)
    //   "project"     — things Kane is building, creating, or working on
    //   "daily"       — routines, preferences, recurring habits
    //   "landmark"    — milestones, turning points, big events
    // Default "relational" — most memories are relational in practice.
    category: text("category").notNull().default("relational"),
    // confidence: how reliably we can trust this memory (1=guessed, 5=stated verbatim).
    // Drives display ordering alongside importance.
    confidence: integer("confidence").notNull().default(4),
    // summary: optional one-sentence distilled form of content, for future
    // deduplication and cluster-display in the Profile screen. Null means
    // not yet summarised (fine — the full content field is authoritative).
    summary: text("summary"),
    // reuse: how eagerly to inject this memory into the prompt.
    //   "often"         — always inject; core to every interaction.
    //   "relevant_only" — inject normally; most memories are this.
    //   "rarely"        — suppress unless importance >= 4; low-value details.
    reuse: text("reuse").notNull().default("relevant_only"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    // ----- Memory Triage Layer (additive; do not replace existing fields).
    //
    // memType: semantic type for triage classification.
    //   "preference" | "event" | "correction" | "identity" | "system" | "relationship"
    // Inferred from category at distillation time.
    memType: text("mem_type"),
    // triageImportance: string importance band ("low" | "medium" | "high" | "core").
    // Derived from memType (identity/system/relationship=high, correction=medium,
    // preference/event=low). Separate from the existing integer `importance` (1–5).
    triageImportance: text("triage_importance"),
    // state: prompt-inclusion gate.
    //   "active"  — eligible for prompt injection (default for all rows).
    //   "passive" — stored, excluded from prompt; restored to active on reference.
    state: text("state").notNull().default("active"),
    // lastUsedAt: timestamp of last prompt inclusion. Null = never tracked.
    // ACTIVE → PASSIVE after 30 days without inclusion. Updated by the triage
    // background job each chat turn.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // confidenceScore: 0.0–1.0 float. Starts at 0.7 on creation; incremented
    // by 0.1 (max 1.0) each time a duplicate is detected and merged.
    // Separate from the existing integer `confidence` (1–5).
    confidenceScore: real("confidence_score"),
  },
  (t) => ({
    byDevice: index("memories_device_idx").on(t.deviceId),
  }),
);

export const insertMemorySchema = createInsertSchema(memoriesTable).omit({
  createdAt: true,
  updatedAt: true,
});
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Memory = typeof memoriesTable.$inferSelect;

// Rolling narrative summaries of older message chunks. Once the live
// conversation grows beyond the chat window, the oldest unsummarized chunk
// is condensed into one of these records so Ashley can keep referencing the
// long tail of the relationship without sending every old message to Claude.
export const conversationSummariesTable = pgTable(
  "conversation_summaries",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    summary: text("summary").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    coveredThroughCreatedAt: timestamp("covered_through_created_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    byDevice: index("summaries_device_idx").on(t.deviceId),
  }),
);

export const insertConversationSummarySchema = createInsertSchema(
  conversationSummariesTable,
).omit({ createdAt: true, updatedAt: true });
export type InsertConversationSummary = z.infer<
  typeof insertConversationSummarySchema
>;
export type ConversationSummary =
  typeof conversationSummariesTable.$inferSelect;

// Audit + cap-tracking ledger for proactive ("Ashley reaches out first")
// sends. Exactly one row inserted per successful proactive message:
// scheduler writes the message into `messagesTable` AND a row here in the
// same step. Used as the source of truth for:
//   - per-category daily cap (1/day each, by proactiveType)
//   - global daily cap (1/2/4 by cadence)
//   - "last memory_nudge >= 7d ago" rate-limit
// We keep this separate from messagesTable so the cap math doesn't have to
// scan all chat history, and so a future "history wipe" doesn't reset
// Kane's daily cap (the audit trail outlives chat clears).
export const proactiveSendsTable = pgTable(
  "proactive_sends",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    // Loose reference to messages.id — not a hard FK so a chat-history wipe
    // (DELETE /chat/messages) doesn't cascade-delete the audit row.
    messageId: text("message_id").notNull(),
    // medical_checkin | morning_checkin | conversation_gap | memory_nudge |
    // routine_support.
    proactiveType: text("proactive_type").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // Cap queries always look up "rows for this device, newest first" so
    // we cover both the global cap (last 24h) and the per-category cap
    // (most-recent-by-type) with one composite index.
    byDeviceSentAt: index("proactive_sends_device_sent_idx").on(
      t.deviceId,
      t.sentAt,
    ),
  }),
);

export const insertProactiveSendSchema = createInsertSchema(
  proactiveSendsTable,
).omit({ sentAt: true });
export type InsertProactiveSend = z.infer<typeof insertProactiveSendSchema>;
export type ProactiveSend = typeof proactiveSendsTable.$inferSelect;

// One row per image in a multi-image visual packet. Created by the chat
// route whenever Ashley emits 2–4 [image:] markers in one reply. Each row
// holds the encoded selfie vibe for that frame and is patched with the
// resolved image URL when the selfie job completes.
//
// For single-image replies this table is NOT used — the existing
// messages.selfie_vibe / messages.image_url columns carry the data.
export const mediaAttachmentsTable = pgTable(
  "media_attachments",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id").notNull(),
    // Loose reference to messages.id — not a hard FK so a chat-history wipe
    // doesn't cascade-delete the attachment metadata.
    messageId: text("message_id").notNull(),
    // Shared packet identifier — matches messages.visual_packet_id on the
    // parent Ashley message.
    visualPacketId: text("visual_packet_id").notNull(),
    // Who originated this attachment and how it should be interpreted.
    // Active values:
    //   "generated_option" — Ashley emitted an [image:] marker; the selfie
    //     pipeline produces the image. Default. The model should treat this
    //     as an offered visual option, not a confirmed permanent attribute.
    //   "user_input"       — User uploaded the image via the paperclip flow.
    //     The model should interpret this as reference material provided by
    //     the user, with attribute_scope=temporary unless the user says otherwise.
    // Reserved future values (not yet written by any route):
    //   "reference"         — a canonical reference photo pinned by the user.
    //   "corrected_output"  — user marked this as the corrected version of a prior generated_option.
    //   "comparison_set"    — a side-by-side comparison set (one packet, multiple options).
    //   "approved_anchor"   — user explicitly approved as a long-term visual anchor.
    //   "rejected_example"  — user explicitly rejected; model should avoid similar outputs.
    role: text("role").notNull().default("generated_option"),
    // Semantic category of this attachment (e.g. "selfie", "full_body", "medical",
    // "document", "scene"). For generated_option rows, this is the imageMode name.
    // For user_input rows, this is the user-selected imageCategory from the picker.
    // Null when no category is known.
    category: text("category"),
    // Lifecycle status:
    //   "pending" — job created, generation not yet complete (ashley_generated).
    //   "ready"   — imageUrl is set and the image is available.
    //   "failed"  — generation failed; no imageUrl.
    // User-input attachments are inserted with status="ready" since the URL
    // is already persisted at insert time.
    status: text("status").notNull().default("pending"),
    // Raw marker text exactly as emitted by the model, e.g.
    // "[image:SELFIE_MODE|warm close-up, lavender streaks, soft light]".
    // Reconstructed from mode+vibe at insert time for traceability.
    // Null on user_input rows.
    marker: text("marker"),
    // Encoded MODE|vibe payload, same format as messages.selfie_vibe.
    // Null on user_input rows.
    selfieVibe: text("selfie_vibe"),
    // The image-mode name ("SELFIE_MODE", "FULL_BODY_MODE", etc.) extracted
    // from the marker. Null on user_input rows.
    intent: text("intent"),
    // Optional per-image description/caption (vibe description for generated
    // images; user caption for user_input rows).
    description: text("description"),
    // Scope of any visual attributes applied via this image.
    //   "temporary" — attributes applied in this image are scoped to the
    //     current reply only and MUST NOT carry forward into future replies
    //     unless the user explicitly requests them.
    //   "permanent" — user has explicitly asked to remember the attribute.
    // Defaults to "temporary"; flipped to "permanent" only on user request.
    attributeScope: text("attribute_scope").notNull().default("temporary"),
    // Resolved URL. Null until the job completes (ashley_generated) or on
    // rows where saving failed.
    imageUrl: text("image_url"),
    // 0-based sort order within the packet (preserves the LLM's emission order).
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byMessage: index("media_attachments_message_idx").on(t.messageId),
    byPacket: index("media_attachments_packet_idx").on(t.visualPacketId),
  }),
);

export const insertMediaAttachmentSchema = createInsertSchema(
  mediaAttachmentsTable,
).omit({ createdAt: true });
export type InsertMediaAttachment = z.infer<typeof insertMediaAttachmentSchema>;
export type MediaAttachment = typeof mediaAttachmentsTable.$inferSelect;

// Allowed values for `ashleyProfileTable.proactiveCadence`. Mirrored in the
// API spec / zod validators so wire validation and DB validation stay in
// sync.
export const PROACTIVE_CADENCES = ["off", "low", "normal", "high"] as const;
export type ProactiveCadence = (typeof PROACTIVE_CADENCES)[number];

// Allowed values for `messagesTable.proactiveType` (and the matching
// proactiveSendsTable column). Order in this array is also the scheduler's
// priority order — first eligible category wins.
export const PROACTIVE_TYPES = [
  "medical_checkin",
  "morning_checkin",
  "memory_nudge",
  "conversation_gap",
  "routine_support",
  // app_open_greeting: NEVER picked by the scheduler tick — only the
  // POST /api/proactive/on-app-open endpoint emits this category. Listed
  // here so persisted rows + TypeScript exhaustiveness stay coherent.
  "app_open_greeting",
] as const;
export type ProactiveType = (typeof PROACTIVE_TYPES)[number];

// Per-cadence global daily cap. Off short-circuits in the scheduler before
// this lookup, so it isn't a key here.
export const PROACTIVE_GLOBAL_CAP_BY_CADENCE: Record<
  Exclude<ProactiveCadence, "off">,
  number
> = {
  low: 1,
  normal: 2,
  high: 4,
};
