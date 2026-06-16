// ---------------------------------------------------------------------------
// voice-call.ts — Phase 1 voice call turn pipeline.
//
// Owns: loadVoiceContext, VOICE_MODE_ADDENDUM, stripMarkdown, handleVoiceTurn.
//
// Checkpoint coverage:
//   1D — context reload + Claude call (this file)
//   1E — ElevenLabs streaming (wired into handleVoiceTurn in 1E)
//   1F — per-turn DB write (wired in 1F)
//   1G — interrupt handling (wired in 1G)
//
// TRAP 2: no session state in route closures — all state in VoiceSessionRegistry.
// TRAP 4: ANTHROPIC_CHAT_MODEL is never hardcoded — forceProvider resolves it.
// ---------------------------------------------------------------------------

import { db } from "@workspace/db";
import {
  messagesTable,
  memoriesTable,
  conversationSummariesTable,
} from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { getOrCreateProfileFor } from "../lib/profile";
import { buildSystemPrompt } from "../lib/ashleyCoreSpec";
import { streamChatText, type LLMMessage } from "../lib/textLLM";
import * as registry from "../lib/VoiceSessionRegistry";
import type { VoiceSession } from "../lib/VoiceSessionRegistry";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors HISTORY_WINDOW from chat.ts — must stay in sync. */
const HISTORY_WINDOW = 80;

/** Max tokens for a voice reply. Intentionally small — voice turns are brief. */
const VOICE_MAX_TOKENS = 1024;

/** Claude is aborted after this many ms with a spoken fallback. */
const CLAUDE_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Voice mode addendum — appended to every voice turn system prompt.
// ---------------------------------------------------------------------------
export const VOICE_MODE_ADDENDUM = `
## Voice Call Mode
This is a live voice call. The user is speaking; you speak back via
text-to-speech.
- Keep each reply to 1-3 sentences unless the question requires more.
- No markdown. No bullet points. No asterisks. No numbered lists.
- Do not narrate actions in asterisks (*smiles*, *laughs*).
- Speak naturally — full sentences, not fragments.
- Do not mention you are an AI or that this is a voice call unless the
  user raises it.
`.trim();

// ---------------------------------------------------------------------------
// loadVoiceContext — replicates the exact Promise.all pattern from chat.ts.
// Context is loaded fresh on EVERY turn — never cached at call start.
// ---------------------------------------------------------------------------
export async function loadVoiceContext(deviceId: string) {
  const profile = await getOrCreateProfileFor(deviceId);

  const [memories, summaries, history] = await Promise.all([
    db
      .select()
      .from(memoriesTable)
      .where(eq(memoriesTable.deviceId, deviceId)),
    db
      .select()
      .from(conversationSummariesTable)
      .where(eq(conversationSummariesTable.deviceId, deviceId)),
    // Most-recent HISTORY_WINDOW messages; reversed below to chronological order.
    db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.deviceId, deviceId))
      .orderBy(desc(messagesTable.createdAt))
      .limit(HISTORY_WINDOW),
  ]);

  history.reverse(); // newest-last for the Claude prompt
  return { profile, memories, summaries, history };
}

// ---------------------------------------------------------------------------
// stripMarkdown — removes markdown syntax before sending text to TTS.
// ---------------------------------------------------------------------------
export function stripMarkdown(text: string): string {
  return (
    text
      // Stage directions: *smiles*, _nods_, etc.
      .replace(/\*[^*\n]+\*/g, "")
      .replace(/_[^_\n]+_/g, "")
      // Heading pound signs
      .replace(/^#{1,6}\s+/gm, "")
      // Bullet list hyphens / dashes at line start
      .replace(/^[-–•]\s+/gm, "")
      // Numbered lists
      .replace(/^\d+\.\s+/gm, "")
      // Remaining stray asterisks (bold/italic remnants)
      .replace(/\*+/g, "")
      // Collapse excess blank lines
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

// ---------------------------------------------------------------------------
// handleVoiceTurn — the speech_final → context → Claude pipeline for one turn.
//
// Returns { claudeText, stripped } on success, or null if the turn was
// cancelled / failed / produced empty output.
//
// Side effects:
//   - Mutates session.state, session.currentTurnId, etc.
//   - Logs timing milestones to session.log and server logger.
//   - Tracks consecutiveContextFailures; closes session at 2 failures.
//   - TTS (1E) and DB write (1F) are NOT wired here yet — stubs only.
// ---------------------------------------------------------------------------
export async function handleVoiceTurn(
  session: VoiceSession,
  transcript: string,
  utteranceId: string,
): Promise<{ claudeText: string; stripped: string; turnId: string } | null> {
  const turnId = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const turnStart = Date.now();

  // Assign ownership fields before any await so concurrent cancellation sees them.
  session.currentTurnId = turnId;
  session.currentResponseId = responseId;
  session.state = "llm_pending";

  // ── 1. Load context ────────────────────────────────────────────────────────
  const contextStart = Date.now();
  let contextResult: Awaited<ReturnType<typeof loadVoiceContext>>;

  try {
    contextResult = await loadVoiceContext(session.deviceId);
    session.consecutiveContextFailures = 0;
    const contextLoadMs = Date.now() - contextStart;
    session.log.push({
      event: "CONTEXT_LOADED",
      ts: new Date(),
      detail: `contextLoadMs=${contextLoadMs}`,
    });
    logger.info(
      { deviceId: session.deviceId, turnId, contextLoadMs },
      "voice: context loaded",
    );
  } catch (err) {
    session.consecutiveContextFailures += 1;
    logger.error(
      {
        err,
        deviceId: session.deviceId,
        turnId,
        consecutiveContextFailures: session.consecutiveContextFailures,
      },
      "voice: loadVoiceContext failed",
    );
    // Spoken fallback (TTS wired in 1E — log only for now).
    logger.info(
      "voice: [TTS fallback] 'Sorry, I lost my thread for a second. Try that again?'",
    );
    if (session.consecutiveContextFailures >= 2) {
      logger.warn(
        { deviceId: session.deviceId },
        "voice: 2 consecutive context failures — ending call",
      );
      try {
        session.ws?.send(
          JSON.stringify({ type: "call_ended", reason: "context_load_failed" }),
        );
      } catch {
        // ignore send errors
      }
      registry.finalise(session.sessionId, "context_load_failed");
    } else {
      session.state = "listening";
    }
    return null;
  }

  // ── 2. Build system prompt ─────────────────────────────────────────────────
  const { profile, memories, summaries, history } = contextResult;

  // voiceMode is read from profile.voiceMode in buildSystemPrompt.
  // We set it on a shallow copy — never write it back to the DB here.
  const voiceProfile = { ...profile, voiceMode: true };

  const systemPrompt = [
    buildSystemPrompt(voiceProfile, memories, summaries, {
      imageGenerationEnabled: false,
    }),
    VOICE_MODE_ADDENDUM,
  ].join("\n\n");

  // ── 3. Build Claude message array ─────────────────────────────────────────
  const claudeMessages: LLMMessage[] = [
    ...history.map((m) => ({
      role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    })),
    { role: "user" as const, content: transcript },
  ];

  logger.info(
    {
      deviceId: session.deviceId,
      turnId,
      utteranceId,
      historyLen: history.length,
      forceProvider: "anthropic",
    },
    "voice: CLAUDE_STARTED",
  );
  session.log.push({
    event: "CLAUDE_STARTED",
    ts: new Date(),
    detail: `turnId=${turnId} historyLen=${history.length}`,
  });

  // ── 4. Call Claude with 30-second AbortController ─────────────────────────
  const controller = new AbortController();
  session.currentAbortController = controller;

  const timeoutHandle = setTimeout(() => {
    if (session.currentAbortController === controller) {
      registry.cancelCurrentTurn(session, "claude_timeout");
      logger.warn(
        { deviceId: session.deviceId, turnId },
        "voice: Claude timed out — cancelling turn",
      );
      // Spoken fallback (TTS wired in 1E — log only for now).
      logger.info(
        "voice: [TTS fallback] 'Sorry, I'm having trouble thinking right now. Try asking me again.'",
      );
    }
  }, CLAUDE_TIMEOUT_MS);

  let claudeText = "";
  const claudeStart = Date.now();

  try {
    const stream = streamChatText({
      system: systemPrompt,
      messages: claudeMessages,
      maxTokens: VOICE_MAX_TOKENS,
      forceProvider: "anthropic",
      signal: controller.signal,
    });

    for await (const chunk of stream) {
      // Drop stale chunks if the turn was cancelled mid-stream.
      if (session.currentTurnId !== turnId) {
        logger.info(
          { deviceId: session.deviceId, turnId },
          "voice: Claude stream abandoned — turn was cancelled",
        );
        return null;
      }
      claudeText += chunk;
    }
  } catch (err: unknown) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "AbortError");
    if (!isAbort) {
      logger.error({ err, deviceId: session.deviceId, turnId }, "voice: Claude error");
      // Spoken fallback (TTS wired in 1E — log only for now).
      logger.info(
        "voice: [TTS fallback] 'Sorry, I'm having trouble thinking right now. Try asking me again.'",
      );
    }
    session.state = "listening";
    return null;
  } finally {
    clearTimeout(timeoutHandle);
    // Release the controller reference only if it's still ours.
    if (session.currentAbortController === controller) {
      session.currentAbortController = null;
    }
  }

  const claudeMs = Date.now() - claudeStart;
  session.log.push({
    event: "CLAUDE_FINISHED",
    ts: new Date(),
    detail: `ms=${claudeMs} chars=${claudeText.length}`,
  });
  logger.info(
    { deviceId: session.deviceId, turnId, claudeMs, claudeChars: claudeText.length },
    "voice: CLAUDE_FINISHED",
  );

  // ── 5. Guard: empty Claude output must not reach ElevenLabs ───────────────
  if (!claudeText.trim()) {
    logger.warn(
      { deviceId: session.deviceId, turnId },
      "voice: empty Claude output — skipping TTS",
    );
    session.state = "listening";
    return null;
  }

  // ── 6. Strip markdown before any TTS call ─────────────────────────────────
  const stripped = stripMarkdown(claudeText);

  const totalTurnMs = Date.now() - turnStart;
  logger.info(
    { deviceId: session.deviceId, turnId, totalTurnMs, strippedPreview: stripped.slice(0, 80) },
    "voice: turn pipeline complete — TTS pending (Checkpoint 1E)",
  );

  return { claudeText, stripped, turnId };
}
