export type SelfieSlotResult = {
  ok: true;
  used: number;
  cap: number;
  remaining: number;
};

export function tryClaimSelfieSlot(_deviceId: string): SelfieSlotResult {
  return { ok: true, used: 0, cap: Infinity, remaining: Infinity };
}
