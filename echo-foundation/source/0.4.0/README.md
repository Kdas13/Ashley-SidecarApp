# Echo Foundation 0.4.0

Buildable source checkpoint for Echo, the clean-room Ashley V4 successor.

## Included

- Alpha/Omega-gated orchestration and security governor.
- Fastify API and PostgreSQL migrations.
- JSON, JSONL and ZIP memory uploader.
- Passive-only Ashley lineage staging with quarantine and exact post-insert verification.
- Expo S24 client with first-run memory installer.
- GitHub Actions verification for backend and Expo source.

## Safety boundary

The repository contains no Ashley memory archive and no production credentials. Uploads are staged as passive inherited memory. The importer verifies that zero records were inserted into the live `memories` table.

This directory is isolated from Ashley V1 runtime code and must not be merged into `main` without Kane's explicit approval.

From Atlas.
