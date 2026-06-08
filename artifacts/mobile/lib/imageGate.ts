/**
 * Image Generation Hard Gate
 *
 * Central, synchronous source of truth for whether image generation is
 * permitted. All image-related operations — UI controls, selfie triggers,
 * API calls, rendering — must consult canUseImageGeneration() before
 * proceeding.
 *
 * Architecture
 * ─────────────
 *   _imageGenEnabled   — module-level boolean; starts true (safe default so
 *                        the UI doesn't flash hidden on first render).
 *   _abortControllers  — registry of AbortControllers for in-flight selfie
 *                        network requests. When the gate turns OFF every
 *                        registered controller is aborted immediately.
 *
 * React components call useImageGate() which subscribes to profile changes
 * via React Query and calls syncGateFromProfile() as a side-effect so the
 * module-level state stays in sync.
 *
 * Non-React code (useMessages.ts, aiClient.ts) calls canUseImageGeneration()
 * synchronously — safe because syncGateFromProfile() is always called before
 * any async work begins in the component lifecycle.
 */

import { useEffect } from "react";
import { useProfile } from "./useProfile";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let _imageGenEnabled = true;
const _abortControllers = new Set<AbortController>();

// Section 9 governance params snapshot — updated whenever the profile changes.
// Starts null (triggers Mode 2 auto-selection on the server).
let _governanceParams: {
  imageCompositionMode?: string | null;
  imageEnvironmentDefault?: string | null;
  imageOccupancyDefault?: string | null;
  imageCameraDefault?: string | null;
} | null = null;

// ---------------------------------------------------------------------------
// Synchronous API (safe from async functions and non-React code)
// ---------------------------------------------------------------------------

/** Returns true when image generation is permitted. Never throws. */
export function canUseImageGeneration(): boolean {
  return _imageGenEnabled;
}

/**
 * Returns the current Section 9 governance params snapshot.
 * Called by startSelfieJob in aiClient.ts to attach governance to every
 * /chat/selfie request without threading the profile through the call chain.
 * Returns null when not yet synced — server falls back to Mode 2 auto-selection.
 */
export function getGovernanceParams(): typeof _governanceParams {
  return _governanceParams;
}

/**
 * Sync the governance snapshot from the current profile.
 * Called by useImageGate() whenever relevant profile fields change.
 */
export function syncGovernanceFromProfile(params: typeof _governanceParams): void {
  _governanceParams = params;
}

/**
 * Register an AbortController for an in-flight operation. The returned
 * function deregisters it (call it in a finally block or useEffect cleanup).
 * If the gate is already OFF, the controller is aborted immediately.
 */
export function registerSelfieAbortController(ac: AbortController): () => void {
  if (!_imageGenEnabled) {
    try {
      ac.abort();
    } catch {
      // ignore
    }
    return () => {};
  }
  _abortControllers.add(ac);
  return () => {
    _abortControllers.delete(ac);
  };
}

/**
 * Sync the module-level gate from the current profile value.
 * Called by useImageGate() whenever the profile changes.
 *
 * ON → OFF transition: every registered AbortController is signalled and
 * the registry is cleared so no stale references accumulate.
 */
export function syncGateFromProfile(enabled: boolean): void {
  const wasEnabled = _imageGenEnabled;
  _imageGenEnabled = enabled;
  if (wasEnabled && !enabled) {
    for (const ac of _abortControllers) {
      try {
        ac.abort();
      } catch {
        // ignore
      }
    }
    _abortControllers.clear();
  }
}

// ---------------------------------------------------------------------------
// React hook
// ---------------------------------------------------------------------------

/**
 * React hook. Returns whether image generation is currently enabled.
 * Also keeps the module-level gate in sync with the stored profile so
 * non-React call sites are always up to date.
 *
 * Mount this in the chat screen (or any screen that hosts image controls).
 * Prefer passing the returned boolean as a prop rather than calling this
 * hook in every leaf component.
 */
export function useImageGate(): boolean {
  const { data: profile } = useProfile();
  const enabled = profile?.imageGenerationEnabled !== false;

  useEffect(() => {
    syncGateFromProfile(enabled);
  }, [enabled]);

  // Sync governance snapshot whenever relevant profile fields change.
  const cm = profile?.imageCompositionMode ?? null;
  const ev = profile?.imageEnvironmentDefault ?? null;
  const oc = profile?.imageOccupancyDefault ?? null;
  const ca = profile?.imageCameraDefault ?? null;
  useEffect(() => {
    if (!profile) return;
    syncGovernanceFromProfile({
      imageCompositionMode: cm,
      imageEnvironmentDefault: ev,
      imageOccupancyDefault: oc,
      imageCameraDefault: ca,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cm, ev, oc, ca]);

  return enabled;
}
