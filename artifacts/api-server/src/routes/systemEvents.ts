import { Router } from "express";
import { z } from "zod";
import {
  addSystemEvent,
  getSystemEvents,
  type SystemEventStatus,
} from "../lib/systemEvents";

const router = Router();

const ALLOWED_STATUSES: SystemEventStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "RESOLVED",
  "CLOSED",
  "WONT_FIX",
];

const SystemEventBodySchema = z.object({
  ref: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED", "WONT_FIX"]),
  reason: z.string().max(2000).optional(),
  resolvedAt: z.string().datetime().optional(),
  closedAt: z.string().datetime().optional(),
});

// GET /api/system/events — list all events (most recent first)
router.get("/system/events", (_req, res): void => {
  res.json({ events: getSystemEvents() });
});

// POST /api/system/events — add a runtime event
// Persisted in-process only (resets on restart). Use STATIC_EVENTS in
// lib/systemEvents.ts for permanent entries.
router.post("/system/events", (req, res): void => {
  const parsed = SystemEventBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const event = parsed.data;
  // Default closedAt / resolvedAt to now for RESOLVED/CLOSED/WONT_FIX if not provided
  if (
    (event.status === "RESOLVED" ||
      event.status === "CLOSED" ||
      event.status === "WONT_FIX") &&
    !event.closedAt &&
    !event.resolvedAt
  ) {
    event.closedAt = new Date().toISOString();
  }
  addSystemEvent(event);
  req.log.info(
    { ref: event.ref, status: event.status },
    "System event added via API",
  );
  res.status(201).json({ event, events: getSystemEvents() });
});

// Unused import guard (ALLOWED_STATUSES is used in schema, keep TS happy)
void ALLOWED_STATUSES;

export default router;
