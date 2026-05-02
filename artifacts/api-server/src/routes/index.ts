import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import chatRouter from "./chat";
import memoriesRouter from "./memories";
import imageRouter from "./image";

const router: IRouter = Router();

router.use(healthRouter);
router.use(profileRouter);
router.use(chatRouter);
router.use(memoriesRouter);
router.use(imageRouter);

export default router;
