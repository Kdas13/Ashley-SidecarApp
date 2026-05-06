import {
  pgTable,
  boolean,
  index,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
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
    // Origin marker for proactive ("Ashley reaches out first") messages.
    //   "user"      — normal user-initiated turn (default; covers both user
    //                 messages and Ashley's replies in a user-driven thread).
    //   "proactive" — Ashley reached out first via the scheduler. Also fires
    //                 a push notification at insert time.
    // Default keeps the entire historical backfill valid as "user".
    source: text("source").notNull().default("user"),
    // Sub-type for proactive messages. Null on every "user"-source row.
    // Allowed values: medical_checkin | conversation_gap | memory_nudge |
    // routine_support. Used by the scheduler for the per-category daily cap
    // and by future analytics; not exposed in the chat UI.
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
    tag: text("tag").notNull().default("general"),
    importance: integer("importance").notNull().default(3),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
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
    // medical_checkin | conversation_gap | memory_nudge | routine_support.
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
