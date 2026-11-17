import { buildSituationContext } from "./buildSituationContext";
import { fillFormMap } from "./fillFormMap";
import { deleteTempFiles } from "../middleware/cleanupUploads";
import { SituationalContext } from "../models/SituationalContext";
import { normalizeRequiredForms } from "../types";
import type { FormGenerationFailure, UIAnswers, UploadedFile } from "../types";
import {
  logAppError,
  ClaudeContentError,
  ClaudeParseError,
  type AppErrorRequestMeta,
} from "../models/AppError";

export interface StartSituationBuildInput {
  userId: string;
  uiAnswers: UIAnswers;
  uploadedFiles: UploadedFile[];
  processIdHint?: string;
  /** Caller identity/route for error logs written after the request has returned. */
  requestMeta: AppErrorRequestMeta;
  /** Prefix for console logs, e.g. "auth=<sub>" or "mcp user=<sub>". */
  logTag: string;
  /** Service label for AppError records, e.g. "POST /api/situation/build". */
  serviceLabel: string;
}

/**
 * Starts the paid situation pipeline shared by the web app and MCP:
 *   1. Creates a SituationalContext stub (status "processing") and returns its id.
 *   2. In the background: buildSituationContext (Anthropic), then fillFormMap
 *      for every required (form, beneficiary) entry.
 *
 * Callers poll the SituationalContext (status, failedForms, pipelineCompletedAt)
 * and the user's FilledFormMaps for progress. Payment and input validation
 * must happen before calling this.
 *
 * Takes ownership of `uploadedFiles`: they are deleted once their text has
 * been extracted. Callers must not delete them (web route: set
 * res.locals.keepUploads after this returns).
 */
export async function startSituationBuild(input: StartSituationBuildInput): Promise<string> {
  const { userId, uiAnswers, uploadedFiles, processIdHint, requestMeta, logTag, serviceLabel } = input;

  const stub = await SituationalContext.create({
    userId,
    status: "processing",
    partyData: {},
    documents: [],
    situationSummary: "",
    requiredForms: [],
  });
  const contextId = stub._id.toString();

  // ── Background pipeline (fire-and-forget) ─────────────────────────────
  void (async () => {
    try {
      console.log(`[background] ${logTag} | Starting Anthropic context build id=${contextId}`);

      // Step 1: Build situational context via Anthropic (updates the stub doc).
      // The uploaded originals are only needed for text extraction here; their
      // text is stored on the context, so delete the files right after.
      let ctx: Awaited<ReturnType<typeof buildSituationContext>>;
      try {
        ctx = await buildSituationContext(
          {
            userId,
            uiAnswers,
            uploadedFiles,
            ...(processIdHint && processIdHint.trim() !== "" ? { processIdHint: processIdHint.trim() } : {}),
          },
          contextId
        );
      } finally {
        deleteTempFiles(uploadedFiles.map((f) => f.path));
      }

      const requiredEntries = normalizeRequiredForms(ctx.requiredForms);
      const formsLabel = requiredEntries
        .map((e) => (e.beneficiaryKey ? `${e.formId} (${e.beneficiaryKey})` : e.formId))
        .join(", ");
      console.log(`[background] ${logTag} | Context ready id=${contextId} forms=${formsLabel || "none"}`);

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
          console.log(`[background] ${logTag} | Filling form map ${label}`);
          await fillFormMap({ formId, userId, situationalContextId: contextId, beneficiaryKey });
          console.log(`[background] ${logTag} | Form map ready ${label}`);
        } catch (err) {
          console.error(`[background] ${logTag} | Form map failed ${label}:`, err);
          logAppError({
            err,
            service: `${serviceLabel} (background fillFormMap)`,
            request: requestMeta,
            formId,
            situationalContextId: contextId,
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
            await SituationalContext.findByIdAndUpdate(contextId, { $push: { failedForms: failure } }).exec();
          } catch (writeErr) {
            console.warn(`[background] ${logTag} | Failed to persist failedForms entry for ${label}:`, writeErr);
          }
          failureCount++;
        }
      }

      // Mark the pipeline as complete regardless of partial failures. The
      // UI uses this timestamp as a backstop signal — any required form
      // without a FilledFormMap AND without an explicit failure entry is
      // treated as "Not generated" once this is set.
      try {
        await SituationalContext.findByIdAndUpdate(contextId, { pipelineCompletedAt: new Date() }).exec();
      } catch (writeErr) {
        console.warn(`[background] ${logTag} | Failed to persist pipelineCompletedAt:`, writeErr);
      }

      console.log(
        `[background] ${logTag} | Pipeline complete id=${contextId} failures=${failureCount}/${requiredEntries.length}`
      );
    } catch (err) {
      console.error(`[background] ${logTag} | Pipeline failed id=${contextId}:`, err);
      logAppError({
        err,
        service: `${serviceLabel} (background buildSituationContext)`,
        request: requestMeta,
        situationalContextId: contextId,
        userId,
      });
      await SituationalContext.findByIdAndUpdate(contextId, { status: "error" }).catch(() => {});
    }
  })();

  return contextId;
}
