// ---------------------------------------------------------------------------
// VoiceContextAssembler.ts — P1-4 Stage 5: session-scoped context assembly.
//
// Builds the system prompt + message array for each voice turn, adding:
//   - Reconnect preamble  (if call has dropped and reconnected)
//   - Interruption context (if Kane interrupted Ashley mid-response)
//   - Direct question instruction (if Stage 4 flagged DIRECT_QUESTION)
//   - 100-turn overflow preamble (previous committed call summary)
//
// Does NOT modify loadVoiceContext() in voice-call.ts.
// History is scoped to the current session (source='voice_call',
// created_at >= callStartTime) — separate from loadVoiceContext's
// device-wide query.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import {
  messagesTable,
  memoriesTable,
  conversationSummariesTable,
  callSummariesTable,
} from "@workspace/db";
import { eq, and, gte, desc, asc, ne, count, lt } from "drizzle-orm";
import { getOrCreateProfileFor } from "./profile.js";
import { buildSystemPrompt } from "./ashleyCoreSpec.js";
import type { LLMMessage } from "./textLLM.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY_TURNS = 100;
const REMAINING_RESPONSE_MAX_CHARS = 400;

const VOICE_MODE_ADDENDUM = `
## Voice Call Mode
This is a live voice call. The user is speaking; you speak back via
text-to-speech.
- Keep each reply to 1-3 sentences unless the question requires more.
- No markdown. No bullet points. No asterisks. No numbered lists.
- Do not narrate actions in asterisks (*smiles*, *laughs*).
- Speak naturally — full sentences, not fragments.
- Conversational tone only. No lists, bullets, headers.
- Do not mention you are an AI or that this is a voice call unless the
  user raises it.
- If you need to think through something: say so out loud naturally.
`.trim();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssembleOptions {
  sessionId: string;
  deviceId: string;
  callStartTime: Date;
  currentUtterance: string;
  reconnectCount: number;
  isDirectQuestion: boolean;
  wasInterrupted: boolean;
  remainingResponse: string | null;
  passiveMode: boolean;
}

export interface AssembledContext {
  systemPrompt: string;
  messages: LLMMessage[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class VoiceContextAssembler {
  static async assemble(opts: AssembleOptions): Promise<AssembledContext> {
    const {
      sessionId,
      deviceId,
      callStartTime,
      currentUtterance,
      reconnectCount,
      isDirectQuestion,
      wasInterrupted,
      remainingResponse,
    } = opts;

    // ── Base profile + memories + conversation summaries ───────────────────
    const profile = await getOrCreateProfileFor(deviceId);

    const [memories, convSummaries] = await Promise.all([
      db
        .select()
        .from(memoriesTable)
        .where(eq(memoriesTable.deviceId, deviceId)),
      db
        .select()
        .from(conversationSummariesTable)
        .where(eq(conversationSummariesTable.deviceId, deviceId)),
    ]);

    const voiceProfile = { ...profile, voiceMode: true };

    const systemParts: string[] = [
      buildSystemPrompt(voiceProfile, memories, convSummaries, {
        imageGenerationEnabled: false,
      }),
      VOICE_MODE_ADDENDUM,
    ];

    // ── Reconnect preamble ─────────────────────────────────────────────────
    if (reconnectCount > 0) {
      let topic = "our ongoing discussion";
      try {
        const summaryRows = await db
          .select({ topic: callSummariesTable.topic })
          .from(callSummariesTable)
          .where(
            and(
              eq(callSummariesTable.sessionId, sessionId),
              eq(callSummariesTable.status, "committed"),
            ),
          )
          .orderBy(desc(callSummariesTable.createdAt))
          .limit(1);
        if (summaryRows.length > 0 && summaryRows[0].topic) {
          topic = summaryRows[0].topic;
        }
      } catch {
        // fallback topic already set
      }

      systemParts.push(
        `Note: the call dropped and reconnected ${reconnectCount} time(s). ` +
          `Acknowledge the drop naturally and resume the conversation. ` +
          `Last topic: ${topic}.`,
      );
    }

    // ── Interruption context ───────────────────────────────────────────────
    if (wasInterrupted && remainingResponse) {
      const capped = remainingResponse
        .replace(/[<>]/g, "")
        .slice(0, REMAINING_RESPONSE_MAX_CHARS);
      systemParts.push(
        `[INTERRUPTION CONTEXT]: You were mid-response when Kane interrupted. ` +
          `Unspoken remainder: <remainder>${capped}</remainder>. ` +
          `Acknowledge Kane's input, then weave back naturally if still relevant.`,
      );
    }

    // ── Direct question instruction ────────────────────────────────────────
    if (isDirectQuestion) {
      systemParts.push(
        "Kane has asked you a direct question. Respond immediately and directly. Do not hedge or defer.",
      );
    }

    const systemPrompt = systemParts.join("\n\n");

    // ── Session-scoped history ─────────────────────────────────────────────
    const historyRows = await db
      .select()
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.deviceId, deviceId),
          eq(messagesTable.source, "voice_call"),
          gte(messagesTable.createdAt, callStartTime),
        ),
      )
      .orderBy(asc(messagesTable.createdAt))
      .limit(MAX_HISTORY_TURNS);

    // ── 100-turn overflow: previous session summary as preamble ───────────
    let preambleMessages: LLMMessage[] = [];

    try {
      const countResult = await db
        .select({ value: count() })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.deviceId, deviceId),
            eq(messagesTable.source, "voice_call"),
            gte(messagesTable.createdAt, callStartTime),
          ),
        );

      const totalTurns = Number(countResult[0]?.value ?? 0);

      if (totalTurns >= MAX_HISTORY_TURNS) {
        const prevSummary = await db
          .select({
            summaryText: callSummariesTable.summaryText,
          })
          .from(callSummariesTable)
          .where(
            and(
              ne(callSummariesTable.sessionId, sessionId),
              eq(callSummariesTable.status, "committed"),
              lt(callSummariesTable.createdAt, callStartTime),
            ),
          )
          .orderBy(desc(callSummariesTable.createdAt))
          .limit(1);

        if (prevSummary.length > 0) {
          preambleMessages = [
            {
              role: "user" as const,
              content: `Context from previous call session: ${prevSummary[0].summaryText}`,
            },
          ];
        }
      }
    } catch {
      // preamble is optional — failure is non-fatal
    }

    // ── Assemble message array ─────────────────────────────────────────────
    const historyMessages: LLMMessage[] = historyRows
      .filter((m) => m.role === "user" || m.role === "ashley")
      .map((m) => ({
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
      }));

    const messages: LLMMessage[] = [
      ...preambleMessages,
      ...historyMessages,
      { role: "user" as const, content: currentUtterance },
    ];

    return { systemPrompt, messages };
  }
}
