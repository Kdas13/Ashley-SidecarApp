import { Router, type IRouter } from "express";
import {
  db,
  safeguardObservationsTable,
  safeguardCheckinsTable,
} from "@workspace/db";
import { desc, eq, gte, and } from "drizzle-orm";

const router: IRouter = Router();

/**
 * Detect simple safeguarding-relevant patterns over a window of check-ins
 * and surface them as synthetic trend observations alongside per-checkin
 * ones. Trends are computed on read (not stored) so the rules can evolve
 * without backfilling, and the API returns them tagged with `kind` so the
 * UI can render them differently.
 *
 * Two phase-1 trend rules:
 *   - repeated_distress: 3+ check-ins in the window where ANY of pain/
 *     safety/generalFeeling indicates distress (pain >= 7, OR safety <= 3,
 *     OR generalFeeling <= 3).
 *   - missed_checkin: most recent check-in is more than 3 days ago (or
 *     none exist in the window) — surfaces as a single observation. We do
 *     not infer "why"; the GP decides.
 */
interface CheckinForTrend {
  id: string;
  createdAt: Date;
  generalFeelingScore: number | null;
  painScore: number | null;
  safetyScore: number | null;
}

interface TrendObservation {
  kind: "trend_repeated_distress" | "trend_missed_checkin";
  summary: string;
  bullets: string[];
  flagged: boolean;
  windowStart: string;
  windowEnd: string;
}

function isDistress(c: CheckinForTrend): boolean {
  if (c.painScore !== null && c.painScore >= 7) return true;
  if (c.safetyScore !== null && c.safetyScore <= 3) return true;
  if (c.generalFeelingScore !== null && c.generalFeelingScore <= 3) return true;
  return false;
}

function computeTrends(
  checkins: CheckinForTrend[],
  windowDays: number,
): TrendObservation[] {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - windowDays);
  const out: TrendObservation[] = [];

  const distressCount = checkins.filter(isDistress).length;
  if (distressCount >= 3) {
    out.push({
      kind: "trend_repeated_distress",
      summary:
        `Across the last ${windowDays} days, ${distressCount} check-ins ` +
        `included one or more distress indicators (pain >= 7, safety <= 3, ` +
        `or general feeling <= 3). This is observational; the GP decides ` +
        `next steps.`,
      bullets: [
        `[FLAG] Repeated distress indicators across ${distressCount} of the last ${checkins.length} check-ins.`,
      ],
      flagged: true,
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
    });
  }

  const last = checkins[0];
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  if (!last || last.createdAt < threeDaysAgo) {
    const lastSeen = last
      ? `Last check-in was on ${last.createdAt.toISOString().slice(0, 10)}.`
      : `No check-ins recorded in the last ${windowDays} days.`;
    out.push({
      kind: "trend_missed_checkin",
      summary: `${lastSeen} The user has not checked in for at least 3 days.`,
      bullets: [`No check-in in 3+ days.`],
      flagged: false,
      windowStart: windowStart.toISOString(),
      windowEnd: now.toISOString(),
    });
  }

  return out;
}

router.get("/me/observations", async (req, res, next) => {
  try {
    const userId = req.auth!.userId;
    const days = Math.min(Number(req.query.days) || 7, 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const observationRows = await db
      .select({
        observation: safeguardObservationsTable,
        checkin: safeguardCheckinsTable,
      })
      .from(safeguardObservationsTable)
      .innerJoin(
        safeguardCheckinsTable,
        eq(safeguardObservationsTable.checkinId, safeguardCheckinsTable.id),
      )
      .where(
        and(
          eq(safeguardObservationsTable.userId, userId),
          gte(safeguardObservationsTable.createdAt, since),
        ),
      )
      .orderBy(desc(safeguardObservationsTable.createdAt));

    const checkinRows = await db
      .select({
        id: safeguardCheckinsTable.id,
        createdAt: safeguardCheckinsTable.createdAt,
        generalFeelingScore: safeguardCheckinsTable.generalFeelingScore,
        painScore: safeguardCheckinsTable.painScore,
        safetyScore: safeguardCheckinsTable.safetyScore,
      })
      .from(safeguardCheckinsTable)
      .where(
        and(
          eq(safeguardCheckinsTable.userId, userId),
          gte(safeguardCheckinsTable.createdAt, since),
        ),
      )
      .orderBy(desc(safeguardCheckinsTable.createdAt));

    const trends = computeTrends(checkinRows, days);

    res.json({ observations: observationRows, trends });
  } catch (err) {
    next(err);
  }
});

export default router;
