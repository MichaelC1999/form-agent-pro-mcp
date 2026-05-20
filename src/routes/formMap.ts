import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { buildFormMap } from "../services/buildFormMap";
import { FormMap } from "../models/FormMap";
import { logAppError } from "../models/AppError";

const router = Router();

// Multer — accept the blank PDF uploaded directly; store in system temp dir
const upload = multer({ dest: os.tmpdir() });

function serverError(req: Request, res: Response, err: unknown, service: string, formId?: string): void {
  console.error(`[${service}]`, err);
  logAppError({ err, service, request: req, formId });
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// POST /api/form-map/build
//
// Accepts either:
//   (a) multipart/form-data with a "pdf" file upload + body fields formId, version
//   (b) application/json with { formId, formPdfPath, version } pointing to a
//       server-local path (e.g. during internal/CLI use where the file already exists)
router.post("/build", upload.single("pdf"), async (req: Request, res: Response) => {
  try {
    const { formId, version } = req.body as {
      formId?: string;
      version?: string;
    };

    if (!formId) {
      res.status(400).json({ error: "formId is required" });
      return;
    }

    // Resolve the PDF path — either from a local path passed in the body,
    // or from the file uploaded via multipart
    let formPdfPath: string | undefined;

    if (req.file) {
      // Uploaded file — multer wrote it to os.tmpdir()
      formPdfPath = req.file.path;
    } else if (typeof req.body.formPdfPath === "string" && req.body.formPdfPath) {
      // Server-local path (internal / CLI-mirror usage)
      formPdfPath = req.body.formPdfPath;
    }

    if (!formPdfPath) {
      res.status(400).json({
        error: "A PDF is required — either upload a file (multipart field: 'pdf') or provide 'formPdfPath' pointing to a server-local file.",
      });
      return;
    }

    const result = await buildFormMap({ formId, formPdfPath, version });

    res.status(201).json({
      formId: result.formId,
      version: result.version,
      createdAt: result.createdAt,
      fieldCount: result.fieldCount,
      strategy: result.strategy,
      fields: result.fields,
    });
  } catch (err) {
    serverError(req, res, err, `${req.method} ${req.path}`, (req.params?.formId ?? (req.body as { formId?: string })?.formId));
  }
});

// GET /api/form-map/:formId
// Returns the most recently created FormMap for the given formId
router.get("/:formId", async (req: Request, res: Response) => {
  try {
    const doc = await FormMap.findOne({ formId: req.params.formId }).sort({ createdAt: -1 });
    if (!doc) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.json(doc.toObject());
  } catch (err) {
    serverError(req, res, err, `${req.method} ${req.path}`, (req.params?.formId ?? (req.body as { formId?: string })?.formId));
  }
});

export default router;
