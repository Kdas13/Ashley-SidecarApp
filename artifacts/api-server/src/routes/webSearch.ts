import { Router, type IRouter } from "express";
import { z } from "zod";

import { getDeviceId } from "../middleware/deviceId";
import {
  tavilySearch,
  WebSearchProviderError,
  WebSearchUnavailableError,
} from "../lib/webSearch";

const router: IRouter = Router();

const WebSearchBodySchema = z.object({
  query: z.string().min(1).max(500),
  reason: z.string().max(200).optional(),
});

// POST /api/tools/web-search
//
// Auth (X-API-Key) and device-id (X-Device-Id) are enforced by the global
// gate in app.ts and the inner requireApiKey mount in routes/index.ts —
// this router is mounted AFTER both so we don't need to re-check here.
//
// Returns a simplified [{title, url, content}] array. Provider errors are
// translated to 502, missing key to 503, validation to 400.
router.post("/tools/web-search", async (req, res): Promise<void> => {
  const deviceId = getDeviceId(req);
  const parsed = WebSearchBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: parsed.error.issues[0]?.message ?? "Invalid web-search payload",
    });
    return;
  }
  const { query, reason } = parsed.data;
  try {
    const results = await tavilySearch(query);
    req.log.info(
      {
        deviceId,
        query: query.slice(0, 80),
        reason: reason?.slice(0, 80),
        resultCount: results.length,
      },
      "web-search ok",
    );
    res.json({ results });
  } catch (err) {
    if (err instanceof WebSearchUnavailableError) {
      res.status(503).json({
        error:
          "Web search is not configured on this server (TAVILY_API_KEY missing).",
      });
      return;
    }
    if (err instanceof WebSearchProviderError) {
      req.log.warn({ err: err.message }, "Tavily provider error");
      res.status(502).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Unexpected web-search failure");
    res.status(500).json({ error: "Web search failed" });
  }
});

export default router;
