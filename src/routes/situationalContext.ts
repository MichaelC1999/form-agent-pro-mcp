import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { extractRawText, getMimeCategory } from "../services/buildSituationContext";
import { fillFormMap } from "../services/fillFormMap";
import { SituationalContext } from "../models/SituationalContext";
import type {
  AdditionalContext,
  FormGenerationFailure,
  ParsedDocument,
} from "../types";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { requireUserSpendBudget } from "../lib/spendCap";
import { assertSessionPaid } from "../services/stripe";
import { startSituationBuild } from "../services/startSituationBuild";
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
router.post("/build", requireAuth, requireUserSpendBudget, upload.array("documents", 50), async (req: Request, res: Response) => {
  console.log(`[POST /api/situation/build] ${authTag(req)} | Building situational context`);
  try {
    const userId = req.auth!.sub;
    const {
      situationDescription,
      processDescription,
      additionalNotes,
      stripeSessionId,
      beneficiaryCount: beneficiaryCountRaw,
      beneficiaryNames: beneficiaryNamesRaw,
      processIdHint,
    } = req.body as {
      situationDescription?: string;
      processDescription?: string;
      additionalNotes?: string;
      stripeSessionId?: string;
      beneficiaryCount?: string;
      beneficiaryNames?: string;
      processIdHint?: string;
    };

    // Parse multi-beneficiary signal (optional — single-beneficiary submissions
    // omit these fields entirely and the server runs identically to before).
    let beneficiaryCount: number | undefined;
    if (typeof beneficiaryCountRaw === "string" && beneficiaryCountRaw.trim() !== "") {
      const n = parseInt(beneficiaryCountRaw, 10);
      if (Number.isFinite(n) && n > 1 && n <= 20) beneficiaryCount = n;
    }
    let beneficiaryNames: string[] | undefined;
    if (typeof beneficiaryNamesRaw === "string" && beneficiaryNamesRaw.trim() !== "") {
      try {
        const parsed = JSON.parse(beneficiaryNamesRaw);
        if (Array.isArray(parsed)) {
          beneficiaryNames = parsed.filter((s): s is string => typeof s === "string" && s.trim() !== "");
        }
      } catch {
        // Ignore malformed JSON — beneficiary names are an optional hint
      }
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

    // Stripe payment gate. Runs after input validation because it marks the
    // session as consumed — a 400 must not burn the user's payment.
    const paid = await assertSessionPaid(stripeSessionId, userId);
    if (!paid.ok) {
      console.log(`[POST /api/situation/build] ${authTag(req)} | ${paid.status} — ${paid.error}`);
      res.status(paid.status).json({ error: paid.error });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

    // Creates the stub and runs the pipeline in the background (shared with MCP).
    const contextId = await startSituationBuild({
      userId,
      uiAnswers: {
        situationDescription,
        processDescription,
        additionalNotes,
        beneficiaryCount,
        beneficiaryNames,
      },
      uploadedFiles: uploadedFiles.map((f) => ({
        path: f.path,
        originalname: f.originalname,
        mimetype: f.mimetype,
      })),
      processIdHint,
      // Snapshot request meta now so background errors can still be tagged
      // with the originating IP and email after the response has been sent.
      requestMeta: requestErrorMeta(req, "POST /api/situation/build (background)"),
      logTag: authTag(req),
      serviceLabel: "POST /api/situation/build",
    });
    // The background job now owns the uploaded files and deletes them itself.
    res.locals.keepUploads = true;

    // Return 202 immediately — the pipeline runs in the background
    console.log(`[POST /api/situation/build] ${authTag(req)} | 202 — stub created id=${contextId}`);
    res.status(202).json({
      _id: contextId,
      userId,
      status: "processing",
    });
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

// POST /api/situation/:id/retry-form
//
// Retry generating a single FilledFormMap for a (formId, beneficiaryKey)
// pair, augmented with user-provided clarification text and optional files.
// The clarification is persisted to the SituationalContext's
// additionalContexts array so subsequent fillFormMap calls (this one and any
// future retries) automatically include it in the prompt.
//
// Body (multipart/form-data):
//   formId          string  required
//   beneficiaryKey  string  optional — must match an existing failed entry
//   userNote        string  optional — free text from the user
//   documents       File[]  optional — up to 10 attachments
//
// Response (201): the newly created FilledFormMap document
// Response (422): ClaudeContentError — the model could not fill the form
//                 even with the new context (e.g. still missing key data)
//
router.post(
  "/:id/retry-form",
  requireAuth,
  requireUserSpendBudget,
  upload.array("documents", 10),
  async (req: Request, res: Response) => {
    console.log(`[POST /api/situation/:id/retry-form] ${authTag(req)} | Retrying form`);
    try {
      const contextId = req.params.id;
      const userId = req.auth!.sub;
      const {
        formId,
        beneficiaryKey: beneficiaryKeyRaw,
        userNote: userNoteRaw,
      } = req.body as {
        formId?: string;
        beneficiaryKey?: string;
        userNote?: string;
      };

      if (!formId || typeof formId !== "string") {
        res.status(400).json({ error: "formId (string) is required" });
        return;
      }

      const beneficiaryKey =
        typeof beneficiaryKeyRaw === "string" && beneficiaryKeyRaw.trim() !== ""
          ? beneficiaryKeyRaw.trim()
          : undefined;
      const userNote = typeof userNoteRaw === "string" ? userNoteRaw : "";

      // 1. Load + verify ownership
      const ctxDoc = await SituationalContext.findById(contextId);
      if (!ctxDoc) {
        res.status(404).json({ error: "SituationalContext not found." });
        return;
      }
      if ((ctxDoc as any).userId !== userId) {
        res.status(403).json({ error: "Access denied." });
        return;
      }

      // 2. Parse any attached files via the same OCR / PDF-parse helpers
      //    buildSituationContext uses. Each becomes a ParsedDocument inside
      //    the new AdditionalContext entry.
      const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];
      const parsedDocuments: ParsedDocument[] = [];
      for (const f of uploadedFiles) {
        const upload = { path: f.path, originalname: f.originalname, mimetype: f.mimetype };
        const category = getMimeCategory(upload);
        const rawText = await extractRawText(upload, category);
        parsedDocuments.push({
          originalName: f.originalname,
          mimeCategory: category,
          rawText,
          uploadedAt: new Date(),
        });
      }

      // 3. Reject empty retries — there's no point burning a Claude call if
      //    the user provided neither a note nor any documents.
      if (userNote.trim() === "" && parsedDocuments.length === 0) {
        res.status(400).json({
          error: "Provide at least a note or one document to retry this form.",
        });
        return;
      }

      // 4. Append the new entry to additionalContexts BEFORE calling
      //    fillFormMap, so the service reads the latest clarification when
      //    it loads the situational context.
      const newEntry: AdditionalContext = {
        formId,
        ...(beneficiaryKey ? { beneficiaryKey } : {}),
        userNote,
        documents: parsedDocuments,
        createdAt: new Date(),
      };

      await SituationalContext.findByIdAndUpdate(contextId, {
        $push: { additionalContexts: newEntry },
      }).exec();

      // 5. Re-run fillFormMap for just this (form, beneficiary) pair.
      let result;
      try {
        result = await fillFormMap({
          formId,
          userId,
          situationalContextId: contextId,
          beneficiaryKey,
        });
      } catch (err) {
        // On retry failure: replace the existing failedForms entry (if any)
        // with the new reason so the UI shows the latest explanation.
        const reason =
          err instanceof ClaudeContentError
            ? err.message
            : err instanceof ClaudeParseError
              ? "Form generation response could not be parsed."
              : "Form could not be generated at this time.";
        const code = err instanceof ClaudeContentError ? err.code : undefined;
        const failure: FormGenerationFailure = {
          formId,
          ...(beneficiaryKey ? { beneficiaryKey } : {}),
          ...(code ? { code } : {}),
          reason,
          failedAt: new Date(),
        };
        await SituationalContext.findByIdAndUpdate(contextId, {
          $pull: {
            failedForms: beneficiaryKey
              ? { formId, beneficiaryKey }
              : { formId, beneficiaryKey: { $in: [null, ""] } },
          },
        }).exec();
        await SituationalContext.findByIdAndUpdate(contextId, {
          $push: { failedForms: failure },
        }).exec();
        throw err;
      }

      // 6. Success — clear any stale failedForms entry for this pair so the
      //    UI flips from "Not generated" to "Ready" once it polls again.
      await SituationalContext.findByIdAndUpdate(contextId, {
        $pull: {
          failedForms: { formId, beneficiaryKey: beneficiaryKey ?? { $in: [null, undefined, ""] } },
        },
      }).exec();

      console.log(
        `[POST /api/situation/:id/retry-form] ${authTag(req)} | ` +
        `201 — retried ${formId}${beneficiaryKey ? ` (${beneficiaryKey})` : ""}`
      );
      res.status(201).json(result);
    } catch (err) {
      console.error(`[POST /api/situation/:id/retry-form] ${authTag(req)} | error`);
      serverError(req, res, err, "POST /api/situation/:id/retry-form");
    }
  }
);

// GET /api/situation/:id
router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  console.log(`[GET /api/situation/:id] ${authTag(req)} | Fetching context by id`);
  try {
    const doc = await SituationalContext.findById(req.params.id);
    // Another user's document is reported as 404 so IDs can't be probed.
    if (!doc || doc.userId !== req.auth!.sub) {
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
