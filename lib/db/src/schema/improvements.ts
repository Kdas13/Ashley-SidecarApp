import { pgTable, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// improvement_tickets
//
// Ashley Runtime writes tickets when it detects a problem (or when one arrives
// via user feedback / eval). Ashley Maintainer reads them to produce diagnoses.
//
// Neither system can modify production code, prompts, or deployment config —
// the ticket lifecycle ends at a human-readable report awaiting engineer action.
// ---------------------------------------------------------------------------

export const improvementTicketsTable = pgTable("improvement_tickets", {
  ticketId: text("ticket_id").primaryKey(),

  // Who raised the ticket.
  // Allowed: user_feedback | self_detected | eval | error_log
  source: text("source").notNull(),

  // What kind of fix would be needed.
  // Allowed: PROMPT | CONFIG | MEMORY_POLICY | TOOLING | CODE_PATCH | DATA | DO_NOT_AUTOFIX
  category: text("category").notNull(),

  // How urgent.
  // Allowed: low | medium | high
  severity: text("severity").notNull(),

  // One-sentence human-readable description of the problem.
  summary: text("summary").notNull(),

  // Array of supporting evidence objects — free-form JSONB.
  // e.g. [{ "turn": "...", "expected": "...", "actual": "..." }]
  evidence: jsonb("evidence").$type<unknown[]>().default([]),

  // How many times this failure has been observed.
  frequency: integer("frequency").default(1),

  // Which part of the system is suspect (e.g. "continuityGuard", "distillMemories").
  affectedComponent: text("affected_component"),

  // Representative conversation excerpt (plain text, no PII obligation — Kane controls this).
  sampleConversation: text("sample_conversation"),

  // Lifecycle state.
  // Allowed: new | triaged | diagnosed | awaiting_review | resolved | rejected
  status: text("status").notNull().default("new"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ImprovementTicket = typeof improvementTicketsTable.$inferSelect;
export type InsertImprovementTicket = typeof improvementTicketsTable.$inferInsert;
