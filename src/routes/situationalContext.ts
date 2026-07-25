import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import {
  buildSituationContext,
  extractRawText,
  getMimeCategory,
} from "../services/buildSituationContext";
import { fillFormMap } from "../services/fillFormMap";
import { SituationalContext } from "../models/SituationalContext";
import { normalizeRequiredForms } from "../types";
import type {
  AdditionalContext,
  FormGenerationFailure,
  ParsedDocument,
} from "../types";
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

    // DEMO: Stripe payment gate disabled to allow full workflow demo without checkout.
    // TODO: restore by uncommenting the block below.
    // const paid = await assertSessionPaid(stripeSessionId, userId);
    // if (!paid.ok) {
    //   console.log(`[POST /api/situation/build] ${authTag(req)} | ${paid.status} — ${paid.error}`);
    //   res.status(paid.status).json({ error: paid.error });
    //   return;
    // }
    void stripeSessionId;

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
            ...(processIdHint && processIdHint.trim() !== ""
              ? { processIdHint: processIdHint.trim() }
              : {}),
          },
          stub._id.toString()
        );

        const requiredEntries = normalizeRequiredForms(ctx.requiredForms);
        const formsLabel = requiredEntries
          .map((e) => (e.beneficiaryKey ? `${e.formId} (${e.beneficiaryKey})` : e.formId))
          .join(", ");
        console.log(
          `[background] ${authTag(req)} | Context ready id=${stub._id} forms=${formsLabel || "none"}`
        );

        // Step 2: Fill form maps for each required (form, beneficiary) entry.
        // Failures must be persisted to the SituationalContext IMMEDIATELY
        // (per-iteration $push), not batched at the end of the loop. The
        // form-fill loop is sequential, so if we batch we leave every failed
        // row stuck on "Pending" until the slowest remaining form finishes —
        // sometimes minutes later. Per-iteration writes let the report UI
        // flip a failed row to "Not generated" on its next 10s poll, while
        // its sibling forms are still being attempted.
        let failureCount = 0;

        for (const entry of requiredEntries) {
          const { formId, beneficiaryKey } = entry;
          const label = beneficiaryKey ? `${formId} (${beneficiaryKey})` : formId;
          try {
            console.log(`[background] ${authTag(req)} | Filling form map ${label}`);
            await fillFormMap({
              formId,
              userId,
              situationalContextId: stub._id.toString(),
              beneficiaryKey,
            });
            console.log(`[background] ${authTag(req)} | Form map ready ${label}`);
          } catch (err) {
            console.error(`[background] ${authTag(req)} | Form map failed ${label}:`, err);
            logAppError({
              err,
              service: "POST /api/situation/build (background fillFormMap)",
              request: backgroundRequestMeta,
              formId,
              situationalContextId: stub._id.toString(),
              userId,
            });
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
            try {
              await SituationalContext.findByIdAndUpdate(stub._id, {
                $push: { failedForms: failure },
              }).exec();
            } catch (writeErr) {
              console.warn(
                `[background] ${authTag(req)} | Failed to persist failedForms entry for ${label}:`,
                writeErr
              );
            }
            failureCount++;
          }
        }

        // Mark the pipeline as complete regardless of partial failures. The
        // UI uses this timestamp as a backstop signal — any required form
        // without a FilledFormMap AND without an explicit failure entry is
        // treated as "Not generated" once this is set.
        try {
          await SituationalContext.findByIdAndUpdate(stub._id, {
            pipelineCompletedAt: new Date(),
          }).exec();
        } catch (writeErr) {
          console.warn(
            `[background] ${authTag(req)} | Failed to persist pipelineCompletedAt:`,
            writeErr
          );
        }

        console.log(
          `[background] ${authTag(req)} | Pipeline complete id=${stub._id} ` +
          `failures=${failureCount}/${requiredEntries.length}`
        );
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
