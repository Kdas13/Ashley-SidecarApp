const counts = new Map<string, number>();

function todayKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function deviceDayKey(deviceId: string): string {
  return `${deviceId}:${todayKey()}`;
}

export function selfieDailyCap(): number {
  const raw = process.env.ASHLEY_SELFIE_DAILY_CAP;
  if (!raw) return 5;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

export type SelfieSlotResult = {
  ok: boolean;
  used: number;
  cap: number;
  remaining: number;
};

export function tryClaimSelfieSlot(deviceId: string): SelfieSlotResult {
  pruneIfStale();
  const cap = selfieDailyCap();
  const key = deviceDayKey(deviceId);
  const used = counts.get(key) ?? 0;
  if (used >= cap) {
    return { ok: false, used, cap, remaining: 0 };
  }
  counts.set(key, used + 1);
  return { ok: true, used: used + 1, cap, remaining: cap - (used + 1) };
}

let lastPrune = 0;
function pruneIfStale(): void {
  const now = Date.now();
  if (now - lastPrune < 60 * 60 * 1000) return;
  lastPrune = now;
  if (counts.size < 1000) return;
  const today = todayKey();
  for (const k of counts.keys()) {
    if (!k.endsWith(today)) counts.delete(k);
  }
}
