import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { buildSituationContext } from "../services/buildSituationContext";
import { fillFormMap } from "../services/fillFormMap";
import { SituationalContext } from "../models/SituationalContext";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { assertSessionPaid } from "../services/stripe";
import {
  logAppError,
  requestErrorMeta,
  ClaudeContentError,
  ClaudeParseError,
} from "../models/AppError";

const router = Router();
const upload = multer({ dest: os.tmpdir() });

function serverError(
  req: Request,
  res: Response,
  err: unknown,
  service: string
): void {
  console.error(`[${service}]`, err);
  let status = 500;
  if (err instanceof ClaudeContentError) status = 422;
  else if (err instanceof ClaudeParseError) status = 502;
  logAppError({ err, service, request: req });
  const message = err instanceof ClaudeContentError
    ? err.message
    : "An internal error occurred. Please try again.";
  res.status(status).json({ error: message });
}

// POST /api/situation/build
//
// Creates a SituationalContext stub, returns 202 immediately, then runs
// the full pipeline in the background:
//   1. buildSituationContext (Anthropic) → updates stub with partyData, requiredForms
//   2. fillFormMap (×N)                 → creates FilledFormMap per required form
//
// The frontend polls GET /api/situation/:id for the context status and
// GET /api/filled-map/user/:userId for completed form maps.
//
router.post("/build", requireAuth, upload.array("documents", 50), async (req: Request, res: Response) => {
  console.log(`[POST /api/situation/build] ${authTag(req)} | Building situational context`);
  try {
    const userId = req.auth!.sub;
    const { situationDescription, processDescription, additionalNotes, stripeSessionId } = req.body as {
      situationDescription?: string;
      processDescription?: string;
      additionalNotes?: string;
      stripeSessionId?: string;
    };

    const paid = await assertSessionPaid(stripeSessionId, userId);
    if (!paid.ok) {
      console.log(`[POST /api/situation/build] ${authTag(req)} | ${paid.status} — ${paid.error}`);
      res.status(paid.status).json({ error: paid.error });
      return;
    }

    if (!situationDescription) {
      console.log(`[POST /api/situation/build] ${authTag(req)} | 400 — missing situationDescription`);
      res.status(400).json({ error: "situationDescription is required" });
      return;
    }
    if (!processDescription) {
      console.log(`[POST /api/situation/build] ${authTag(req)} | 400 — missing processDescription`);
      res.status(400).json({ error: "processDescription is required" });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

    // Pre-create a stub document so we have an _id to return
    const stub = await SituationalContext.create({
      userId,
      status: "processing",
      partyData: {},
      documents: [],
      situationSummary: "",
      requiredForms: [],
    });

    // Snapshot request meta now so we can still tag background errors with the
    // originating IP and email after the response has been sent.
    const backgroundRequestMeta = requestErrorMeta(req, "POST /api/situation/build (background)");

    // Return 202 immediately — the pipeline runs in the background
    console.log(`[POST /api/situation/build] ${authTag(req)} | 202 — stub created id=${stub._id}`);
    res.status(202).json({
      _id: stub._id.toString(),
      userId,
      status: "processing",
    });

    // ── Background pipeline (fire-and-forget) ─────────────────────────────
    (async () => {
      try {
        console.log(`[background] ${authTag(req)} | Starting Anthropic context build id=${stub._id}`);

        // Step 1: Build situational context via Anthropic (updates the stub doc)
        const ctx = await buildSituationContext(
          {
            userId,
            uiAnswers: { situationDescription, processDescription, additionalNotes },
            uploadedFiles: uploadedFiles.map((f) => ({
              path: f.path,
              originalname: f.originalname,
              mimetype: f.mimetype,
            })),
          },
          stub._id.toString()
        );

        console.log(
          `[background] ${authTag(req)} | Context ready id=${stub._id} forms=${ctx.requiredForms.join(",") || "none"}`
        );

        // Step 2: Fill form maps for each required form
        for (const formId of ctx.requiredForms) {
          try {
            console.log(`[background] ${authTag(req)} | Filling form map ${formId}`);
            await fillFormMap({
              formId,
              userId,
              situationalContextId: stub._id.toString(),
            });
            console.log(`[background] ${authTag(req)} | Form map ready ${formId}`);
          } catch (err) {
            console.error(`[background] ${authTag(req)} | Form map failed ${formId}:`, err);
            logAppError({
              err,
              service: "POST /api/situation/build (background fillFormMap)",
              request: backgroundRequestMeta,
              formId,
              situationalContextId: stub._id.toString(),
              userId,
            });
          }
        }

        console.log(`[background] ${authTag(req)} | Pipeline complete id=${stub._id}`);
      } catch (err) {
        console.error(`[background] ${authTag(req)} | Pipeline failed id=${stub._id}:`, err);
        logAppError({
          err,
          service: "POST /api/situation/build (background buildSituationContext)",
          request: backgroundRequestMeta,
          situationalContextId: stub._id.toString(),
          userId,
        });
        await SituationalContext.findByIdAndUpdate(stub._id, { status: "error" }).catch(() => {});
      }
    })();
  } catch (err) {
    console.error(`[POST /api/situation/build] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, "POST /api/situation/build");
  }
});

// GET /api/situation/user/:userId
router.get("/user/:userId", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/situation/user] ${authTag(req)} | Listing user contexts`);
  try {
    const docs = await SituationalContext.find({ userId: req.auth!.sub })
      .sort({ createdAt: -1 })
      .lean();
    console.log(`[GET /api/situation/user] ${authTag(req)} | 200 — returned ${docs.length} docs`);
    res.json(docs);
  } catch (err) {
    console.error(`[GET /api/situation/user] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, "GET /api/situation/user/:userId");
  }
});

// GET /api/situation/:id
router.get("/:id", async (req: Request, res: Response) => {
  console.log(`[GET /api/situation/:id] ${authTag(req)} | Fetching context by id`);
  try {
    const doc = await SituationalContext.findById(req.params.id);
    if (!doc) {
      console.log(`[GET /api/situation/:id] ${authTag(req)} | 404 — not found id=${req.params.id}`);
      res.status(404).json({ error: "Not found." });
      return;
    }
    console.log(`[GET /api/situation/:id] ${authTag(req)} | 200 — found id=${req.params.id} status=${(doc as any).status}`);
    res.json(doc.toObject());
  } catch (err) {
    console.error(`[GET /api/situation/:id] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, "GET /api/situation/:id");
  }
});

export default router;
