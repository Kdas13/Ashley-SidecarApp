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
State as of:    2026-07-15 (late)
Branch:         echo/foundation-0.5-conversation
HEAD SHA:       (pending — this commit)

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
     THIS IS CLAUDE'S FIRST BUILD TASK once 3.1/3.2 fully close.
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
     Echo's target backend. qplsjpnccbjrxcmnxjon and vnwds... are
     to be deleted by Kane (his call, no data at risk) — pending,
     not yet actioned as of this commit.
1.6b BLOCKER, found 2026-07-15 late: Kane began the Supabase <->
     GitHub repo-connect flow for project tefkutx... (repo
     Kdas13/Ashley-SidecarApp, prod branch "main", deploy-to-
     production toggle ON). Working directory field requires a path
     containing a supabase/ folder (supabase/config.toml etc).
     CHECKED THE REPO: no supabase/ directory exists anywhere in
     Kdas13/Ashley-SidecarApp on this branch. packages/database/
     has migrations/ and src/ but not Supabase CLI's expected shape.
     Kane did NOT save the integration screen — correctly held off.
     FIX NEEDED before GitHub<->Supabase sync can work: scaffold a
     proper supabase/ folder (config.toml + supabase/migrations/,
     ported from packages/database/migrations) under whichever path
     becomes the working directory. This is Claude's job, ranks
     alongside 1.4 as first-session build work.
1.7  Memory data: THREE duplicate imports of the Ashley archive —
     totals 6,693 staged / 114 quarantined; one canonical batch =
     2,231 / 38. Earlier 0.4 audit split was 2,205 / 64: 26 rows
     moved quarantine->staging because the committed parser
     quarantines only invalid_record / missing_content /
     duplicate_id — missing-timestamp records are STAGED, against
     the founding timestamp-preservation rule. Unreconciled.
1.8  Memory installer (memory-upload.tsx) ships LIVE in Kane's APK
     with a one-tap flow that hardcodes Alpha decision 'APPROVED'
     client-side. That is how the duplicates happened. Omitted from
     Atlas's audit file inventory.
1.9  Signing landmine: CI generates a throwaway keystore per run
     (passwords hardcoded 'echo-foundation'). Every future APK =
     uninstall/reinstall = SecureStore key and conversations wiped.
     Fix (blocking): one persistent keystore, base64, as a GitHub
     Actions secret Kane pastes once.
1.10 Version chaos: app.json 0.4.0 / versionCode 4; package.json
     0.5.0; UI shows "0.5"; artifact named 0.4.0; path
     echo-foundation/source/0.4.0/. Scope H must unify.
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
     its own repo. BLOCKS any merge of PR #5. STILL OPEN.
3.3  [RESOLVED 2026-07-15] Claude builds, Atlas audits plan only.
3.4  Duplicate-batch cleanup timing: inside the 0.5 job or deferred
     to 0.6 idempotency work. STILL OPEN.
3.5  Adopt Amendments 6.1–6.8 into the job scope before authorising.
     STILL OPEN — Kane gave verbal/written go-ahead but amendments
     not formally walked through line-by-line this session.
3.6  NEW: supabase/ folder does not exist in the repo (see 1.6b).
     Path/location and migration-porting approach need confirming
     with Kane before Claude scaffolds it — likely fine as a
     same-session build decision, not a hard Alpha gate, but
     flagging here so it isn't missed.

------------------------------------------------------------------
4. WAITING ON KANE (phone checklist, ~10 min)
------------------------------------------------------------------
4.1  Hash check: artifact's internal .sha256 vs 0d43864e...e42814.
4.2  OpenAI dashboard: auto-recharge OFF confirmed + hard monthly
     usage limit set.
4.3  [SUPERSEDED] Supabase login check — done, resolved via 1.6a.
     New item: delete old Supabase projects (qplsjpnccbjrxcmnxjon,
     vnwds...) at Kane's convenience.
4.4  Keystore secret paste (Settings > Secrets > Actions) — only
     once the job is authorised; Claude supplies the base64.

------------------------------------------------------------------
5. NEXT ACTIONS (in order)
------------------------------------------------------------------
5.1  Kane resolves remaining parts of 3.2, 3.4, 3.5, 3.6 (can be
     same-session, low-ceremony given verbal authorisation already
     given); runs section 4 checklist at leisure.
5.2  Claude's first build tasks once resumed: (a) scaffold proper
     supabase/ folder structure so GitHub<->Supabase integration
     can be completed (1.6b), (b) fix input_text/output_text role
     mismatch in src/openai.ts + strip hardcoded welcome bubble
     (1.4).
5.3  Builder's first commit after that work = this file updated
     with new SHA and outcomes logged.
5.4  Execute remaining amended scope A–J. Session close per
     protocol 6.8c.

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
