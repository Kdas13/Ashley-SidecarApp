import { Router, type IRouter } from "express";
import healthRouter from "./health";
import chatRouter from "./chat";
import imageRouter from "./image";

const router: IRouter = Router();

// Mounted routers. Legacy DB-backed CRUD routers (profile, memories,
// conversation-summaries) and legacy server-stored chat-messages handlers
// were removed as part of the V1 security pass — the mobile client is
// local-first and never called them, leaving them as unauthenticated
// attack surface. Only the stateless AI endpoints + healthz + static
// selfie serving remain.
router.use(healthRouter);
router.use(chatRouter);
router.use(imageRouter);

export default router;
