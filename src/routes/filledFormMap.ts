import { Router, Request, Response } from "express";
import { fillFormMap } from "../services/fillFormMap";
import { FilledFormMap } from "../models/FilledFormMap";
import { requireAuth, authTag } from "../middleware/requireAuth";
import type { AssumptionLevel } from "../types";

const router = Router();

function serverError(res: Response, err: unknown): void {
  console.error("[filledFormMap]", err);
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// ─── POST /api/filled-map/fill ────────────────────────────────────────────────
router.post("/fill", requireAuth, async (req: Request, res: Response) => {
  console.log(`[POST /api/filled-map/fill] ${authTag(req)} | Filling single form map`);
  try {
    const userId = req.auth!.sub;
    const { formId, situationalContextId, assumptionLevel } = req.body ?? {};

    if (!formId || typeof formId !== "string") {
      console.log(`[POST /api/filled-map/fill] ${authTag(req)} | 400 — missing formId`);
      res.status(400).json({ error: "formId (string) is required" });
      return;
    }
    if (!situationalContextId || typeof situationalContextId !== "string") {
      console.log(`[POST /api/filled-map/fill] ${authTag(req)} | 400 — missing contextId`);
      res.status(400).json({ error: "situationalContextId (string) is required" });
      return;
    }

    const validLevels: AssumptionLevel[] = ["conservative", "moderate", "liberal"];
    const level: AssumptionLevel =
      validLevels.includes(assumptionLevel) ? assumptionLevel : "conservative";

    const result = await fillFormMap({ formId, userId, situationalContextId, assumptionLevel: level });
    console.log(`[POST /api/filled-map/fill] ${authTag(req)} | 201 — form map created for ${formId}`);
    res.status(201).json(result);
  } catch (err) {
    console.error(`[POST /api/filled-map/fill] ${authTag(req)} | 500 — server error`);
    serverError(res, err);
  }
});

// ─── GET /api/filled-map/user/:userId ─────────────────────────────────────────
router.get("/user/:userId", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/filled-map/user] ${authTag(req)} | Listing user form maps`);
  try {
    // Use verified identity — ignore the URL param to prevent enumeration
    const filter: Record<string, string> = { userId: req.auth!.sub };
    if (req.query.formId) filter.formId = String(req.query.formId);

    const docs = await FilledFormMap.find(filter).sort({ createdAt: -1 }).lean();
    console.log(`[GET /api/filled-map/user] ${authTag(req)} | 200 — returned ${docs.length} maps`);
    res.json(docs);
  } catch (err) {
    console.error(`[GET /api/filled-map/user] ${authTag(req)} | 500 — server error`);
    serverError(res, err);
  }
});

// ─── GET /api/filled-map/:id ──────────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  console.log(`[GET /api/filled-map/:id] ${authTag(req)} | Fetching form map by id`);
  try {
    const doc = await FilledFormMap.findById(req.params.id);
    if (!doc) {
      console.log(`[GET /api/filled-map/:id] ${authTag(req)} | 404 — not found id=${req.params.id}`);
      res.status(404).json({ error: "Not found." });
      return;
    }
    console.log(`[GET /api/filled-map/:id] ${authTag(req)} | 200 — found id=${req.params.id}`);
    res.json(doc.toObject());
  } catch (err) {
    console.error(`[GET /api/filled-map/:id] ${authTag(req)} | 500 — server error`);
    serverError(res, err);
  }
});

export default router;
