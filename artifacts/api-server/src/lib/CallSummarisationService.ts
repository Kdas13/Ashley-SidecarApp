// ---------------------------------------------------------------------------
// CallSummarisationService — P1-2 End-of-Call Summarisation
//
// Fire-and-forget. The call pipeline must never block on this.
// A job row is written before the async work begins so the run is
// recoverable if the process dies mid-flight.
//
// Adaptations from brief:
//   - callLLM → generateChatText (forceProvider: "anthropic" for structured JSON)
//   - turns are fetched from messagesTable (not session memory — they aren't
//     stored on VoiceSession). summariseCall() accepts deviceId + callStartTime
//     instead of a pre-built turns array.
// ---------------------------------------------------------------------------

import {
  db,
  messagesTable,
  callSummariesTable,
  callDecisionsTable,
  summarisationJobsTable,
} from "@workspace/db";
import { generateChatText } from "./textLLM";
import { eq, inArray, and, gte, asc, desc } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface ICallDecision {
  turnId: string;
  decisionType: "action" | "commitment" | "preference" | "question";
  description: string;
  resolved: boolean;
}

export interface ICallSummary {
  topic: string;
  tone: string;
  openItems: string[];
  summaryText: string;
  confidenceScore: number;
  decisions: ICallDecision[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CallSummarisationService {
  /**
   * Main entry point. Fire-and-forget — do NOT await.
   *
   * Fetches voice call turns from the DB (source='voice_call', createdAt >=
   * callStartTime), then runs the LLM summarisation pipeline asynchronously.
   * All errors are caught internally; the call pipeline is never affected.
   */
  static summariseCall(
    sessionId: string,
    deviceId: string,
    callStartTime: Date,
  ): void {
    void (async () => {
      const jobId = crypto.randomUUID();
      const now = new Date();
      const log = `[CallSummarisationService] [session=${sessionId}] [job=${jobId}]`;

      // STEP 1: Write job record before starting async work.
      // If this write fails, abort — nothing else is safe to attempt.
      try {
        await db
          .insert(summarisationJobsTable)
          .values({
            id: jobId,
            sessionId,
            status: "pending",
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: summarisationJobsTable.sessionId,
            set: {
              status: "pending",
              updatedAt: now,
            },
          });
      } catch (err) {
        console.error(`${log} Failed to write job record — aborting:`, err);
        return;
      }

      try {
        // STEP 2: Transition to 'running'.
        await db
          .update(summarisationJobsTable)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(summarisationJobsTable.sessionId, sessionId));

        // STEP 3: Fetch voice call turns from messagesTable.
        // source='voice_call' scopes to this call; createdAt >= callStartTime
        // prevents picking up turns from earlier calls on the same device.
        const rows = await db
          .select()
          .from(messagesTable)
          .where(
            and(
              eq(messagesTable.deviceId, deviceId),
              eq(messagesTable.source, "voice_call"),
              gte(messagesTable.createdAt, callStartTime),
            ),
          )
          .orderBy(asc(messagesTable.createdAt));

        // Map DB rows to ConversationTurn. Voice messages use role="ashley"
        // for assistant turns; normalise to "assistant" for the LLM prompt.
        const allTurns: ConversationTurn[] = rows.map((r) => ({
          id: r.id,
          sessionId,
          role: r.role === "user" ? "user" : "assistant",
          content: r.content,
          createdAt: r.createdAt,
        }));

        // Exclude system turns (none expected from voice, but guard anyway).
        const filteredTurns = allTurns.filter(
          (t) => t.role === "user" || t.role === "assistant",
        );

        // Guard: no meaningful content.
        if (filteredTurns.length === 0) {
          console.warn(
            `${log} No user/assistant turns found — writing placeholder summary.`,
          );
          await this.writeDefaultPlaceholderSummary(sessionId, log);
          await db
            .update(summarisationJobsTable)
            .set({ status: "complete", updatedAt: new Date() })
            .where(eq(summarisationJobsTable.sessionId, sessionId));
          return;
        }

        // Cap at last 150 turns.
        const cappedTurns = filteredTurns.slice(-150);

        // STEP 4: Short call bypass — skip confidence scoring, pre-set 100.
        let preSetConfidence: number | null = null;
        if (cappedTurns.length < 4) {
          preSetConfidence = 100;
          console.info(
            `${log} Short call (${cappedTurns.length} turns) — confidence pre-set to 100.`,
          );
        }

        // STEP 5: Build prompt and call LLM.
        const transcriptText = cappedTurns
          .map((t) => `${t.role.toUpperCase()} (ID: ${t.id}): ${t.content}`)
          .join("\n");

        const systemPrompt = [
          "You are summarising a completed voice dialogue session.",
          "Return ONLY a valid JSON payload. No preamble, no markdown fences.",
          "",
          "Required JSON shape:",
          "{",
          '  "topic": "Brief conversation subject string",',
          '  "tone": "Evaluated tone of the speaker",',
          '  "open_items": ["Array of outstanding questions or next steps"],',
          '  "summary_text": "Detailed structural summary paragraph",',
          '  "confidence_score": 100,',
          '  "decisions": [',
          "    {",
          '      "turn_id": "exact ID of the turn where this was established",',
          '      "decision_type": "action | commitment | preference | question",',
          '      "description": "Details of the identified item",',
          '      "resolved": false',
          "    }",
          "  ]",
          "}",
        ].join("\n");

        // forceProvider: "anthropic" — structured JSON output; reliability matters.
        const rawJsonString = await generateChatText({
          system: systemPrompt,
          messages: [{ role: "user", content: `TRANSCRIPT:\n${transcriptText}` }],
          maxTokens: 2048,
          forceProvider: "anthropic",
        });

        // STEP 6: Parse and validate.
        const parsedSummary = this.parseAndSanitizeJSON(rawJsonString, log);

        // Apply confidence bounds.
        if (preSetConfidence !== null) {
          parsedSummary.confidenceScore = preSetConfidence;
        } else {
          parsedSummary.confidenceScore = Math.max(
            0,
            Math.min(100, parsedSummary.confidenceScore),
          );
        }

        // STEP 7: Write to DB inside a transaction.
        await this.writeSummary(sessionId, parsedSummary);

        // STEP 8: Mark complete.
        await db
          .update(summarisationJobsTable)
          .set({ status: "complete", updatedAt: new Date() })
          .where(eq(summarisationJobsTable.sessionId, sessionId));

        console.info(`${log} Summarisation complete.`);
      } catch (err) {
        console.error(`${log} Pipeline failed:`, err);
        try {
          await db
            .update(summarisationJobsTable)
            .set({ status: "failed", updatedAt: new Date() })
            .where(eq(summarisationJobsTable.sessionId, sessionId));
        } catch (dbErr) {
          console.error(`${log} Critical: failed to mark job as failed:`, dbErr);
        }
      }
    })();
  }

  /**
   * Transactional DB writer. Supersedes any existing summary for this session,
   * inserts a new pending_review row, then writes associated decisions.
   */
  private static async writeSummary(
    sessionId: string,
    summary: ICallSummary,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      // Step A: Supersede all existing committed/pending_review rows.
      await tx
        .update(callSummariesTable)
        .set({ status: "superseded" })
        .where(
          and(
            eq(callSummariesTable.sessionId, sessionId),
            inArray(callSummariesTable.status, ["committed", "pending_review"]),
          ),
        );

      // Step B: Determine next version number.
      const existing = await tx
        .select({ version: callSummariesTable.version })
        .from(callSummariesTable)
        .where(eq(callSummariesTable.sessionId, sessionId))
        .orderBy(desc(callSummariesTable.version))
        .limit(1);

      const nextVersion = existing.length > 0 ? existing[0].version + 1 : 1;

      // Step C: Insert new summary row (status always starts as 'pending_review').
      const [inserted] = await tx
        .insert(callSummariesTable)
        .values({
          sessionId,
          version: nextVersion,
          status: "pending_review",
          topic: summary.topic,
          tone: summary.tone,
          openItems: summary.openItems,
          summaryText: summary.summaryText,
          confidenceScore: summary.confidenceScore,
          committedAt: null,
        })
        .returning({ id: callSummariesTable.id });

      // Step D: Insert decision rows.
      if (summary.decisions.length > 0) {
        await tx.insert(callDecisionsTable).values(
          summary.decisions.map((d) => ({
            sessionId,
            summaryId: inserted.id,
            turnId: d.turnId,
            decisionType: d.decisionType,
            description: d.description,
            resolved: d.resolved,
          })),
        );
      }
    });
  }

  /**
   * Write a baseline placeholder when there are no turns to summarise.
   */
  private static async writeDefaultPlaceholderSummary(
    sessionId: string,
    log: string,
  ): Promise<void> {
    const empty: ICallSummary = {
      topic: "Unstructured Call",
      tone: "Neutral",
      openItems: [],
      summaryText: "No meaningful user/assistant interaction recorded.",
      confidenceScore: 100,
      decisions: [],
    };
    await this.writeSummary(sessionId, empty);
    console.info(`${log} Placeholder summary written.`);
  }

  /**
   * Strict runtime parser for LLM JSON output.
   * Strips markdown fences, extracts JSON bounds, validates every field.
   */
  private static parseAndSanitizeJSON(
    rawText: string,
    log: string,
  ): ICallSummary {
    let s = rawText.trim();

    // Strip markdown fences if present.
    s = s.replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/\s*```$/, "").trim();

    // Extract JSON bounds.
    const startIdx = s.indexOf("{");
    const endIdx = s.lastIndexOf("}");
    if (startIdx === -1 || endIdx === -1) {
      throw new Error(`${log} LLM did not return a JSON object.`);
    }
    s = s.substring(startIdx, endIdx + 1);

    const parsed: Record<string, unknown> = JSON.parse(s);

    // Validate and sanitise open_items.
    const rawOpenItems = Array.isArray(parsed["open_items"])
      ? (parsed["open_items"] as unknown[])
      : [];
    const openItems = rawOpenItems
      .slice(0, 10)
      .map((item) => String(item).substring(0, 256));

    // Validate and sanitise decisions.
    const rawDecisions = Array.isArray(parsed["decisions"])
      ? (parsed["decisions"] as Record<string, unknown>[])
      : [];

    const decisions: ICallDecision[] = [];
    for (const d of rawDecisions.slice(0, 20)) {
      const turnId =
        typeof d["turn_id"] === "string" ? d["turn_id"] : "unknown";

      const validTypes = ["action", "commitment", "preference", "question"] as const;
      const rawType = d["decision_type"];
      const decisionType: ICallDecision["decisionType"] =
        validTypes.includes(rawType as ICallDecision["decisionType"])
          ? (rawType as ICallDecision["decisionType"])
          : "action";

      const rawDesc =
        typeof d["description"] === "string"
          ? d["description"]
          : "Undocumented action.";
      // Strip raw tag injections; cap at 500 chars.
      const description = rawDesc.replace(/[<>]/g, "").substring(0, 500);

      const resolved =
        typeof d["resolved"] === "boolean" ? d["resolved"] : false;

      decisions.push({ turnId, decisionType, description, resolved });
    }

    return {
      topic:
        typeof parsed["topic"] === "string"
          ? parsed["topic"].substring(0, 150)
          : "General Subject",
      tone:
        typeof parsed["tone"] === "string"
          ? parsed["tone"].substring(0, 50)
          : "Neutral",
      openItems,
      summaryText:
        typeof parsed["summary_text"] === "string"
          ? parsed["summary_text"]
          : "Dialogue session processed.",
      confidenceScore:
        typeof parsed["confidence_score"] === "number"
          ? parsed["confidence_score"]
          : 70,
      decisions,
    };
  }
}
