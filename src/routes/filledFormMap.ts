import { Router, Request, Response } from "express";
import { fillFormMap } from "../services/fillFormMap";
import { FilledFormMap } from "../models/FilledFormMap";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { logAppError, ClaudeContentError, ClaudeParseError } from "../models/AppError";
import type { AssumptionLevel } from "../types";

const router = Router();

function serverError(
  req: Request,
  res: Response,
  err: unknown,
  service: string,
  extra?: { formId?: string; situationalContextId?: string }
): void {
  console.error(`[${service}]`, err);
  let status = 500;
  if (err instanceof ClaudeContentError) status = 422;
  else if (err instanceof ClaudeParseError) status = 502;
  logAppError({ err, service, request: req, ...extra });
  const message = err instanceof ClaudeContentError
    ? err.message
    : "An internal error occurred. Please try again.";
  res.status(status).json({ error: message });
}

// ─── POST /api/filled-map/fill ────────────────────────────────────────────────
router.post("/fill", requireAuth, async (req: Request, res: Response) => {
  console.log(`[POST /api/filled-map/fill] ${authTag(req)} | Filling single form map`);
  try {
    const userId = req.auth!.sub;
    const { formId, situationalContextId, assumptionLevel, beneficiaryKey } = req.body ?? {};

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
      validLevels.includes(assumptionLevel) ? assumptionLevel : "liberal";

    const result = await fillFormMap({
      formId,
      userId,
      situationalContextId,
      assumptionLevel: level,
      ...(typeof beneficiaryKey === "string" && beneficiaryKey.trim() !== ""
        ? { beneficiaryKey }
        : {}),
    });
    console.log(`[POST /api/filled-map/fill] ${authTag(req)} | 201 — form map created for ${formId}`);
    res.status(201).json(result);
  } catch (err) {
    console.error(`[POST /api/filled-map/fill] ${authTag(req)} | 500 — server error`);
    const { formId, situationalContextId } = (req.body ?? {}) as {
      formId?: string;
      situationalContextId?: string;
    };
    serverError(req, res, err, "POST /api/filled-map/fill", { formId, situationalContextId });
  }
});

// ─── GET /api/filled-map/user/:userId ─────────────────────────────────────────
router.get("/user/:userId", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/filled-map/user] ${authTag(req)} | Listing user form maps`);
  try {
    // Use verified identity — ignore the URL param to prevent enumeration
    const filter: Record<string, string> = { userId: req.auth!.sub };
    if (req.query.formId) filter.formId = String(req.query.formId);
    if (req.query.beneficiaryKey) filter.beneficiaryKey = String(req.query.beneficiaryKey);

    const docs = await FilledFormMap.find(filter).sort({ createdAt: -1 }).lean();
    console.log(`[GET /api/filled-map/user] ${authTag(req)} | 200 — returned ${docs.length} maps`);
    res.json(docs);
  } catch (err) {
    console.error(`[GET /api/filled-map/user] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, "GET /api/filled-map/user/:userId");
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
    serverError(req, res, err, "GET /api/filled-map/:id");
  }
});

export default router;
