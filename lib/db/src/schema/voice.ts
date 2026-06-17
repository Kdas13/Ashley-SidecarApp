import {
  pgTable,
  index,
  integer,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

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
