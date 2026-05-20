import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { fillForm } from "../services/fillForm";
import { extractPdf } from "../services/extractPdf";
import { logAppError } from "../models/AppError";
import type { AppErrorType, FormType } from "../types";

const router = Router();
const upload = multer({ dest: os.tmpdir() });

const VALID_FORM_TYPES: FormType[] = ["pdf"];

function serverError(
  req: Request,
  res: Response,
  err: unknown,
  service: string,
  opts?: { formId?: string; errorType?: AppErrorType }
): void {
  console.error(`[${service}]`, err);
  logAppError({
    err,
    service,
    request: req,
    formId: opts?.formId,
    errorType: opts?.errorType,
  });
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// POST /api/form-fill/fill
router.post("/fill", async (req: Request, res: Response) => {
  try {
    const { formId, userId, filledFormMapId, formPdfPath, outputDir, formType } =
      req.body as Record<string, string | undefined>;

    const missing: string[] = [];
    if (!formId) missing.push("formId");
    if (!userId) missing.push("userId");
    if (!filledFormMapId) missing.push("filledFormMapId");
    if (!formPdfPath) missing.push("formPdfPath");

    if (missing.length > 0) {
      return res.status(400).json({
        error: `Missing required field(s): ${missing.join(", ")}`,
      });
    }

    const resolvedFormType: FormType =
      formType && VALID_FORM_TYPES.includes(formType as FormType)
        ? (formType as FormType)
        : "pdf";

    const result = await fillForm({
      formId: formId!,
      userId: userId!,
      filledFormMapId: filledFormMapId!,
      formPdfPath: formPdfPath!,
      outputDir: outputDir || undefined,
      formType: resolvedFormType,
    });

    res.json(result);
  } catch (err) {
    serverError(req, res, err, `${req.method} ${req.path}`, {
      formId: (req.body as { formId?: string })?.formId,
      errorType: "pdf",
    });
  }
});

// POST /api/form-fill/extract
router.post("/extract", upload.single("pdf"), async (req: Request, res: Response) => {
  try {
    // TODO: extract params, call extractPdf
    res.status(501).json({ error: "Not implemented" });
  } catch (err) {
    serverError(req, res, err, `${req.method} ${req.path}`, { errorType: "pdf" });
  }
});

export default router;
