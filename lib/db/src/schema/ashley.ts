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
