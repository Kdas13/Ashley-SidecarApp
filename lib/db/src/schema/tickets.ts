import {
  pgTable,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// =============================================================================
// Ashley Phase 2.5 — Conversational Ticket System
//
// Separate from the existing improvement_tickets / change_plans / approval_packets
// pipeline. This is the conversational layer: Ashley proposes issues, Kane
// approves them with APPROVE: TICKET_ID, and open tickets are injected into
// every system prompt so Ashley knows her own backlog.
//
// Status lifecycle (enforced server-side):
//   OPEN → APPROVED → IN_PROGRESS → RESOLVED
// No other transitions are valid.
//
// SAFETY INVARIANT: Ashley cannot resolve tickets or modify code. The
// APPROVE: gate and status transitions are enforced by the server, not
// by Ashley herself.
// =============================================================================

export const ashleyTicketsTable = pgTable("ashley_tickets", {
  ticketId: text("ticket_id").primaryKey(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),

  // OPEN | APPROVED | IN_PROGRESS | RESOLVED
  status: text("status").notNull().default("OPEN"),

  // low | medium | high
  severity: text("severity").notNull(),

  // PROMPT | CONFIG | MEMORY_POLICY | TOOLING | CODE_PATCH | DATA
  category: text("category").notNull(),

  // One-sentence description — must be exact for recurring-issue matching.
  summary: text("summary").notNull(),

  // Longer narrative of the problem.
  description: text("description"),

  // Why this matters to the user experience.
  impact: text("impact"),

  // What Ashley proposes should change.
  proposedFix: text("proposed_fix"),

  // user_feedback | self_detected | eval | error_log
  source: text("source").notNull(),

  // Who raised the ticket. Typically "Ashley" or "Kane".
  createdBy: text("created_by").notNull().default("Ashley"),

  // Approval fields — populated by POST /api/tickets/:id/approve.
  approved: boolean("approved").notNull().default(false),
  approvedBy: text("approved_by"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),

  // Resolution fields — populated when status moves to RESOLVED.
  resolutionNotes: text("resolution_notes"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export type AshleyTicket = typeof ashleyTicketsTable.$inferSelect;
export type InsertAshleyTicket = typeof ashleyTicketsTable.$inferInsert;
