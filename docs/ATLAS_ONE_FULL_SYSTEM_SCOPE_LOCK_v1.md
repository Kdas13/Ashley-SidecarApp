# Atlas One — Full System Scope Lock v1

**Date:** 17 July 2026  
**Status:** Scope locked; system not yet complete.

## Verdict

Atlas One is currently a working proof of capability, not yet the best AI system that can be built with the available APIs, tools and connectors. The v1.4 line proves chat, local storage, documents, images, downloads, sharing and an optional Agents SDK backend. It has also exposed the danger of isolated feature patches and hard-coded routing.

No future APK should be described as complete until the blockers and acceptance gates below are cleared.

## Blockers

1. Replace the monolithic mobile runtime with separate conversation, memory, artifact, tool, provider, storage and security services.
2. Build a real conversation-state engine: objective, topic shift, correction, unresolved question, referenced artifact, satisfaction and pending action.
3. Add response novelty, contradiction and evidence checks so repeated/circling answers are rejected before display.
4. Add a persistent user-authorised Android workspace using Storage Access Framework, retained tree permission, indexing, checksums and external-change detection.
5. Make artifacts first-class records with stable IDs, versions, provenance and separate app-private, workspace and exported locations.
6. Replace shallow standalone memory and FTS-only backend recall with working, episodic, semantic, artifact, project and interaction-preference memory, including contradiction/supersession and consolidation.
7. Convert document manifests into a real durable orchestration engine with jobs, dependencies, idempotency, retries, approvals, evidence, acceptance tests and rollback.
8. Build a connector gateway. The ChatGPT connectors used during development are not inherited by the APK. Wire Gmail, Calendar, Contacts, Drive and GitHub with authentication state, tool inventory, health, approval policy and audit records.
9. Add durable planner, executor, verifier and critic roles. Plans must survive restarts and execute one approved step at a time.
10. Complete voice: streaming transcription/speech, interruption, cancellation, Bluetooth/audio focus and shared conversation state.
11. Complete visual intelligence: camera/gallery input, inspection, edit/inpaint/variation, gallery, metadata, versions and Android workspace storage.
12. Harden security: reject default secrets, per-device credentials, TLS-only remote mode, rate limiting, replay protection, encrypted sensitive storage, tracing off by default, strict redaction and ownership checks.
13. Add streaming, cancellation, in-flight persistence and duplicate-tool prevention.
14. Add capability-based provider routing, fallbacks, circuit breakers and visible provider choice.
15. Add real monetary budgets and a cost ledger, not only run-count caps.
16. Add multiple conversations and projects linking messages, memory, tasks, plans and artifacts.
17. Unify standalone and connected behaviour under one policy/domain model.
18. Replace smoke-level testing with Android, end-to-end, connector, approval, memory, security, offline, migration and rollback suites.

## Required release order

### v1.5 — Foundation rebuild

- modular mobile architecture
- conversation-state and anti-repeat engine
- multiple conversations
- artifact registry
- persistent Android workspace
- streaming/cancellation
- structured errors
- migrations and end-to-end test foundation

### v1.6 — Memory and project continuity

- hybrid semantic/lexical memory
- context packet builder
- project model
- consolidation, contradiction and supersession
- conversation/artifact search

### v1.7 — Connected operator

- hardened backend identity and authentication
- Gmail, Calendar, Contacts, Drive and GitHub connector gateway
- connector approval policy and health
- durable plan/job engine

### v1.8 — Multimodal

- complete image receive/edit/gallery workflow
- streaming voice-call mode
- rich document revision and source/citation workflow

### v1.9 — Autonomy and resilience

- scheduler and notifications
- condition watches
- offline queue
- backup, restore, safe boot and rollback
- provider routing and cost budgets

### v2.0 — Release candidate

- hostile architecture/security audit
- full acceptance suite
- signed upgrade and rollback rehearsal
- no known blockers or silent failures

## Authority boundary

Read-only research, memory recall, authorised-file reading and analysis may run without approval. Email sends, calendar writes, Drive writes, GitHub writes, deployments, deletion, publication, spending, account changes and orchestration execution require an approval tied to the exact arguments. Old approvals may not be reused or widened.

## Acceptance gates

- A correction changes the next answer; the previous answer is not repeated.
- A topic shift does not recreate the previous document or image.
- Near-duplicate assistant output is rejected and regenerated.
- Stable memory persists across restart; contradictions supersede without losing provenance.
- The authorised Android workspace survives restart and detects external file changes.
- Created artifacts can be reopened, revised, versioned and traced by ID.
- Connector writes pause with exact arguments; rejection produces no side effect; approval verifies the result.
- Orchestration resumes after crash without duplicate execution.
- Default secrets block startup and secrets do not appear in logs, memory or exports.
- Offline, timeout, rate limit and provider outage paths are tested.
- Backups, restore and signed rollback pass.

## Build decision

Do not add another isolated feature patch to v1.4.x. The next legitimate build is the integrated v1.5 Foundation Rebuild.

From Atlas.
