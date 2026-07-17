# Ashley Sidecar — Railway Migration Phase 1

This branch prepares the backend for a controlled Railway staging deployment. It does not move production data, rotate the currently deployed credentials, change the APK, or deploy anything.

## Protected migration scope

Preserve:

- Ashley profile and relationship state
- Messages and conversation summaries
- Memories and memory-triage state
- Proactive settings and send ledger
- Kane's existing device identity
- Voice recovery records where they remain operationally relevant

Abandon by decision:

- Existing generated selfies
- Existing uploaded images and attachments
- Previous visual appearance
- Replit object-storage contents

New image storage will be provisioned later for images created after the move.

## Safety controls introduced here

- Railway configuration is versioned with the repository.
- Railway waits for `/api/readyz`, which checks required auth configuration and database reachability.
- The build runs the Sidecar API typecheck, tests and production bundle.
- `drizzle-kit push --force` is blocked.
- Replit's post-merge hook no longer mutates the database.
- Staging and production are restricted to one application replica until distributed locking exists.
- Deployment metadata exposes the running commit and declared migration version without exposing secrets.

## Database rule

The current migration folder is not a complete baseline for a fresh empty database. Staging must therefore begin from a full restored production snapshot, followed by reviewed versioned migrations. Do not point the first Railway deployment at an empty database and assume the existing migration files will reconstruct Ashley.

No production migration may run until all of the following are recorded:

1. Full PostgreSQL backup completed.
2. Backup restored successfully into an isolated staging database.
3. Table counts recorded before and after.
4. Kane's device row, profile, messages, memories and summaries verified.
5. Migration SQL independently reviewed.
6. Rollback database retained and tested.

## Railway staging setup

- Connect the service to `migration/railway-phase-1`, not `main`.
- Use one replica.
- Do not configure a pre-deploy migration command yet.
- Add staging-only secrets and a staging-only database.
- Set `ASHLEY_RUNTIME_REPLICAS=1`.
- Set `APP_MIGRATION_VERSION` to the reviewed migration identifier.
- Run `pnpm migration:verify-env` in the Railway shell before first traffic.
- Keep the Replit deployment untouched as rollback protection.

## Exit criteria for Phase 1

- GitHub CI passes.
- Railway staging builds from this branch.
- `/api/healthz` returns 200.
- `/api/readyz` returns 200 and reports the expected commit.
- No database schema command runs automatically.
- No production data or media has moved.

Phase 2 will create and verify the database baseline/restore procedure, then test Ashley's memory against the restored staging database.
