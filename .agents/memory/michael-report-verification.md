---
name: Michael completion report verification rule
description: Standing rule — every Michael work report must verify live deployment before claiming done; commit ≠ deployment.
---

## Rule

No completion report on Michael (michael-orchestrator, Railway) may claim something is "done," "live," "deployed," or "complete" based on a GitHub commit alone.

Every report must include, before being sent:

1. A direct `curl` of `https://michael-orchestrator-production.up.railway.app/health` confirming `constitutionVersion` matches the version the report claims is live.
2. A spot-check of at least one new or changed endpoint confirming it returns the expected response (not a 404, not the old behaviour).

Only after both checks pass may the report use the words "done," "live," or "complete."

**Why:** Reports had been calling things done based on a successful GitHub push, while the live Railway service was still running an older build (e.g. data-model fix reported as live while /health still showed v4, not v6). Railway has no auto-deploy webhook configured — every deploy is manual. Even when a webhook is set up, builds can fail silently. Committing and deploying are separate acts; the report must verify the second one actually happened.

**How to apply:**

- After any Michael commit, curl /health before writing the completion summary.
- If the live version doesn't match, do not claim the work is done — instead report "committed, pending deploy" and give Kane the manual deploy steps.
- The bar matches what Ashley reports already use: no "NOT TESTED" allowed, verdict + timestamp required.
- Applies to all future sessions, not just the session that created this rule.
