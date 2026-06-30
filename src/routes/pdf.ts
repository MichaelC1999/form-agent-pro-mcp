import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PDFDocument } from "pdf-lib";
import { fillForm } from "../services/fillForm";
import { FilledFormMap } from "../models/FilledFormMap";
import { SituationalContext } from "../models/SituationalContext";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { logAppError } from "../models/AppError";
import { normalizeRequiredForms } from "../types";
import { getBlankPdfPath, resolveProcessId } from "../lib/processes";

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

/** Generate a filled PDF for a FilledFormMap and return the output path. */
async function generatePdf(
  filledFormMapId: string,
  formId: string,
  userId: string,
  processId: string
): Promise<string> {
  const blankPath = getBlankPdfPath(processId, formId);
  if (!fs.existsSync(blankPath)) {
    throw new Error(`Blank PDF not found for form "${formId}" in process "${processId}".`);
  }

  const tmpDir = path.join(os.tmpdir(), `pdf-${filledFormMapId}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const result = await fillForm({
    formId,
    userId,
    filledFormMapId,
    formPdfPath: blankPath,
    outputDir: tmpDir,
  });

  if (!result.success) {
    throw new Error(`PDF generation failed for "${formId}": ${result.errors.join("; ")}`);
  }

  return result.outputPath;
}

/** Stream a PDF file as a download response, then delete the temp file. */
function streamPdfAndCleanup(res: Response, filePath: string, filename: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("end", () => {
    // Clean up the temp file and its parent directory
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(path.dirname(filePath), { recursive: true } as any);
    } catch {
      // Best-effort cleanup
    }
  });
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

    // Find every FilledFormMap for this user (latest first)
    const allMaps = await FilledFormMap.find({ userId: req.auth!.sub })
      .sort({ createdAt: -1 })
      .lean();

    // Deduplicate by (formId, beneficiaryKey). The key encodes both so a
    // multi-beneficiary submission keeps a distinct fill per beneficiary.
    const dedupKey = (formId: string, beneficiaryKey: string | undefined): string =>
      `${formId}::${beneficiaryKey ?? ""}`;
    const latestPerEntry = new Map<string, any>();
    for (const m of allMaps) {
      const fid = (m as any).formId as string;
      const bk = (m as any).beneficiaryKey as string | undefined;
      const k = dedupKey(fid, bk);
      if (!latestPerEntry.has(k)) {
        latestPerEntry.set(k, m);
      }
    }

    // Select the latest map for each entry in this context's requiredForms.
    const requiredEntries = normalizeRequiredForms((ctx as any).requiredForms);
    const mapsToFill = requiredEntries
      .map((e) => latestPerEntry.get(dedupKey(e.formId, e.beneficiaryKey)))
      .filter((m): m is NonNullable<typeof m> => Boolean(m));

    if (mapsToFill.length === 0) {
      console.log(`[GET /api/pdf/merged] ${authTag(req)} | 400 — no filled maps found`);
      res.status(400).json({ error: "No filled form maps available for this context." });
      return;
    }

    console.log(`[GET /api/pdf/merged] ${authTag(req)} | Generating ${mapsToFill.length} PDFs`);

    // Generate individual PDFs
    const ctxProcessId = resolveProcessId((ctx as any).processId);
    const pdfPaths: string[] = [];
    for (const m of mapsToFill) {
      try {
        const p = await generatePdf(
          String((m as any)._id),
          (m as any).formId,
          req.auth!.sub,
          resolveProcessId((m as any).processId ?? ctxProcessId)
        );
        pdfPaths.push(p);
      } catch (err) {
        console.error(`[GET /api/pdf/merged] ${authTag(req)} | Skipping ${(m as any).formId}:`, err);
        logAppError({
          err,
          service: "GET /api/pdf/merged/:situationalContextId",
          request: req,
          errorType: "pdf",
          formId: (m as any).formId,
          situationalContextId: req.params.situationalContextId,
        });
      }
    }

    if (pdfPaths.length === 0) {
      res.status(500).json({ error: "Failed to generate any PDFs." });
      return;
    }

    // Merge all PDFs using pdf-lib
    console.log(`[GET /api/pdf/merged] ${authTag(req)} | Merging ${pdfPaths.length} PDFs`);
    const mergedPdf = await PDFDocument.create();

    for (const pdfPath of pdfPaths) {
      const pdfBytes = fs.readFileSync(pdfPath);
      const donor = await PDFDocument.load(pdfBytes);
      const copiedPages = await mergedPdf.copyPages(donor, donor.getPageIndices());
      for (const page of copiedPages) {
        mergedPdf.addPage(page);
      }
    }

    const mergedBytes = await mergedPdf.save();

    // Write merged PDF to temp file
    const tmpMergedPath = path.join(os.tmpdir(), `merged-${Date.now()}.pdf`);
    fs.writeFileSync(tmpMergedPath, mergedBytes);

    // Clean up individual temp PDFs
    for (const p of pdfPaths) {
      try {
        fs.unlinkSync(p);
        fs.rmdirSync(path.dirname(p), { recursive: true } as any);
      } catch {
        // Best-effort
      }
    }

    console.log(`[GET /api/pdf/merged] ${authTag(req)} | 200 — streaming merged PDF (${pdfPaths.length} forms)`);
    streamPdfAndCleanup(res, tmpMergedPath, "immigration-forms.pdf");
  } catch (err) {
    console.error(`[GET /api/pdf/merged] ${authTag(req)} | 500 — merge failed`);
    serverError(req, res, err, "GET /api/pdf/merged/:situationalContextId", {
      situationalContextId: req.params.situationalContextId,
    });
  }
});

export default router;
