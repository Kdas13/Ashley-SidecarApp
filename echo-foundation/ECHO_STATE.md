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
Session author: Claude (audit + connector-sweep session)
State as of:    2026-07-15
Branch:         echo/foundation-0.5-conversation
HEAD SHA:       a75cc0712e1236210eec472dc550a73d91dff8d0

------------------------------------------------------------------
1. VERIFIED STATE (receipts only — no receipts, no entry)
------------------------------------------------------------------
1.1  PR #5 open, DRAFT, unmerged. Head = SHA above; base = main @
     a999baa3. 62 files, 22 commits. Held per scope's own gate.
1.2  CI green on head SHA: Core+Expo verification run 29413053828;
     standalone APK build run 29413053847.
1.3  APK artifact 8342432969 ("Echo-Foundation-0.4.0-standalone-APK"),
     zip digest sha256:85b1d11439503de78f3a7315a0fee64de2f778ba9e
     411e493d20e6707f6c3eed. Kane's installed APK sha256:
     0d43864e9bc16246546b1ffbc63cd776bcee7c6c381765f1d2bf6047e5e42814.
     Hash chain NOT yet closed (artifact-internal .sha256 vs local
     hash — Kane's checklist item).
1.4  Live blocker, root cause DIAGNOSED, NOT FIXED: src/openai.ts
     maps every history message to content type 'input_text'; the
     Responses API requires assistant-role items use 'output_text'.
     chat.tsx also seeds a hardcoded assistant welcome bubble into
     the payload. Fix = role-conditional content types + exclude the
     seed bubble + unit test with mixed-role history. WARNING: a
     global input_text->output_text swap creates the mirror bug.
1.5  Live backend https://qplsjpnccbjrxcmnxjon.supabase.co
     /functions/v1/echo-api: deployed, enforcing auth (health = 401),
     self-reports 0.5.0. Its source is NOT in the repo — committed
     api.ts says 0.4.0, in-memory Map, no route auth. Different code.
1.6  Supabase ownership unresolved: Kane's connector sees ONLY
     project vnwdsezzwxsegomjdoaf ("Kdas13's Project", created
     2026-06-28, status INACTIVE/paused — restorable via connector).
     qplsjpnccbjrxcmnxjon is NOT visible to Kane's connector. CI's
     "Supabase Preview" check SKIPPED and points at vnwds... —
     config drift between CI, connector, and the app default.
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
Standing    No deletion of memory rows without Kane's explicit
            Alpha. Scope FORBIDDEN list in force. One job at a time;
            written approval before implementation (Commitment 1).

------------------------------------------------------------------
3. OPEN DECISIONS (Kane's Alpha gates — nothing proceeds past these)
------------------------------------------------------------------
3.1  Supabase ownership of qplsjpnccbjrxcmnxjon — whose login owns
     it? BLOCKS all backend work. If Atlas's: recovery play is
     restore vnwds..., deploy backend there from committed source
     via connector, ONE clean archive import, repoint the app.
3.2  Repo home: merge Echo into Ashley-SidecarApp main, or move to
     its own repo. BLOCKS any merge of PR #5.
3.3  Builder assignment: Claude builds + Atlas audits, OR Atlas
     builds + Claude audits. (Wren not an option — see 2. DECIDED.)
3.4  Duplicate-batch cleanup timing: inside the 0.5 job or deferred
     to 0.6 idempotency work. Decide once, not never.
3.5  Adopt Amendments 6.1–6.8 into the job scope before authorising.

------------------------------------------------------------------
4. WAITING ON KANE (phone checklist, ~10 min)
------------------------------------------------------------------
4.1  Hash check: artifact's internal .sha256 vs 0d43864e...e42814.
4.2  OpenAI dashboard: auto-recharge OFF confirmed + hard monthly
     usage limit set.
4.3  Supabase login check (resolves 3.1).
4.4  Keystore secret paste (Settings > Secrets > Actions) — only
     once the job is authorised; Claude supplies the base64.

------------------------------------------------------------------
5. NEXT ACTIONS (in order)
------------------------------------------------------------------
5.1  Kane resolves 3.1–3.3; runs section 4 checklist.
5.2  Amendments 6.1–6.8 adopted into the scope (Atlas informed).
5.3  Kane gives written authorisation naming the builder.
5.4  Builder's first commit = this file updated with new SHA.
5.5  Execute amended scope A–J. Session close per protocol 6.8c.

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

End of state.
