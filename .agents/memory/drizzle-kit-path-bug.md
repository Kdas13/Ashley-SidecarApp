---
name: Drizzle-kit generate path bug
description: drizzle-kit generate fails in this monorepo; write migrations manually.
---

## Rule
`pnpm --filter @workspace/db exec drizzle-kit generate` fails with:
`ENOENT: .//home/runner/workspace/lib/db/migrations/meta/0000_snapshot.json`
The double-slash path is a drizzle-kit 0.31.9 bug with `__dirname` resolution in the config.

**Why:** The drizzle.config.ts uses `path.join(__dirname, "./migrations")` but drizzle-kit resolves it as `./<absolute-path>` in some contexts.

**How to apply:**
1. Write the migration SQL file manually to `lib/db/migrations/NNNN_description.sql` (idempotent: use `ADD COLUMN IF NOT EXISTS`).
2. Add the entry to `lib/db/migrations/meta/_journal.json` with the correct idx.
3. Apply the SQL via `executeSql()` in the code_execution tool.
4. Rebuild lib declarations: `pnpm run typecheck:libs`.
