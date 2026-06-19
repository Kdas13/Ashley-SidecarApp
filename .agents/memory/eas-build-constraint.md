---
name: EAS build sandbox constraint
description: eas build cannot be initiated from the Replit main agent due to sandbox blocking of destructive git operations.
---

# EAS build — Replit main agent cannot run it

## The rule
Never attempt to run `eas build` or `pnpm --filter @workspace/mobile exec eas build` from the main agent. It will fail.

**Why:** The EAS CLI archives the working tree using a git operation (git archive or equivalent) that the Replit main agent sandbox classifies as a destructive git operation and blocks. The error is:
  "Destructive git operations are not allowed in the main agent."

**How to apply:** Any brief that requires an EAS build must mark that item as NOT TESTABLE BY WREN, with the instruction for Kane to run it from the Shell tab:
  `pnpm --filter @workspace/mobile exec eas build --platform android`

Server-side changes (API server) deploy immediately via workflow restart and do not require an EAS build. Client-side changes (anything in `artifacts/mobile/`) require an EAS build before they reach the production APK.
