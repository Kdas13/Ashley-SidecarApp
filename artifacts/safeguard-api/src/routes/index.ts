import { Router, type IRouter } from "express";
import healthRouter from "./health";
import profileRouter from "./profile";
import checkinsRouter from "./checkins";
import observationsRouter from "./observations";
import invariantsRouter from "./invariants";
import translateRouter from "./translate";
import appointmentsRouter from "./appointments";
import pushRouter from "./push";

const router: IRouter = Router();

router.use(healthRouter);
router.use(invariantsRouter);
router.use(profileRouter);
router.use(checkinsRouter);
router.use(observationsRouter);
router.use(translateRouter);
router.use(appointmentsRouter);
router.use(pushRouter);

export default router;
