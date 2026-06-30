import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { buildFormContext, getFormContextPromptText } from "../services/buildFormContext";
import { FormContext } from "../models/FormContext";
import { logAppError, ClaudeContentError, ClaudeParseError } from "../models/AppError";

const router = Router();

// ─── Multer — optional supplemental context file uploads ──────────────────────
const upload = multer({ dest: os.tmpdir() });

function serverError(req: Request, res: Response, err: unknown, service: string, formId?: string): void {
  console.error(`[${service}]`, err);
  let status = 500;
  if (err instanceof ClaudeContentError) status = 422;
  else if (err instanceof ClaudeParseError) status = 502;
  logAppError({ err, service, request: req, formId });
  const message = err instanceof ClaudeContentError
    ? err.message
    : "An internal error occurred. Please try again.";
  res.status(status).json({ error: message });
}

// ─── POST /api/form-context/build ────────────────────────────────────────────
router.post("/build", upload.array("contextFiles", 10), async (req: Request, res: Response) => {
  try {
    const { formId, formPdfPath, processId, candidateProcessIds } = req.body;

    if (!formId) {
      res.status(400).json({ error: "formId is required" });
      return;
    }
    if (!formPdfPath) {
      res.status(400).json({ error: "formPdfPath is required" });
      return;
    }

    // Caller can pass a single processId or an array of candidates. Either way
    // it flows through to the LLM as the candidate list.
    let candidates: string[] | undefined;
    if (Array.isArray(candidateProcessIds)) {
      candidates = candidateProcessIds.map(String).filter(Boolean);
    } else if (typeof processId === "string" && processId.trim() !== "") {
      candidates = [processId.trim()];
    }

    const uploadedContextFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
    const contextFilePaths = uploadedContextFiles.map((f) => f.path);

    const result = await buildFormContext({
      formId,
      formPdfPath,
      contextFilePaths,
      ...(candidates ? { candidateProcessIds: candidates } : {}),
    });

    res.status(201).json({
      formId: result.formId,
      createdAt: result.createdAt,
      fieldCount: result.fields.length,
      formMetadata: result.formMetadata,
      applicableProcesses: result.applicableProcesses ?? [],
      fields: result.fields,
    });
  } catch (err) {
    serverError(req, res, err, `${req.method} ${req.path}`, (req.body as { formId?: string })?.formId);
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
      serverError(req, res, err, `${req.method} ${req.path}`, (req.body as { formId?: string })?.formId);
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
    serverError(req, res, err, `${req.method} ${req.path}`, req.params.formId);
  }
});

export default router;
