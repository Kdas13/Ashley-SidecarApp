import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "safeguard-api" });
});

export default router;
