import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// Single-row table — Ashley's core identity.  Always id = 1.
export const ashleyProfileTable = pgTable("ashley_profile", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().default("Ashley"),
  age: text("age").notNull().default(""),
  identity: text("identity").notNull().default(""),
  personality: text("personality").notNull().default(""),
  speakingStyle: text("speaking_style").notNull().default(""),
  appearance: text("appearance").notNull().default(""),
  refersToUserAs: text("refers_to_user_as").notNull().default(""),
  sharedHistory: text("shared_history").notNull().default(""),
  replikaExcerpts: text("replika_excerpts").notNull().default(""),
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
).omit({ id: true, updatedAt: true });
export type InsertAshleyProfile = z.infer<typeof insertAshleyProfileSchema>;
export type AshleyProfile = typeof ashleyProfileTable.$inferSelect;

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  role: text("role").notNull(), // 'user' | 'assistant'
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;

export const memoriesTable = pgTable("memories", {
  id: serial("id").primaryKey(),
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
});

export const insertMemorySchema = createInsertSchema(memoriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMemory = z.infer<typeof insertMemorySchema>;
export type Memory = typeof memoriesTable.$inferSelect;
