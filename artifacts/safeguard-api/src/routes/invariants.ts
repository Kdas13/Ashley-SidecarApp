import { Router, type IRouter } from "express";
import { SAFEGUARDING_INVARIANTS } from "../lib/safeguardingInvariants";

const router: IRouter = Router();

// Public so the mobile/web client can render the principles even before a
// user signs in (pilot_scope invariant).
router.get("/invariants", (_req, res) => {
  res.json({ invariants: SAFEGUARDING_INVARIANTS });
});

export default router;
