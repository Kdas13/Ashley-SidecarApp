#!/usr/bin/env bash
# Validation wrapper for the Safeguard happy-path Playwright suite.
#
# Why this exists: the upstream `.github/workflows/safeguard-e2e.yml`
# only fires on GitHub PRs/pushes, but day-to-day work happens in
# Replit task agents. This wrapper plugs the same suite into the local
# validation step that runs before `mark_task_complete`, scoped to the
# files the GitHub workflow watches so unrelated tasks don't pay the
# multi-minute Playwright cost.
#
# Required env (mirrors the GitHub workflow — the test fails fast if
# any are missing):
#   - DATABASE_URL                       writable Postgres
#   - VITE_CLERK_PUBLISHABLE_KEY         Clerk test instance pk_test_…
#   - CLERK_PUBLISHABLE_KEY              same value, for @clerk/testing
#   - CLERK_SECRET_KEY                   Clerk test instance sk_test_…
#   - AI_INTEGRATIONS_OPENAI_BASE_URL    Replit AI proxy base URL
#   - AI_INTEGRATIONS_OPENAI_API_KEY     Replit AI proxy key
#
# Force-run with FORCE_SAFEGUARD_E2E=1 even if no relevant files
# changed. Skip entirely with SKIP_SAFEGUARD_E2E=1.
set -euo pipefail

if [[ "${SKIP_SAFEGUARD_E2E:-0}" == "1" ]]; then
  echo "safeguard-e2e: SKIP_SAFEGUARD_E2E=1, skipping."
  exit 0
fi

WATCH_RE='^(artifacts/safeguard/|artifacts/safeguard-api/|lib/db/|pnpm-workspace\.yaml$|pnpm-lock\.yaml$|scripts/safeguard-e2e-guard\.sh$)'

# Scope to *this task's* changes. In a Replit task-agent env, the
# task starts with HEAD at the latest merged main and all in-progress
# work lives in the working tree (the task commit is created by the
# platform at completion time). Diffing against HEAD therefore tells
# us exactly what this task touched.
changed="$(
  {
    git diff --name-only HEAD 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sed '/^$/d' | sort -u
)"

relevant="$(printf '%s\n' "$changed" | grep -E "$WATCH_RE" || true)"

if [[ "${FORCE_SAFEGUARD_E2E:-0}" != "1" && -z "$relevant" ]]; then
  echo "safeguard-e2e: no Safeguard-relevant changes in working tree; skipping."
  echo "safeguard-e2e: set FORCE_SAFEGUARD_E2E=1 to run anyway."
  exit 0
fi

if [[ -n "$relevant" ]]; then
  echo "safeguard-e2e: detected Safeguard-relevant changes:"
  printf '  %s\n' $relevant
fi

missing=()
for var in DATABASE_URL VITE_CLERK_PUBLISHABLE_KEY CLERK_PUBLISHABLE_KEY \
           CLERK_SECRET_KEY AI_INTEGRATIONS_OPENAI_BASE_URL \
           AI_INTEGRATIONS_OPENAI_API_KEY; do
  if [[ -z "${!var:-}" ]]; then
    missing+=("$var")
  fi
done
if (( ${#missing[@]} > 0 )); then
  echo "safeguard-e2e: missing required env vars: ${missing[*]}" >&2
  echo "safeguard-e2e: set them as Replit secrets (see scripts/safeguard-e2e-guard.sh header)." >&2
  exit 1
fi

# Match CI: ensure the Safeguard schema is up-to-date in the target
# Postgres before the test runs (the GitHub workflow does this in its
# "Push Safeguard schema" step). Without it a fresh DB will 500 the
# first request and the suite fails non-deterministically.
pnpm --filter @workspace/db run push --force

# Make sure the Playwright browser is installed locally — CI does this
# in a separate step, but the validation step needs to be self-contained.
pnpm --filter @workspace/safeguard exec playwright install chromium >/dev/null

# Force Playwright to manage its own servers (matches the CI run mode).
export E2E_BASE_URL=""

exec pnpm run test:e2e
