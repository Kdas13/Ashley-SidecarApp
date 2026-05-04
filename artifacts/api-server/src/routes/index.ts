import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageRouter from "./image";
import stateRouter from "./state";
import memoriesRouter from "./memories";
import carryoverRouter from "./carryover";
import { requireApiKey } from "../middleware/apiKey";

const router: IRouter = Router();

// Health check is exempt from authentication so load-balancers and monitors
// can reach it without credentials.
router.use(healthRouter);

// Gate pattern: health is public; all other mounted routers require X-API-Key.
// All other mounted routers require the X-API-Key header to match API_SECRET.
// This provides defense-in-depth alongside global rate limiting.
router.use(requireApiKey);

// Mounted routers. The api is per-device: every authenticated request
// carries `Authorization: Bearer <token>` AND `X-Device-Id: <uuid>`.
// All persistent state (state, memories, carryover) is keyed by the device id.
router.use(stateRouter);
router.use(memoriesRouter);
router.use(carryoverRouter);
router.use(chatRouter);
router.use(imageRouter);

export default router;
