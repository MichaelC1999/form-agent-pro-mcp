import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PDFDocument } from "pdf-lib";
import { fillForm } from "../services/fillForm";
import { FilledFormMap } from "../models/FilledFormMap";
import { SituationalContext } from "../models/SituationalContext";
import { requireAuth, authTag } from "../middleware/requireAuth";

const router = Router();

const ASSETS_FORMS_DIR = path.resolve(__dirname, "../../assets/forms");

function getBlankPdfPath(formId: string): string {
  return path.join(ASSETS_FORMS_DIR, formId, "blank.pdf");
}

function serverError(res: Response, err: unknown): void {
  console.error("[pdf]", err);
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

/** Generate a filled PDF for a FilledFormMap and return the output path. */
async function generatePdf(
  filledFormMapId: string,
  formId: string,
  userId: string
): Promise<string> {
  const blankPath = getBlankPdfPath(formId);
  if (!fs.existsSync(blankPath)) {
    throw new Error(`Blank PDF not found for form "${formId}".`);
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
    console.log(`[GET /api/pdf/form] ${authTag(req)} | Generating PDF for ${formId}`);

    const outputPath = await generatePdf(
      req.params.filledFormMapId,
      formId,
      req.auth!.sub
    );

    console.log(`[GET /api/pdf/form] ${authTag(req)} | 200 — streaming ${formId}.pdf`);
    streamPdfAndCleanup(res, outputPath, `${formId}.pdf`);
  } catch (err) {
    console.error(`[GET /api/pdf/form] ${authTag(req)} | 500 — generation failed`);
    serverError(res, err);
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

    // Find the most recent FilledFormMap per formId for this user
    const allMaps = await FilledFormMap.find({ userId: req.auth!.sub })
      .sort({ createdAt: -1 })
      .lean();

    // Deduplicate: keep only the most recent per formId
    const latestPerForm = new Map<string, any>();
    for (const m of allMaps) {
      const fid = (m as any).formId as string;
      if (!latestPerForm.has(fid)) {
        latestPerForm.set(fid, m);
      }
    }

    // Filter to only forms in this context's requiredForms
    const requiredForms: string[] = (ctx as any).requiredForms ?? [];
    const mapsToFill = requiredForms
      .filter((fid) => latestPerForm.has(fid))
      .map((fid) => latestPerForm.get(fid)!);

    if (mapsToFill.length === 0) {
      console.log(`[GET /api/pdf/merged] ${authTag(req)} | 400 — no filled maps found`);
      res.status(400).json({ error: "No filled form maps available for this context." });
      return;
    }

    console.log(`[GET /api/pdf/merged] ${authTag(req)} | Generating ${mapsToFill.length} PDFs`);

    // Generate individual PDFs
    const pdfPaths: string[] = [];
    for (const m of mapsToFill) {
      try {
        const p = await generatePdf(
          String((m as any)._id),
          (m as any).formId,
          req.auth!.sub
        );
        pdfPaths.push(p);
      } catch (err) {
        console.error(`[GET /api/pdf/merged] ${authTag(req)} | Skipping ${(m as any).formId}:`, err);
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
    serverError(res, err);
  }
});

export default router;
