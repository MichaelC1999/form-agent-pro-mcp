import { Router, Request, Response } from "express";
import { FilledFormMap } from "../models/FilledFormMap";
import { SituationalContext } from "../models/SituationalContext";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { logAppError } from "../models/AppError";
import { resolveProcessId } from "../lib/processes";
import { generatePdf, streamPdfAndCleanup, selectMapsForContext, buildMergedPdf } from "../services/pdfDownloads";

const router = Router();

function serverError(
  req: Request,
  res: Response,
  err: unknown,
  service: string,
  extra?: { formId?: string; situationalContextId?: string }
): void {
  console.error(`[${service}]`, err);
  logAppError({ err, service, request: req, errorType: "pdf", ...extra });
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// ─── GET /api/pdf/form/:filledFormMapId ──────────────────────────────────────
// Download a single filled PDF for a specific FilledFormMap.
//
router.get("/form/:filledFormMapId", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/pdf/form] ${authTag(req)} | Downloading single form PDF`);
  try {
    const doc = await FilledFormMap.findById(req.params.filledFormMapId).lean();
    if (!doc) {
      console.log(`[GET /api/pdf/form] ${authTag(req)} | 404 — map not found`);
      res.status(404).json({ error: "FilledFormMap not found." });
      return;
    }

    if ((doc as any).userId !== req.auth!.sub) {
      console.log(`[GET /api/pdf/form] ${authTag(req)} | 403 — ownership mismatch`);
      res.status(403).json({ error: "Access denied." });
      return;
    }

    const formId = (doc as any).formId as string;
    const processId = resolveProcessId((doc as any).processId);
    console.log(`[GET /api/pdf/form] ${authTag(req)} | Generating PDF for ${formId}`);

    const outputPath = await generatePdf(
      req.params.filledFormMapId,
      formId,
      req.auth!.sub,
      processId
    );

    console.log(`[GET /api/pdf/form] ${authTag(req)} | 200 — streaming ${formId}.pdf`);
    streamPdfAndCleanup(res, outputPath, `${formId}.pdf`);
  } catch (err) {
    console.error(`[GET /api/pdf/form] ${authTag(req)} | 500 — generation failed`);
    serverError(req, res, err, "GET /api/pdf/form/:filledFormMapId");
  }
});

// ─── GET /api/pdf/merged/:situationalContextId ──────────────────────────────
// Download all forms for a context merged into a single PDF.
//
router.get("/merged/:situationalContextId", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/pdf/merged] ${authTag(req)} | Downloading merged PDF`);
  try {
    const ctx = await SituationalContext.findById(req.params.situationalContextId).lean();
    if (!ctx) {
      console.log(`[GET /api/pdf/merged] ${authTag(req)} | 404 — context not found`);
      res.status(404).json({ error: "SituationalContext not found." });
      return;
    }

    if ((ctx as any).userId !== req.auth!.sub) {
      console.log(`[GET /api/pdf/merged] ${authTag(req)} | 403 — ownership mismatch`);
      res.status(403).json({ error: "Access denied." });
      return;
    }

    // Latest map per required (form, beneficiary) for this user.
    const mapsToFill = await selectMapsForContext(req.auth!.sub, (ctx as any).requiredForms);

    if (mapsToFill.length === 0) {
      console.log(`[GET /api/pdf/merged] ${authTag(req)} | 400 — no filled maps found`);
      res.status(400).json({ error: "No filled form maps available for this context." });
      return;
    }

    console.log(`[GET /api/pdf/merged] ${authTag(req)} | Generating ${mapsToFill.length} PDFs`);
    const tmpMergedPath = await buildMergedPdf(mapsToFill, req.auth!.sub, (ctx as any).processId, (formId, err) => {
      console.error(`[GET /api/pdf/merged] ${authTag(req)} | Skipping ${formId}:`, err);
      logAppError({
        err,
        service: "GET /api/pdf/merged/:situationalContextId",
        request: req,
        errorType: "pdf",
        formId,
        situationalContextId: req.params.situationalContextId,
      });
    });

    if (!tmpMergedPath) {
      res.status(500).json({ error: "Failed to generate any PDFs." });
      return;
    }

    console.log(`[GET /api/pdf/merged] ${authTag(req)} | 200 — streaming merged PDF (${mapsToFill.length} forms requested)`);
    streamPdfAndCleanup(res, tmpMergedPath, "immigration-forms.pdf");
  } catch (err) {
    console.error(`[GET /api/pdf/merged] ${authTag(req)} | 500 — merge failed`);
    serverError(req, res, err, "GET /api/pdf/merged/:situationalContextId", {
      situationalContextId: req.params.situationalContextId,
    });
  }
});

export default router;
