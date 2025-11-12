import { Router } from "express";
import { deleteSession, getSession, requestSession, submitHint } from "./controller.js";

const router = Router();

router.post("/session", requestSession);
router.get("/session/:id", getSession);
router.delete("/session/:id", deleteSession);
router.post("/session/:id/hint", submitHint);

export default router;
