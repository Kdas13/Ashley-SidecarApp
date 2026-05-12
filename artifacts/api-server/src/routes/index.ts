import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageRouter from "./image";
import stateRouter from "./state";
import memoriesRouter from "./memories";
import carryoverRouter from "./carryover";
import webSearchRouter from "./webSearch";
import proactiveRouter from "./proactive";
import debugRouter from "./debug";
import improvementsRouter from "./improvements";
import ticketsRouter from "./tickets";
import plansRouter from "./plans";
import packetsRouter from "./packets";
import queueRouter from "./queue";
import maintainerRouter from "./maintainer";
import systemEventsRouter from "./systemEvents";
import { requireApiKey } from "../middleware/apiKey";

const router: IRouter = Router();

// Health check is exempt from authentication so load-balancers and monitors
// can reach it without credentials.
router.use(healthRouter);

// imageRouter serves static selfie/user-image PNGs to React Native <Image>
// tags, which cannot attach Authorization or X-API-Key headers. These URLs
// already use unguessable UUIDs as the capability token, and the outer
// app.ts gate also exempts /selfies/ and /user-images/ from rate limiting +
// the Bearer auth check. Mount it BEFORE requireApiKey so the inner
// X-API-Key gate doesn't 401 every <Image> fetch.
router.use(imageRouter);

// Gate pattern: health + static images above are public; all other mounted
// routers require the X-API-Key header to match API_SECRET. This provides
// defense-in-depth alongside global rate limiting.
router.use(requireApiKey);

// Mounted routers. The api is per-device: every authenticated request
// carries `Authorization: Bearer <token>` AND `X-Device-Id: <uuid>`.
// All persistent state (state, memories, carryover) is keyed by the device id.
router.use(stateRouter);
router.use(memoriesRouter);
router.use(carryoverRouter);
router.use(webSearchRouter);
router.use(proactiveRouter);
router.use(debugRouter);
router.use(ticketsRouter);
router.use(improvementsRouter);
router.use(plansRouter);
router.use(packetsRouter);
router.use(queueRouter);
router.use(maintainerRouter);
router.use(systemEventsRouter);
router.use(chatRouter);

export default router;
