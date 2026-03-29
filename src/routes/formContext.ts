import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { buildFormContext, getFormContextPromptText } from "../services/buildFormContext";
import { FormContext } from "../models/FormContext";

const router = Router();

// ─── Multer — optional supplemental context file uploads ──────────────────────
const upload = multer({ dest: os.tmpdir() });

function serverError(res: Response, err: unknown): void {
  console.error("[formContext]", err);
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// ─── POST /api/form-context/build ────────────────────────────────────────────
router.post("/build", upload.array("contextFiles", 10), async (req: Request, res: Response) => {
  try {
    const { formId, formPdfPath } = req.body;

    if (!formId) {
      res.status(400).json({ error: "formId is required" });
      return;
    }
    if (!formPdfPath) {
      res.status(400).json({ error: "formPdfPath is required" });
      return;
    }

    const uploadedContextFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const contextFilePaths = uploadedContextFiles.map((f) => f.path);

    const result = await buildFormContext({ formId, formPdfPath, contextFilePaths });

    res.status(201).json({
      formId: result.formId,
      createdAt: result.createdAt,
      fieldCount: result.fields.length,
      formMetadata: result.formMetadata,
      fields: result.fields,
    });
  } catch (err) {
    serverError(res, err);
  }
});

// ─── POST /api/form-context/prompt ───────────────────────────────────────────
// Debug utility — returns the prompts without making an AI call.
router.post(
  "/prompt",
  upload.array("contextFiles", 10),
  async (req: Request, res: Response) => {
    try {
      const { formId, formPdfPath } = req.body;

      if (!formId) {
        res.status(400).json({ error: "formId is required" });
        return;
      }
      if (!formPdfPath) {
        res.status(400).json({ error: "formPdfPath is required" });
        return;
      }

      const uploadedContextFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
      const contextFilePaths = uploadedContextFiles.map((f) => f.path);

      const { systemPrompt, userMessage } = await getFormContextPromptText({
        formId,
        formPdfPath,
        contextFilePaths,
      });

      res.json({ systemPrompt, userMessage });
    } catch (err) {
      serverError(res, err);
    }
  }
);

// ─── GET /api/form-context/:formId ───────────────────────────────────────────
router.get("/:formId", async (req: Request, res: Response) => {
  try {
    const doc = await FormContext.findOne({ formId: req.params.formId }).sort({ createdAt: -1 });
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
