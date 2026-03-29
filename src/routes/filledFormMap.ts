import { Router, Request, Response } from "express";
import { fillFormMap } from "../services/fillFormMap";
import { FilledFormMap } from "../models/FilledFormMap";
import type { AssumptionLevel } from "../types";

const router = Router();

function serverError(res: Response, err: unknown): void {
  console.error("[filledFormMap]", err);
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// ─── POST /api/filled-map/fill ────────────────────────────────────────────────
router.post("/fill", async (req: Request, res: Response) => {
  try {
    const { formId, userId, situationalContextId, assumptionLevel } = req.body ?? {};

    if (!formId || typeof formId !== "string") {
      res.status(400).json({ error: "formId (string) is required" });
      return;
    }
    if (!userId || typeof userId !== "string") {
      res.status(400).json({ error: "userId (string) is required" });
      return;
    }
    if (!situationalContextId || typeof situationalContextId !== "string") {
      res.status(400).json({ error: "situationalContextId (string) is required" });
      return;
    }

    const validLevels: AssumptionLevel[] = ["conservative", "moderate", "liberal"];
    const level: AssumptionLevel =
      validLevels.includes(assumptionLevel) ? assumptionLevel : "conservative";

    const result = await fillFormMap({ formId, userId, situationalContextId, assumptionLevel: level });
    res.status(201).json(result);
  } catch (err) {
    serverError(res, err);
  }
});

// ─── GET /api/filled-map/user/:userId ─────────────────────────────────────────
router.get("/user/:userId", async (req: Request, res: Response) => {
  try {
    const filter: Record<string, string> = { userId: req.params.userId };
    if (req.query.formId) filter.formId = String(req.query.formId);

    const docs = await FilledFormMap.find(filter).sort({ createdAt: -1 }).lean();
    res.json(docs);
  } catch (err) {
    serverError(res, err);
  }
});

// ─── GET /api/filled-map/:id ──────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await FilledFormMap.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.json(doc.toObject());
  } catch (err) {
    serverError(res, err);
  }
});

export default router;
