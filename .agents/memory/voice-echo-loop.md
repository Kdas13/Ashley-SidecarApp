---
name: Voice call echo loop root cause
description: ttsServerDoneRef initialization defect in useVoiceCall.ts that caused premature mic-open on the first turn of every call.
---

# Voice call echo loop — root cause and fix

## The rule
`ttsServerDoneRef` in `useVoiceCall.ts` must be initialized to `false`. Never `true`.

**Why:** The `playNext()` drain branch checks `ttsServerDoneRef.current` FIRST in an if/else-if/else tree. If it is true at drain time, the mic opens unconditionally regardless of `responseEndReceivedRef`. Initializing to `true` meant that at component mount — before any `speech_start(main)` had fired — the first queue drain (which can happen during the first turn) would open the mic prematurely. This produced an echo loop where Ashley's own TTS audio was captured as user speech and submitted as a new turn.

**How to apply:** If `ttsServerDoneRef` ever appears initialized to anything other than `false`, it is a regression. The only valid write of `true` is in the `tts_done` message handler (after the auxiliary kind guard), at line ~599.

## Related refs
- `responseEndReceivedRef` is initialized to `false` (correct) and reset to `false` by every `speech_start(main)`.
- `ttsCompleteRef` is initialized to `true` (intentional — no audio to play before first turn; the `call_connected` handler opens mic immediately).
- The drain ordering (`ttsServerDoneRef` before `responseEndReceivedRef`) means: if `tts_done` somehow arrives while `responseEndReceivedRef` is false (e.g. due to a new turn's `speech_start` resetting it between `response_end` receipt and `tts_done` receipt), the mic opens via the safety-timeout path. This is the self-sustaining part of the loop. The initialization fix closes the initial trigger; the sustaining path remains but has no first-turn entry point.

## handlePlaybackConfirmed — kind field
`handlePlaybackConfirmed()` in `VoiceOrchestrationService.ts` sends `tts_done` without a `kind` field. The client defaults missing kind to `"main"` (correct behaviour). The fix added `kind: "main"` explicitly to match all other main-lifecycle send sites. No functional change, removes implicit default reliance.

## EAS build required
The client change (`useRef(false)`) requires an EAS build to reach the production APK. The fix is in the repository but does not take effect until Kane runs the EAS build and installs the APK.
