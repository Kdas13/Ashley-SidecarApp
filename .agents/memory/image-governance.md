---
name: Image governance architecture
description: How Section 9 image governance params travel through the system (Ashley-Sidecar).
---

## Rule
Governance params travel via request body — never persisted to the selfie job's in-memory store except in the `SelfieJob` pending shape (for resume-after-restart). DB columns hold user preferences (the Mode 1 defaults set in the profile screen). The server-side engine (`imageGovernance.ts`) decides actual values at generation time.

**Why:** Same pattern as `imageGenerationEnabled` — stateless request-scoped toggle, no DB round-trip in the hot path.

**How to apply:**
- `startSelfieJob` in aiClient.ts reads governance via `getGovernanceParams()` (module-level snapshot, same pattern as `canUseImageGeneration()`).
- `useImageGate` hook syncs governance snapshot via `syncGovernanceFromProfile` whenever profile fields change.
- Server entry point: `applyGovernance()` in `generateAshleySelfie`, called after mode resolution, before `wrapperFor()`.
- Only overrides `PORTRAIT_MODE` — all other modes were explicitly requested by the user.
- `governedVibePrefix` is injected into identity-mode scene block only (not descriptor or OBJECT_ONLY paths).
