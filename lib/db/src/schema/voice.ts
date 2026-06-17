import {
  pgTable,
  index,
  integer,
  text,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// P1-1: Active voice sessions (recovery table)
// ---------------------------------------------------------------------------

export const activeSessionsTable = pgTable(
  "active_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    deviceId: text("device_id").notNull(),
    connectionGeneration: integer("connection_generation").notNull().default(0),
    state: text("state").notNull(),
    currentTurnId: text("current_turn_id"),
    currentResponseId: text("current_response_id"),
    callStartTime: timestamp("call_start_time", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_active_sessions_state").on(t.state),
    index("idx_active_sessions_device_id").on(t.deviceId),
  ],
);

// ---------------------------------------------------------------------------
// P1-2: End-of-call summarisation tables
// ---------------------------------------------------------------------------

export const callSummariesTable = pgTable(
  "call_summaries",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id").notNull(),
    version: integer("version").notNull().default(1),
    // status: 'committed' | 'pending_review' | 'superseded'
    status: text("status").notNull().default("pending_review"),
    topic: text("topic"),
    tone: text("tone"),
    openItems: jsonb("open_items").notNull().default([]),
    summaryText: text("summary_text").notNull(),
    confidenceScore: integer("confidence_score").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp("committed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_call_summaries_session").on(t.sessionId),
    index("idx_call_summaries_status").on(t.status),
  ],
);

export const callDecisionsTable = pgTable(
  "call_decisions",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    sessionId: text("session_id").notNull(),
    summaryId: text("summary_id")
      .notNull()
      .references(() => callSummariesTable.id, { onDelete: "cascade" }),
    turnId: text("turn_id").notNull(),
    // decisionType: 'action' | 'commitment' | 'preference' | 'question'
    decisionType: text("decision_type").notNull(),
    description: text("description").notNull(),
    resolved: boolean("resolved").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_call_decisions_session").on(t.sessionId),
  ],
);

// Recovery queue — one row per session, UNIQUE on session_id.
// onConflictDoUpdate resets status to 'pending' on retry.
export const summarisationJobsTable = pgTable(
  "summarisation_jobs",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull().unique(),
    // status: 'pending' | 'running' | 'complete' | 'failed'
    status: text("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_summarisation_jobs_session").on(t.sessionId),
  ],
);
