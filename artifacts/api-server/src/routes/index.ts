import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageRouter from "./image";
import stateRouter from "./state";
import memoriesRouter from "./memories";
import carryoverRouter from "./carryover";

const router: IRouter = Router();

// Mounted routers. The api is per-device: every authenticated request
// carries `Authorization: Bearer <api key>` AND `X-Device-Id: <uuid>`.
// All persistent state (profile, messages, memories, summaries) is keyed
// by the device id.
router.use(healthRouter);
router.use(stateRouter);
router.use(memoriesRouter);
router.use(carryoverRouter);
router.use(chatRouter);
router.use(imageRouter);

export default router;
