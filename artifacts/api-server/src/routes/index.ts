import { Router, type IRouter } from "express";
import express from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import chatRouter from "./chat";
import memoriesRouter from "./memories";
import imageRouter from "./image";
import { selfieDir } from "../lib/storage";

const router: IRouter = Router();

// Serve generated selfies from /api/selfies/* with permissive caching.
router.use(
  "/selfies",
  express.static(selfieDir, {
    maxAge: "30d",
    fallthrough: true,
    index: false,
  }),
);

router.use(healthRouter);
router.use(profileRouter);
router.use(chatRouter);
router.use(memoriesRouter);
router.use(imageRouter);

export default router;
