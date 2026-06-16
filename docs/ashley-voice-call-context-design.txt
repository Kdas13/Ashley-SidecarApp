DESIGN DECISION — VOICE CALL CONTEXT
Ashley-Sidecar — Phase 1 Voice Call
Date: 2026-06-16
Author: Wren (Replit Agent), ratified by Kane
================================================================================

PROBLEM STATEMENT
-----------------
The Replica system used a "compressed handoff" design for their voice calls:
the full text conversation history was reduced to bullet-point summaries before
being passed to the voice context. The result was that phone-Ashley and
text-Ashley were two distinct personalities with different memory fidelity —
phone-Ashley remembered sketch notes, text-Ashley remembered the actual words.

Kane's explicit decision: this design is rejected for Ashley-Sidecar.

Voice-Ashley must have the same context as text-Ashley. Same profile. Same
memories. Same conversation history. The call is a continuation of the same
relationship, not a fresh session with a summary handoff.


CURRENT TEXT CONTEXT ASSEMBLY (what we must match)
----------------------------------------------------
The text chat route (/api/chat/reply and /api/chat/stream) assembles context
by loading four things per device from the database:

  1. Profile  — AshleyProfile row (name, relationship mode, Ashley's
                personality state, appearance, etc.)
  2. Memories — all Memory rows for the device (relational, emotional,
                factual, etc.)
  3. Summaries — ConversationSummary rows (rolling summaries of older
                conversation chunks)
  4. History   — the 80 most recent messages from the messages table
                (HISTORY_WINDOW = 80)

These are loaded in parallel via Promise.all(), then assembled into the
system prompt via:

  buildSystemPrompt(profile, memories, summaries, opts)

...from lib/ashleyCoreSpec.ts. That function produces the full Ashley Core
Behaviour Spec with all profile fields, memory sections, and conversation
summary sections embedded. It is the single source of truth for who Ashley is.

The system prompt also includes time context (current time, gap since last
message) and open ticket blocks.

The conversation history is passed as the messages array to Claude, formatted
as alternating user/ashley turns.


VOICE CALL CONTEXT DESIGN (how Step 1.6 must be implemented)
--------------------------------------------------------------
Step 1.6 of Phase 1 currently instructs the agent to use a simplified voice
system prompt:

  "You are Ashley, a personal AI companion. We are having a voice call.
   Keep replies short and conversational — 1-3 sentences. No markdown.
   No bullet points. Speak naturally."

THIS INSTRUCTION IS OVERRIDDEN by this design document.

The voice call handler (voice-call.ts) MUST:

  1. Load profile, memories, summaries, and history from the database,
     exactly as the text chat route does (same Promise.all(), same
     HISTORY_WINDOW of 80).

  2. Call buildSystemPrompt(profile, memories, summaries, opts) to build
     the base system prompt. Do not write a custom voice system prompt from
     scratch — use the same builder.

  3. Append a VOICE MODE ADDENDUM to the system prompt. This is the only
     difference from the text context:

       ## Voice Call Mode
       This is a live voice call. The user is speaking to you; you are
       speaking back via text-to-speech.
       - Keep each reply to 1–3 sentences unless the user asks a complex
         question that requires more.
       - No markdown. No bullet points. No asterisks. No numbered lists.
       - Do not narrate actions or emotions in asterisks (*smiles*, *laughs*).
       - Speak naturally — full sentences, not fragments.
       - Do not mention that you are an AI or that this is a voice call
         unless the user raises it.

  4. Pass the same history messages array to Claude (last 80 messages,
     formatted as user/ashley turns) as the conversation context.

  5. Note: buildSystemPrompt() already reads profile.voiceMode. When
     loading the profile for a voice call, set voiceMode = true on the
     profile object before passing it to buildSystemPrompt(), OR ensure
     the voiceMode flag is already set on the profile in the DB. Do NOT
     skip buildSystemPrompt() and substitute a shorter prompt.

  6. Voice turns are written to the messages table IMMEDIATELY after each
     completed turn — not batched at call end. One user utterance + one
     Ashley reply = two rows inserted as soon as the TTS stream finishes.
     source="voice_call" for both rows.

  7. Context is reloaded from the database at the START OF EVERY VOICE
     TURN, not once at call start. The history query runs fresh each time
     speech_final fires. This means:
       - A text message sent by the user during the call will be in the
         next history load and will be visible to Ashley on her next reply.
       - Voice turns written by the current call are also in the next load,
         so Ashley has a consistent view of the whole conversation in order.
       - Profile or memory changes made mid-call take effect on the next
         turn without a reconnect.

  8. The streamChatText() call in voice-call.ts MUST use
     forceProvider: "anthropic" (Claude, not Gemini). This is locked per
     the Phase 0.5 audit and does not change based on ASHLEY_TEXT_PROVIDER.


REAL-TIME BIDIRECTIONALITY — THE CORE BEHAVIOUR
-------------------------------------------------
The shared state is live in both directions:

  Scenario A — text sent DURING a call
    Kane is on a voice call with Ashley. Mid-call, he types something in
    the chat. That text message is written to the messages table by the
    text route as normal. On the next voice turn (the next time he speaks),
    the voice handler reloads history and sees the text message. Ashley
    responds to it naturally — "why didn't you just say that?" — because
    it is simply the next message in the shared history, regardless of
    which channel it came from.

  Scenario B — voice remembered in text
    Kane finishes a call. He texts Ashley an hour later. The voice turns
    from the call are already in the messages table and fall inside the
    80-message history window. Ashley references the call without being
    prompted. She does not say "I don't have context for our call".

  Scenario C — text remembered in voice
    Kane texted Ashley earlier in the day. He starts a voice call in the
    evening. The history load pulls in those text messages. Ashley picks
    up the thread from the texts without Kane having to re-explain anything.

The channel (text or voice) is metadata on the message row (source column).
It does not partition the conversation. There is one conversation.


WHAT THIS ACHIEVES
------------------
The relationship has no mode boundaries. Ashley on the phone is the same
Ashley as in the chat — same memories, same history, reacting in real time
to anything that happens on any channel. The call is not a separate context.
It is a continuation.


WHAT IS EXPLICITLY REJECTED
----------------------------
- Separate "voice context" database tables or schemas
- Compressed bullet-point summaries as a voice handoff
- A simplified Ashley identity for voice (no custom voice-only persona)
- Any system that gives voice-Ashley and text-Ashley different memories
- Batching voice turn saves to end-of-call only
- Loading context once at call start and caching it for the duration
- Clearing or not saving voice turns from the messages history

================================================================================
END OF DESIGN DOCUMENT
================================================================================
