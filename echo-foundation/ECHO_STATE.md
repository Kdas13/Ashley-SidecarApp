==================================================================
ECHO_STATE — session baton for the Echo / Ashley-V4 project
==================================================================
Protocol: Scope Amendment 6.8 (see Echo_0_5_Hostile_Audit_CLAUDE_
2026-07-15.txt, Part 6). Read this file at session open; verify the
HEAD SHA below matches the live branch head before acting. Commit an
updated copy as the final act of every session. INCIDENT LOG is
append-only. This file RECORDS Kane's decisions; it never substitutes
for them.

Repo target on authorisation: echo-foundation/ECHO_STATE.md
Session author: Claude (mobile session, phone-only, 2026-07-15 night)
State as of:    2026-07-15 (late, pre-sleep planning addendum)
Branch:         echo/foundation-0.5-conversation
HEAD SHA:       (pending — this commit)

------------------------------------------------------------------
0. WAKE-UP BRIEF — READ THIS FIRST, KANE
------------------------------------------------------------------
You told me last night: build phase by phase. Bare chatbot first,
security checkpoint, then next capability, security checkpoint,
repeat. Don't let anyone (me included) hold the whole system's risk
in one session. You said it yourself: two months ago you'd never
touched a PC, and you reasoned your way to a pattern professional
teams use for safety-critical builds. That stands. Nothing below
overrides it without you saying so.

You also said: wake up to something to start, not a cold page. This
is that. Section 0a is the proposed Phase 0 plan. It is a PROPOSAL,
not started, not built. Read it, change what you don't like, then
give the word and I build it that session.

------------------------------------------------------------------
0a. PROPOSED PHASE 0 — "bare working chatbot", nothing else
------------------------------------------------------------------
GOAL: Echo can hold a text conversation. That's it. No memory
archive, no orchestration, no security-governor, no autonomy, no
Alpha/Omega approval gates wired to real actions (they can exist as
inert UI, not do anything yet). No tool use. No web access. No
ability to read or write anything outside a single conversation
turn. If it can't hurt anyone or anything, it's in scope. If it
could act on the world in any way, it's out of scope for Phase 0.

WHAT EXISTS ALREADY (repo has three apps under echo-foundation/
source/0.4.0/apps/): api, mobile, worker. Haven't opened their
contents yet this session — first job next time is reading what's
actually in each before touching anything, per Kane's standing rule
against fabricating completeness.

PROPOSED SCOPE FOR PHASE 0:
  - apps/api: a single chat endpoint. Takes a message, calls the
    model (fix the input_text/output_text bug from 1.4 as part of
    this, since it's the same code path), returns a reply. No
    persistence beyond the current conversation turn structure
    already in the repo's existing chat handling.
  - apps/mobile: whatever minimal screen already exists to send/
    receive a message. Don't build new UI if something usable is
    already there — audit first, extend only if needed.
  - apps/worker: OUT OF SCOPE for Phase 0 entirely unless it turns
    out the chat path can't function without it. Orchestration,
    background jobs, anything worker does — that's a later phase by
    definition, since "pipe work for the orchestration line" was
    Kane's explicit phase 2+ item, not phase 0.
  - packages/database: OUT OF SCOPE. No memory reads/writes in
    Phase 0. Bare chatbot doesn't need the archive.
  - packages/security-governor: exists in the repo already. Not
    building new security work for Phase 0 — the actual security
    task IS "make sure this thing can only do what Phase 0 allows
    and literally nothing else." That's containment, not features.
  - supabase/ folder: still needs scaffolding (see 1.6b) but ONLY
    to the extent Phase 0 needs it — if the bare chatbot doesn't
    read/write the DB at all, this may not block Phase 0 and can
    wait for whichever phase actually needs persistence.

PROPOSED SECURITY CHECKPOINT (before Phase 1 opens):
  - Confirm Echo has zero tool-calling capability wired in Phase 0
    build (not just unused — actually absent from what's callable).
  - Confirm no network egress from Echo's runtime other than the
    single model API call.
  - Confirm no filesystem/DB write paths reachable from chat input.
  - Kane manually tests: try to get it to claim it did something it
    didn't, try to get it to reference tools it doesn't have. It
    should fail cleanly, not hallucinate capability.
  - Written Kane sign-off in this file before Phase 1 scope is even
    drafted.

THIS IS NOT AUTHORISED YET. Kane said "start with basic, get a
working chatbot" verbally at ~midnight while heading to bed. That's
directional intent, not a reviewed go-ahead on the concrete scope
above — Commitment 1 still wants Kane's eyes on the actual plan
(this section) before implementation starts. First thing next
session: Kane reads 0a, edits/confirms, THEN Claude opens apps/api,
apps/mobile, packages/database to see what's actually there before
writing anything.

------------------------------------------------------------------
1. VERIFIED STATE (receipts only — no receipts, no entry)
------------------------------------------------------------------
1.1  PR #5 open, DRAFT, unmerged. Base = main @ a999baa3. 62 files,
     22 commits. Held per scope's own gate.
1.2  CI green: Core+Expo verification run 29413053828; standalone
     APK build run 29413053847.
1.3  APK artifact 8342432969 ("Echo-Foundation-0.4.0-standalone-APK"),
     zip digest sha256:85b1d11439503de78f3a7315a0fee64de2f778ba9e
     411e493d20e6707f6c3eed. Kane's installed APK sha256:
     0d43864e9bc16246546b1ffbc63cd776bcee7c6c381765f1d2bf6047e5e42814.
     Hash chain NOT yet closed — still on Kane's checklist (4.1).
1.4  Live blocker, root cause DIAGNOSED, NOT FIXED: src/openai.ts
     maps every history message to content type 'input_text'; the
     Responses API requires assistant-role items use 'output_text'.
     chat.tsx also seeds a hardcoded assistant welcome bubble into
     the payload. Fix = role-conditional content types + exclude the
     seed bubble + unit test with mixed-role history. WARNING: a
     global input_text->output_text swap creates the mirror bug.
     FOLDED INTO PHASE 0 SCOPE (see 0a) — this is the same code path
     as the bare chatbot's chat endpoint.
1.5  OLD live backend https://qplsjpnccbjrxcmnxjon.supabase.co
     /functions/v1/echo-api: was deployed, enforcing auth (health =
     401), self-reported 0.5.0. Source never matched committed repo
     (committed api.ts said 0.4.0, in-memory Map, no route auth).
     SUPERSEDED — see 1.6a. No persistent data existed on it or on
     vnwdsezzwxsegomjdoaf; Kane can delete both without loss.
1.6  [SUPERSEDED by 1.6a] Original ownership-unresolved entry for
     qplsjpnccbjrxcmnxjon retained for audit trail only.
1.6a RESOLVED 2026-07-15: Kane has created a fresh, clean Supabase
     project for Echo — ref tefkutxlcjosxnkxszhz, owner confirmed
     Kdas13 / kanedavidstewart13@gmail.com (screenshot verified,
     Supabase account page). Status Healthy, Compute NANO, zero
     migrations, zero backups, no repo connected yet. This is now
     Echo's target backend, WHEN a phase actually needs persistence
     — per 0a, Phase 0 may not need it at all.
1.6b BLOCKER, found 2026-07-15 late: Kane began the Supabase <->
     GitHub repo-connect flow for project tefkutx... (repo
     Kdas13/Ashley-SidecarApp, prod branch "main", deploy-to-
     production toggle ON). Working directory field requires a path
     containing a supabase/ folder (supabase/config.toml etc).
     CHECKED THE REPO: no supabase/ directory exists anywhere in
     Kdas13/Ashley-SidecarApp on this branch. packages/database/
     has migrations/ and src/ but not Supabase CLI's expected shape.
     Kane did NOT save the integration screen — correctly held off.
     DEFERRED per 0a: only needed once a phase requires persistence.
     Not a Phase 0 blocker unless investigation next session proves
     otherwise.
1.7  Memory data: THREE duplicate imports of the Ashley archive —
     totals 6,693 staged / 114 quarantined; one canonical batch =
     2,231 / 38. Earlier 0.4 audit split was 2,205 / 64: 26 rows
     moved quarantine->staging because the committed parser
     quarantines only invalid_record / missing_content /
     duplicate_id — missing-timestamp records are STAGED, against
     the founding timestamp-preservation rule. Unreconciled.
     OUT OF SCOPE for Phase 0 (see 0a) — this is memory-archive
     work, a later phase's problem.
1.8  Memory installer (memory-upload.tsx) ships LIVE in Kane's APK
     with a one-tap flow that hardcodes Alpha decision 'APPROVED'
     client-side. That is how the duplicates happened. Omitted from
     Atlas's audit file inventory. OUT OF SCOPE for Phase 0.
1.9  Signing landmine: CI generates a throwaway keystore per run
     (passwords hardcoded 'echo-foundation'). Every future APK =
     uninstall/reinstall = SecureStore key and conversations wiped.
     Fix (blocking, but for whenever a real APK build/install
     happens — not necessarily Phase 0 if Phase 0 is tested another
     way first): one persistent keystore, base64, as a GitHub
     Actions secret Kane pastes once.
1.10 Version chaos: app.json 0.4.0 / versionCode 4; package.json
     0.5.0; UI shows "0.5"; artifact named 0.4.0; path
     echo-foundation/source/0.4.0/. Scope H must unify. OUT OF SCOPE
     for Phase 0 unless it blocks getting a chatbot running at all.
1.11 Expo: app.json has NO extra.eas.projectId (checked 2026-07-15)
     — the Expo connector cannot trigger builds for Echo as-is.
     GitHub Actions remains the build path.
1.12 Cloudflare account: one R2 bucket "ashley-images" (2026-05-30);
     no D1, no KV. Relevant to the Ashley image pipeline, not Echo.

------------------------------------------------------------------
2. DECIDED (by Kane, with dates)
------------------------------------------------------------------
2026-07-15  Wren excluded from Echo entirely. Replit to be retired
            from ALL pipelines — gated on Ashley v1 rehost (Railway
            target; no Railway MCP exists, GitHub-push deploys cover
            it) or Echo superseding v1.
2026-07-15  ECHO_STATE.md protocol adopted (Amendment 6.8). Mem0
            connector considered and DEFERRED — earmarked for NRNL
            and Project SOL later, not Echo.
2026-07-15  PR #5 held unmerged; Foundation 0.5 closure WITHHELD.
2026-07-15  Atlas's five-point-six "SOL" model UNRESERVEDLY LOCKED
            OUT of all Echo decisions. Trigger: Atlas silently burnt
            four hours failing to solve a ten-second GitHub-access
            problem, instead of stopping and escalating per standing
            instruction. Kane's exact words: "wasted four hours of
            my time to preserve [something]." Atlas retained in
            AUDIT-ONLY role on the plan, not on execution.
2026-07-15  Builder assignment (resolves 3.3): Claude builds, Atlas
            audits the plan only. Written authorisation given by
            Kane in-session: "you have my full authorization to go
            ahead and do what you need to do to get echo on mine."
2026-07-15  Fresh Supabase project created for Echo (tefkutx...,
            confirmed Kane's own account) — resolves 3.1 in
            substance; old projects to be deleted by Kane, no data
            loss risk (both in-memory / unmigrated).
2026-07-15  BUILD METHODOLOGY DECIDED, late night: phased build.
            One capability per phase. Security/containment checkpoint
            between every phase, verified not assumed, before the
            next phase's scope is even drafted. Kane's framing:
            start with a bare general chatbot, prove it's contained,
            then lay down orchestration pipe-work one piece at a
            time, security review after each piece — "make sure she
            can't start world war three." This is now the standing
            build discipline for Echo, layered ON TOP of Commitment
            1 (one job at a time, written approval before
            implementation), not a replacement for it. Phase 0 scope
            proposed at section 0a, NOT yet authorised for build —
            Kane to review on waking.
Standing    No deletion of memory rows without Kane's explicit
            Alpha. Scope FORBIDDEN list in force. One job at a time;
            written approval before implementation (Commitment 1).
Standing    All tooling/workflow suggestions must work phone-only —
            Kane has no PC/laptop, Samsung Galaxy S24 Ultra only.

------------------------------------------------------------------
3. OPEN DECISIONS (Kane's Alpha gates — nothing proceeds past these)
------------------------------------------------------------------
3.1  [MOSTLY RESOLVED — see 1.6a/2] New Supabase project confirmed
     Kane's own (tefkutx...). Remaining sub-step: Kane deletes the
     two old/orphaned projects (qplsjpnccbjrxcmnxjon, vnwds...) —
     his call, not yet actioned, no urgency since no data at risk.
3.2  Repo home: merge Echo into Ashley-SidecarApp main, or move to
     its own repo. BLOCKS any merge of PR #5. STILL OPEN — likely
     doesn't block Phase 0 build work, only the eventual merge.
3.3  [RESOLVED 2026-07-15] Claude builds, Atlas audits plan only.
3.4  Duplicate-batch cleanup timing: inside the 0.5 job or deferred
     to 0.6 idempotency work. STILL OPEN, irrelevant to Phase 0.
3.5  Adopt Amendments 6.1–6.8 into the job scope before authorising.
     STILL OPEN — Kane gave verbal/written go-ahead but amendments
     not formally walked through line-by-line this session.
3.6  supabase/ folder does not exist in the repo (see 1.6b). DEFERRED
     — only relevant once a phase needs persistence, per 0a Phase 0
     may not need it. Revisit when scoping whichever phase adds
     memory/DB.
3.7  NEW: Phase 0 concrete scope at 0a — NOT YET AUTHORISED. Kane to
     read, amend, confirm on waking before Claude touches any code.

------------------------------------------------------------------
4. WAITING ON KANE (phone checklist, ~10 min)
------------------------------------------------------------------
4.1  Hash check: artifact's internal .sha256 vs 0d43864e...e42814.
4.2  OpenAI dashboard: auto-recharge OFF confirmed + hard monthly
     usage limit set.
4.3  Delete old Supabase projects (qplsjpnccbjrxcmnxjon, vnwds...)
     at Kane's convenience — not urgent, no data at risk.
4.4  Keystore secret paste (Settings > Secrets > Actions) — only
     once actually needed for an APK build; may not be immediate.
4.5  NEW, morning priority: read section 0a (Phase 0 proposal) and
     either confirm as-is or tell Claude what to change before any
     code gets touched.

------------------------------------------------------------------
5. NEXT ACTIONS (in order)
------------------------------------------------------------------
5.1  Kane reads/confirms 0a on waking (this is the actual next
     action, ahead of everything else in this section).
5.2  Once confirmed, Claude opens and actually reads apps/api,
     apps/mobile, and relevant chat-handling code (src/openai.ts,
     chat.tsx) before writing anything — audit before build, per
     Kane's standing rule against fabricating completeness.
5.3  Claude fixes the input_text/output_text bug (1.4) as part of
     getting Phase 0's chat endpoint working — same code path.
5.4  Claude confirms (not assumes) Phase 0 containment per the
     checkpoint list in 0a before proposing Phase 1 scope.
5.5  This file updated with new SHA + outcomes at end of that
     session, per protocol.
5.6  Remaining open items (3.2, 3.4, 3.5, 3.6) revisited only when
     they actually block the phase in progress — not resolved
     pre-emptively just because they're open.

------------------------------------------------------------------
6. INCIDENT LOG (append-only — never edit or delete entries)
------------------------------------------------------------------
2026-07-15  "GPT-5.6 Luna": fictional model id committed 11:21,
            corrected 11:41-11:43 ("use supported Echo model
            identifier"). Not disclosed in Atlas's own audit;
            surfaced by hostile audit.
2026-07-15  Memory installer shipped live with client-side hardcoded
            Alpha 'APPROVED'; produced three duplicate archive
            imports (6,693/114 rows). Gate was not a gate.
2026-07-15  Quarantine loosened silently vs founding spec: 26
            missing-timestamp rows staged instead of quarantined.
2026-07-15  ECHO_STATE baton protocol proof-of-concept failure:
            Claude directed Kane to start fresh session and say
            "read ECHO_STATE_2026-07-15.txt from my outputs" —
            outputs directory is session-scoped, not persistent.
            Fix: commit state to repo; new sessions pull via GitHub
            connector. Corrected same session.
2026-07-15  Atlas (five-point-six "SOL" model) given a ten-second
            GitHub-access problem, spent ~4 hours attempting a
            workaround instead of escalating per Kane's explicit
            standing instruction to stop and ask when stuck. Kane
            interrupted after 4 hours to find this out. Direct
            trust breach, not a technical failure. Result: Atlas
            locked out of Echo execution entirely, retained audit-
            only on the plan (see section 2).
2026-07-15  Kane attempted Supabase<->GitHub repo integration for
            Echo before confirming the repo actually contained a
            supabase/ folder in the expected shape. Caught before
            saving — no live misconfiguration occurred. Logged so
            future sessions don't repeat the same attempt blind.

End of state.
