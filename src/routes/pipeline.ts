import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { buildSituationContext } from "../services/buildSituationContext";
import { fillFormMap } from "../services/fillFormMap";
import { fillForm } from "../services/fillForm";
import { runPipeline } from "../services/runPipeline";
import { SituationalContext } from "../models/SituationalContext";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { logAppError, ClaudeContentError, ClaudeParseError } from "../models/AppError";
import type { AppErrorType, AssumptionLevel } from "../types";

const router = Router();
const upload = multer({ dest: os.tmpdir() });

interface ServerErrorOpts {
  service: string;
  errorType?: AppErrorType;
  formId?: string;
  situationalContextId?: string;
}

function serverError(
  req: Request,
  res: Response,
  err: unknown,
  opts: ServerErrorOpts
): void {
  console.error(`[${opts.service}]`, err);

  // Surface Claude content errors as 422 so callers can distinguish them from
  // raw 500s. Persist every error to MongoDB along with the request IP/email
  // so we can audit failures by user later.
  let status = 500;
  if (err instanceof ClaudeContentError) status = 422;
  else if (err instanceof ClaudeParseError) status = 502;

  logAppError({ err, request: req, ...opts });

  const message = err instanceof ClaudeContentError
    ? err.message
    : "An internal error occurred. Please try again.";
  res.status(status).json({ error: message });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ASSETS_FORMS_DIR = path.resolve(__dirname, "../../assets/forms");

function getBlankPdfPath(formId: string): string {
  return path.join(ASSETS_FORMS_DIR, formId, "blank.pdf");
}

/** Accepts a JSON array string ("["i-130","i-485"]") or a comma-separated string. */
function parseFormIds(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    // fall through to comma-split
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const VALID_ASSUMPTION_LEVELS: AssumptionLevel[] = ["conservative", "moderate", "liberal"];

// ─── POST /api/pipeline/run ───────────────────────────────────────────────────
//
// Runs the user-facing pipeline. Two modes:
//
//   FULL (no situationalContextId):
//     1. buildSituationContext — parse docs + description, save SituationalContext
//     2. fillFormMap (×N)      — LLM maps situational context to each form's fields
//     3. fillForm (×N)         — pdftk stamps values into blank PDFs
//
//   RESUME (situationalContextId provided):
//     Skips step 1; loads the saved SituationalContext and runs steps 2 + 3 only.
//     Useful for filling additional forms against an already-generated context, or
//     for re-running a failed fill without burning another Anthropic call.
//
// Body (multipart/form-data):
//   situationalContextId string    optional — if provided, skips buildSituationContext
//   userId               string    required when situationalContextId is absent;
//                                  optional (but allowed) when it is present
//   situationDescription string    required when situationalContextId is absent
//   processDescription   string    required when situationalContextId is absent
//   additionalNotes      string    optional
//   formIds              string    required — JSON array OR comma-separated
//                                  e.g. '["i-130","i-485"]' or "i-130,i-485"
//   assumptionLevel      string    optional — conservative|moderate|liberal
//   documents            File[]    optional — up to 20 supporting documents (full mode)
//
// Response (200):
//   {
//     situationalContextId: string,
//     forms: [
//       {
//         formId: string,
//         filledFormMapId: string | null,
//         success: boolean,
//         outputPath: string,
//         filledFields: string[],
//         skippedFields: string[],
//         errors: string[]
//       }
//     ]
//   }
//
router.post("/run", requireAuth, upload.array("documents", 20), async (req: Request, res: Response) => {
  console.log(`[POST /api/pipeline/run] ${authTag(req)} | Running full pipeline`);
  try {
    const userId = req.auth!.sub;
    const {
      situationalContextId: situationalContextIdRaw,
      situationDescription,
      processDescription,
      additionalNotes,
      formIds: formIdsRaw,
      assumptionLevel: assumptionLevelRaw,
    } = req.body as Record<string, string | undefined>;

    // ── formIds — optional; defaults to requiredForms on the SituationalContext ─
    const formIds = formIdsRaw ? parseFormIds(formIdsRaw) : [];

    // ── assumptionLevel validation ─────────────────────────────────────────
    let assumptionLevel: AssumptionLevel | undefined;
    if (assumptionLevelRaw) {
      if (!VALID_ASSUMPTION_LEVELS.includes(assumptionLevelRaw as AssumptionLevel)) {
        console.log(`[POST /api/pipeline/run] ${authTag(req)} | 400 — invalid assumptionLevel`);
        res.status(400).json({
          error: `assumptionLevel must be one of: ${VALID_ASSUMPTION_LEVELS.join(", ")}`,
        });
        return;
      }
      assumptionLevel = assumptionLevelRaw as AssumptionLevel;
    }

    // ── Step 1: Build or load SituationalContext ───────────────────────────
    let situationalContextId: string;

    if (situationalContextIdRaw) {
      // RESUME mode — verify the context exists
      const existing = await SituationalContext.findById(situationalContextIdRaw).lean();
      if (!existing) {
        console.log(`[POST /api/pipeline/run] ${authTag(req)} | 404 — context not found`);
        res.status(404).json({ error: `SituationalContext not found: ${situationalContextIdRaw}` });
        return;
      }
      situationalContextId = situationalContextIdRaw;
      console.log(`[POST /api/pipeline/run] ${authTag(req)} | Resuming context id=${situationalContextId}`);
    } else {
      // FULL mode — validate required fields then generate
      if (!situationDescription) {
        console.log(`[POST /api/pipeline/run] ${authTag(req)} | 400 — missing situationDescription`);
        res.status(400).json({ error: "situationDescription is required when situationalContextId is not provided" });
        return;
      }
      if (!processDescription) {
        console.log(`[POST /api/pipeline/run] ${authTag(req)} | 400 — missing processDescription`);
        res.status(400).json({ error: "processDescription is required when situationalContextId is not provided" });
        return;
      }

      console.log(`[POST /api/pipeline/run] ${authTag(req)} | Building situational context`);
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

      const situationalContextDoc = await buildSituationContext({
        userId,
        uiAnswers: { situationDescription, processDescription, additionalNotes },
        uploadedFiles: uploadedFiles.map((f) => ({
          path: f.path,
          originalname: f.originalname,
          mimetype: f.mimetype,
        })),
      });

      situationalContextId = String((situationalContextDoc as unknown as Record<string, unknown>)._id);
      console.log(`[POST /api/pipeline/run] ${authTag(req)} | Context saved id=${situationalContextId}`);
    }

    // ── Steps 2 + 3: fillFormMap then fillForm (per form) ─────────────────
    // Resolve userId from the context doc for RESUME mode; for FULL mode it
    // was already set above from userIdRaw.
    const ctxForUserId = await SituationalContext.findById(situationalContextId).lean();
    const resolvedUserId = (ctxForUserId as any)?.userId ?? userId;

    // Resolve form IDs: explicit list → requiredForms on context → error
    let resolvedFormIds = formIds;
    if (resolvedFormIds.length === 0) {
      resolvedFormIds = ((ctxForUserId as any)?.requiredForms as string[] | undefined) ?? [];
    }
    if (resolvedFormIds.length === 0) {
      console.log(`[POST /api/pipeline/run] ${authTag(req)} | 400 — no form IDs`);
      res.status(400).json({ error: "No formIds provided and SituationalContext has no requiredForms." });
      return;
    }

    // Validate blank PDFs before any AI calls
    const missingPdfs = resolvedFormIds.filter((id) => !fs.existsSync(getBlankPdfPath(id)));
    if (missingPdfs.length > 0) {
      console.log(`[POST /api/pipeline/run] ${authTag(req)} | 400 — missing PDFs: ${missingPdfs.join(",")}`);
      res.status(400).json({ error: `Blank PDF not found for: ${missingPdfs.join(", ")}` });
      return;
    }

    console.log(`[POST /api/pipeline/run] ${authTag(req)} | Processing ${resolvedFormIds.length} forms`);

    const formResults: Array<{
      formId: string;
      filledFormMapId: string | null;
      success: boolean;
      outputPath: string;
      filledFields: string[];
      skippedFields: string[];
      errors: string[];
    }> = [];

    for (const formId of resolvedFormIds) {
      try {
        const filledMapDoc = await fillFormMap({
          formId,
          userId: resolvedUserId,
          situationalContextId,
          assumptionLevel,
        });
        const filledFormMapId = String((filledMapDoc as any)._id);

        const fillResult = await fillForm({
          formId,
          userId: resolvedUserId,
          filledFormMapId,
          formPdfPath: getBlankPdfPath(formId),
        });

        formResults.push({ formId, filledFormMapId, ...fillResult });
      } catch (formErr) {
        console.error(`[POST /api/pipeline/run] ${authTag(req)} | Form failed ${formId}:`, formErr);
        logAppError({
          err: formErr,
          service: "POST /api/pipeline/run",
          request: req,
          formId,
          situationalContextId,
        });
        formResults.push({
          formId,
          filledFormMapId: null,
          success: false,
          outputPath: "",
          filledFields: [],
          skippedFields: [],
          errors: [
            formErr instanceof ClaudeContentError
              ? formErr.message
              : `Failed to process form "${formId}".`,
          ],
        });
      }
    }

    const successCount = formResults.filter((f) => f.success).length;
    console.log(`[POST /api/pipeline/run] ${authTag(req)} | 200 — ${successCount}/${formResults.length} forms succeeded`);
    res.json({ situationalContextId, forms: formResults });
  } catch (err) {
    console.error(`[POST /api/pipeline/run] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, { service: "POST /api/pipeline/run" });
  }
});

// ─── POST /api/pipeline/fill-form-maps ───────────────────────────────────────
//
// Runs fillFormMap for every form in a SituationalContext's requiredForms,
// saving a FilledFormMap to MongoDB for each. No PDFs are generated.
//
// Body (application/json):
//   situationalContextId  string   required
//   assumptionLevel       string   optional — conservative (default) | moderate | liberal
//
// Response (200):
//   {
//     situationalContextId: string,
//     userId: string,
//     success: boolean,
//     forms: [
//       {
//         formId: string,
//         filledFormMapId: string | null,
//         success: boolean,
//         fieldCount: number,
//         filledCount: number,
//         skippedCount: number,
//         errors: string[]
//       }
//     ]
//   }
//
router.post("/fill-form-maps", requireAuth, async (req: Request, res: Response) => {
  console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | Batch filling form maps`);
  try {
    const { situationalContextId, assumptionLevel: assumptionLevelRaw } =
      req.body as Record<string, string | undefined>;

    if (!situationalContextId) {
      console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 400 — missing contextId`);
      res.status(400).json({ error: "situationalContextId is required" });
      return;
    }

    let assumptionLevel: AssumptionLevel = "conservative";
    if (assumptionLevelRaw) {
      if (!VALID_ASSUMPTION_LEVELS.includes(assumptionLevelRaw as AssumptionLevel)) {
        console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 400 — invalid assumptionLevel`);
        res.status(400).json({
          error: `assumptionLevel must be one of: ${VALID_ASSUMPTION_LEVELS.join(", ")}`,
        });
        return;
      }
      assumptionLevel = assumptionLevelRaw as AssumptionLevel;
    }

    const ctxDoc = await SituationalContext.findById(situationalContextId).lean();
    if (!ctxDoc) {
      console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 404 — context not found`);
      res.status(404).json({ error: `SituationalContext not found: ${situationalContextId}` });
      return;
    }

    const userId = (ctxDoc as any).userId as string;
    const requiredForms: string[] = (ctxDoc as any).requiredForms ?? [];

    if (requiredForms.length === 0) {
      console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 400 — no required forms`);
      res.status(400).json({ error: "SituationalContext has no requiredForms." });
      return;
    }

    console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | Processing ${requiredForms.length} forms`);

    const forms: Array<{
      formId: string;
      filledFormMapId: string | null;
      success: boolean;
      fieldCount: number;
      filledCount: number;
      skippedCount: number;
      errors: string[];
    }> = [];

    for (const formId of requiredForms) {
      try {
        const filledMapDoc = await fillFormMap({ formId, userId, situationalContextId, assumptionLevel });
        const fields = filledMapDoc.fields as Record<string, string>;
        const fieldCount = Object.keys(fields).length;
        const filledCount = Object.values(fields).filter((v) => v !== "").length;

        forms.push({
          formId,
          filledFormMapId: String((filledMapDoc as any)._id),
          success: true,
          fieldCount,
          filledCount,
          skippedCount: fieldCount - filledCount,
          errors: [],
        });
      } catch (err) {
        console.error(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | Form failed ${formId}:`, err);
        logAppError({
          err,
          service: "POST /api/pipeline/fill-form-maps",
          request: req,
          formId,
          situationalContextId,
        });
        forms.push({
          formId,
          filledFormMapId: null,
          success: false,
          fieldCount: 0,
          filledCount: 0,
          skippedCount: 0,
          errors: [
            err instanceof ClaudeContentError
              ? err.message
              : `Failed to process form "${formId}".`,
          ],
        });
      }
    }

    const overallSuccess = forms.every((f) => f.success);
    console.log(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 200 — success=${overallSuccess}`);
    res.json({ situationalContextId, userId, success: overallSuccess, forms });
  } catch (err) {
    console.error(`[POST /api/pipeline/fill-form-maps] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, { service: "POST /api/pipeline/fill-form-maps" });
  }
});

// ─── POST /api/pipeline/resume ────────────────────────────────────────────────
//
// For every form in a SituationalContext's requiredForms, finds the most
// recently saved FilledFormMap and runs fillForm to produce filled PDFs.
//
// fillFormMap is NOT called — FilledFormMap records must already exist for
// this context before calling this endpoint.
//
// Body (application/json):
//   situationalContextId  string   required
//
// Response (200):
//   {
//     situationalContextId: string,
//     userId: string,
//     forms: [
//       {
//         formId: string,
//         filledFormMapId: string,
//         success: boolean,
//         outputPath: string,
//         filledFields: string[],
//         skippedFields: string[],
//         errors: string[]
//       }
//     ]
//   }
//
router.post("/resume", async (req: Request, res: Response) => {
  console.log(`[POST /api/pipeline/resume] ${authTag(req)} | Resuming PDF generation`);
  try {
    const { situationalContextId } = req.body as Record<string, string | undefined>;

    if (!situationalContextId) {
      console.log(`[POST /api/pipeline/resume] ${authTag(req)} | 400 — missing contextId`);
      res.status(400).json({ error: "situationalContextId is required" });
      return;
    }

    console.log(`[POST /api/pipeline/resume] ${authTag(req)} | Running pipeline id=${situationalContextId}`);
    const result = await runPipeline(situationalContextId);

    console.log(`[POST /api/pipeline/resume] ${authTag(req)} | 200 — pipeline complete`);
    res.json(result);
  } catch (err) {
    console.error(`[POST /api/pipeline/resume] ${authTag(req)} | 500 — server error`);
    serverError(req, res, err, { service: "POST /api/pipeline/resume" });
  }
});

export default router;
