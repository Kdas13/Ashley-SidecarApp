import {
  pgTable,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";

// =============================================================================
// Ashley Self-Improvement Schema — Stage 2.5
//
// Tables in lifecycle order:
//   improvement_tickets  → evidence_items  → change_plans
//   → approval_packets   → approval_queue  → change_journal
//
// Red flags and protected rules sit outside the main flow.
//
// SAFETY INVARIANT: Nothing in this schema can trigger code execution,
// deployment, or secret access. These tables record intent and decisions.
// A human on a PC acts on them. The DB cannot patch itself.
// =============================================================================

// ---------------------------------------------------------------------------
// improvement_tickets
// ---------------------------------------------------------------------------
// Status values (Stage 2.5 superset):
//   new → triaged → planned → awaiting_approval
//   → approved | rejected | needs_more_explanation
//   → approved_waiting_for_execution → queued_for_pc_execution
//
// NOT included yet: merged | deployed | rolled_back | live (Stage 2 PC states)

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

  // What actually happened (narrative, Stage 2.5 addition).
  whatHappened: text("what_happened"),

  // Why this matters to the user experience (Stage 2.5 addition).
  whyItMatters: text("why_it_matters"),

  // Array of evidence_id references.
  evidence: jsonb("evidence").$type<string[]>().default([]),

  // How many times this failure has been observed.
  frequency: integer("frequency").default(1),

  // Which part of the system is suspect (e.g. "continuityGuard", "distillMemories").
  affectedComponent: text("affected_component"),

  // Representative conversation excerpt.
  sampleConversation: text("sample_conversation"),

  // Lifecycle state (see allowed values above).
  status: text("status").notNull().default("new"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ImprovementTicket = typeof improvementTicketsTable.$inferSelect;
export type InsertImprovementTicket = typeof improvementTicketsTable.$inferInsert;

// ---------------------------------------------------------------------------
// evidence_items
// ---------------------------------------------------------------------------

export const evidenceItemsTable = pgTable("evidence_items", {
  evidenceId: text("evidence_id").primaryKey(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => improvementTicketsTable.ticketId, { onDelete: "cascade" }),

  // conversation_snippet | log_excerpt | user_report | eval_result
  type: text("type").notNull(),

  // One-sentence description of what this evidence shows.
  summary: text("summary").notNull(),

  // The raw excerpt or data (plain text, no PII obligation).
  snippet: text("snippet"),

  // Optional reference to the conversation or log that produced it.
  sourceRef: text("source_ref"),

  // normal | sensitive — sensitive items are included in reports but flagged.
  sensitivity: text("sensitivity").notNull().default("normal"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EvidenceItem = typeof evidenceItemsTable.$inferSelect;

// ---------------------------------------------------------------------------
// change_plans
// ---------------------------------------------------------------------------
// Drafted by Ashley Maintainer from a ticket. The plan describes WHAT should
// change and WHY — it does not contain code, diffs, or deployment steps.
//
// Status: draft | policy_checked | blocked | ready_for_approval

export const changePlansTable = pgTable("change_plans", {
  planId: text("plan_id").primaryKey(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => improvementTicketsTable.ticketId, { onDelete: "cascade" }),

  // Mirrors the ticket category — what kind of change this is.
  changeType: text("change_type").notNull(),

  // low | medium | high
  risk: text("risk").notNull(),

  // One paragraph — what is causing this problem.
  rootCause: text("root_cause").notNull(),

  // One paragraph — what should be different after the fix.
  proposedChange: text("proposed_change").notNull(),

  // What gets better.
  expectedUpside: text("expected_upside").notNull(),

  // What could go wrong.
  possibleDownside: text("possible_downside").notNull(),

  // Does applying this change require a database migration?
  requiresMigration: boolean("requires_migration").notNull().default(false),

  // Was a protected area referenced? If true, plan is blocked.
  blockedByPolicy: boolean("blocked_by_policy").notNull().default(false),

  // Plain-English description of how to undo this change if it goes wrong.
  rollbackMethod: text("rollback_method"),

  // draft | ready_for_approval | blocked
  status: text("status").notNull().default("draft"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ChangePlan = typeof changePlansTable.$inferSelect;

// ---------------------------------------------------------------------------
// approval_packets
// ---------------------------------------------------------------------------
// Human-readable summary of a change plan, structured for mobile display.
// Contains the decision card Kane sees on his phone.
//
// Status: awaiting_approval | approved | rejected | needs_more_explanation

export const approvalPacketsTable = pgTable("approval_packets", {
  packetId: text("packet_id").primaryKey(),
  ticketId: text("ticket_id")
    .notNull()
    .references(() => improvementTicketsTable.ticketId, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => changePlansTable.planId, { onDelete: "cascade" }),

  // low | medium | high — copied from plan for quick display
  risk: text("risk").notNull(),

  // JSONB blob matching the HumanSummary shape — what Kane sees in the card.
  humanSummary: jsonb("human_summary")
    .$type<{
      what_went_wrong: string;
      what_ashley_wants_to_change: string;
      why_this_should_help: string;
      what_could_go_wrong: string;
      what_happens_if_approved: string;
      what_happens_if_rejected: string;
    }>()
    .notNull(),

  // awaiting_approval | approved | rejected | needs_more_explanation
  status: text("status").notNull().default("awaiting_approval"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ApprovalPacket = typeof approvalPacketsTable.$inferSelect;

// ---------------------------------------------------------------------------
// approval_queue
// ---------------------------------------------------------------------------
// Items Kane has approved that are waiting for PC-side execution.
// This table is written when Kane approves a packet. Nothing in the API
// reads this table to trigger execution — a PC-side process does that in Stage 2.

export const approvalQueueTable = pgTable("approval_queue", {
  queueId: text("queue_id").primaryKey(),
  packetId: text("packet_id")
    .notNull()
    .references(() => approvalPacketsTable.packetId, { onDelete: "cascade" }),
  planId: text("plan_id").notNull(),
  ticketId: text("ticket_id").notNull(),

  approvedBy: text("approved_by").notNull().default("Kane"),
  approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),

  // approved_waiting_for_execution | queued_for_pc_execution
  executionStatus: text("execution_status")
    .notNull()
    .default("approved_waiting_for_execution"),

  // Always true in Stage 2.5 — no mobile execution.
  pcRequired: boolean("pc_required").notNull().default(true),

  notes: text("notes"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ApprovalQueueItem = typeof approvalQueueTable.$inferSelect;

// ---------------------------------------------------------------------------
// change_journal
// ---------------------------------------------------------------------------
// Permanent, append-only audit trail. Every decision (approve/reject/
// needs_more_explanation) writes a row here. Rows are never deleted.

export const changeJournalTable = pgTable("change_journal", {
  journalId: text("journal_id").primaryKey(),

  ticketId: text("ticket_id").notNull(),
  planId: text("plan_id"),
  packetId: text("packet_id"),

  // approve | reject | explain_more | show_evidence | policy_block
  decision: text("decision").notNull(),

  // Kane | system | maintainer
  decidedBy: text("decided_by").notNull().default("Kane"),

  decisionNotes: text("decision_notes"),

  // The ticket status after this decision.
  finalStatus: text("final_status").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChangeJournalEntry = typeof changeJournalTable.$inferSelect;

// ---------------------------------------------------------------------------
// red_flag_reports
// ---------------------------------------------------------------------------
// Created when a ticket or plan references a protected area. These are never
// progressed through the normal flow — they require human review.

export const redFlagReportsTable = pgTable("red_flag_reports", {
  redFlagId: text("red_flag_id").primaryKey(),
  sourceTicketId: text("source_ticket_id").notNull(),

  // Which protected category was hit (e.g. "auth", "approval logic").
  blockedCategory: text("blocked_category"),

  // Which protected path was hit (e.g. "/approval/").
  blockedPath: text("blocked_path"),

  // Why this was blocked.
  reason: text("reason").notNull(),

  // Plain English for Kane.
  humanSummary: text("human_summary").notNull(),

  // blocked_needs_human_review | acknowledged
  status: text("status").notNull().default("blocked_needs_human_review"),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type RedFlagReport = typeof redFlagReportsTable.$inferSelect;

// ---------------------------------------------------------------------------
// protected_rules
// ---------------------------------------------------------------------------
// Read-only reference table. Seeded at startup from the hard-coded list in
// maintainerService.ts. Never written by Ashley Runtime or Maintainer.
// Kane can read this via GET /improvements/protected-rules to see exactly
// what is protected and why.

export const protectedRulesTable = pgTable("protected_rules", {
  ruleId: text("rule_id").primaryKey(),

  // path | category
  ruleType: text("rule_type").notNull(),

  // The exact string that triggers a block (e.g. "/auth/", "billing").
  value: text("value").notNull(),

  // Why this is protected.
  description: text("description").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProtectedRule = typeof protectedRulesTable.$inferSelect;
