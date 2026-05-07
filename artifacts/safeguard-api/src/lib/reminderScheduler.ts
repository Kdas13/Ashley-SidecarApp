/**
 * Pure scheduling helpers for follow-up reminders.
 *
 * Cadence shapes (validated at the route boundary, persisted as jsonb on
 * `safeguard_followups.cadence`):
 *
 *   { kind: "none" }
 *     — no scheduled reminder. Used for escalation items where the trigger
 *       is "if X gets worse" rather than a clock time.
 *
 *   { kind: "once", at: ISOString }
 *     — fire exactly once at the given absolute time.
 *
 *   { kind: "recurring",
 *       startAt: ISOString,
 *       timesPerDay: 1..6,
 *       durationDays: 1..60 }
 *     — fire `timesPerDay` reminders every 24h starting at `startAt`,
 *       stopping after `timesPerDay * durationDays` total reminders.
 *
 * The scheduler never reaches outside this module — given a cadence and
 * the count of reminders already sent, it returns the next absolute
 * timestamp (or null when the schedule is exhausted). All callers then
 * persist that timestamp to `next_reminder_at`.
 */

export type Cadence =
  | { kind: "none" }
  | { kind: "once"; at: string }
  | {
      kind: "recurring";
      startAt: string;
      timesPerDay: number;
      durationDays: number;
    };

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

function clampInt(value: unknown, lo: number, hi: number): number | null {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  if (r < lo || r > hi) return null;
  return r;
}

/**
 * Coerce raw user/AI-supplied input into a valid Cadence, falling back to
 * `{ kind: "none" }` for anything we don't recognise. Never throws — the
 * caller has already accepted the request and shouldn't be punished for
 * the AI emitting a slightly off shape.
 */
export function parseCadence(input: unknown): Cadence {
  if (!input || typeof input !== "object") return { kind: "none" };
  const raw = input as Record<string, unknown>;
  if (raw["kind"] === "once" && isIsoDate(raw["at"])) {
    return { kind: "once", at: new Date(raw["at"] as string).toISOString() };
  }
  if (raw["kind"] === "recurring" && isIsoDate(raw["startAt"])) {
    const tpd = clampInt(raw["timesPerDay"], 1, 6);
    const dd = clampInt(raw["durationDays"], 1, 60);
    if (tpd === null || dd === null) return { kind: "none" };
    return {
      kind: "recurring",
      startAt: new Date(raw["startAt"] as string).toISOString(),
      timesPerDay: tpd,
      durationDays: dd,
    };
  }
  return { kind: "none" };
}

/**
 * Return the absolute time the n-th reminder (0-indexed) should fire, or
 * null if the schedule has no slot for that index. This is the single
 * source of truth for "when is the next reminder?" — both the create
 * path and the post-send advance path call it.
 */
export function nthReminderAt(cadence: Cadence, index: number): Date | null {
  if (index < 0) return null;
  if (cadence.kind === "none") return null;
  if (cadence.kind === "once") {
    return index === 0 ? new Date(cadence.at) : null;
  }
  // recurring
  const total = cadence.timesPerDay * cadence.durationDays;
  if (index >= total) return null;
  const intervalMs = MS_PER_DAY / cadence.timesPerDay;
  const t = new Date(cadence.startAt).getTime() + index * intervalMs;
  return new Date(t);
}

/**
 * After firing reminder #n, return the next absolute time to fire (or
 * null when the schedule is done). Convenience wrapper for the worker.
 */
export function nextReminderAfter(
  cadence: Cadence,
  alreadySent: number,
): Date | null {
  return nthReminderAt(cadence, alreadySent);
}

/**
 * Best-effort "what does this cadence sound like in plain English" — used
 * for the audit log and as the fallback rendering when the UI hasn't
 * shipped a per-language phrase yet. Never user-facing on its own.
 */
export function describeCadence(cadence: Cadence): string {
  if (cadence.kind === "none") return "no reminder";
  if (cadence.kind === "once") return `once at ${cadence.at}`;
  return `${cadence.timesPerDay}x daily for ${cadence.durationDays} days from ${cadence.startAt}`;
}

export const SCHEDULER_INTERNALS = { MS_PER_HOUR, MS_PER_DAY };
