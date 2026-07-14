#!/bin/bash
set -euo pipefail

pnpm install --frozen-lockfile

echo "Database schema changes are intentionally not applied by post-merge."
echo "Use reviewed, versioned migrations only after a verified backup and restore rehearsal."
