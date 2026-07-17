# Atlas One v1.5 — Foundation Rebuild

This checkpoint replaces the v1.4 monolithic proof-of-capability runtime with a modular mobile system.

## Implemented

- modular app, storage, conversation, provider, artifact, workspace, screen and UI layers
- schema-versioned SQLite migrations
- multiple conversations with separate histories
- conversation-state engine for objective, topic shift, correction, unresolved question, referenced artifact, satisfaction and pending action
- response novelty guard with automatic regeneration after repetition or correction
- OpenAI Responses API streaming and user cancellation
- explicit local intent routing so questions about existing artifacts do not recreate them
- first-class artifacts with IDs, checksums, versions, provenance and private/workspace/exported locations
- persistent user-authorised Android workspace through Storage Access Framework
- workspace re-indexing and external-change detection
- real document and image generation, import, download and sharing
- structured failure codes and request-in-flight protection
- tests for artifact routing, corrections and anti-repeat behaviour

## Source package

`source.tgz.b64` is a gzip-compressed tar archive encoded as Base64.

SHA-256 of the decoded archive:

`14d75d8afbd74c41e9a231dd52c53d194f66354b5a7e220636ce33116d657df7`

The build workflow verifies this checksum before extracting and compiling the project.

## Boundary

This is v1.5 foundation, not v2.0 completion. Semantic memory, connector gateway, durable orchestration jobs, complete voice, complete image editing, backup/restore and the final security acceptance suite remain later locked releases.

From Atlas.
