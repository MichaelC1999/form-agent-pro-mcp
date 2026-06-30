import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { fillForm } from "./fillForm";
import { normalizeRequiredForms } from "../types";
import { getBlankPdfPath, resolveProcessId } from "../lib/processes";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineFormResult {
  formId: string;
  beneficiaryKey?: string;
  filledFormMapId: string;
  success: boolean;
  outputPath: string;
  filledFields: string[];
  skippedFields: string[];
  errors: string[];
}

export interface RunPipelineResult {
  situationalContextId: string;
  userId: string;
  forms: PipelineFormResult[];
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * For every form in a SituationalContext's requiredForms, finds the most
 * recently saved FilledFormMap and runs fillForm to produce a filled PDF.
 *
 * fillFormMap is NOT called here — this service assumes FilledFormMap records
 * already exist in MongoDB for this context.
 *
 * Caller is responsible for establishing a DB connection before calling this.
 *
 * @param situationalContextId  MongoDB _id of the target SituationalContext
 */
export async function runPipeline(situationalContextId: string): Promise<RunPipelineResult> {
  // 1. Load SituationalContext
  const ctxDoc = await SituationalContext.findById(situationalContextId).lean();
  if (!ctxDoc) {
    throw new Error(`SituationalContext not found: ${situationalContextId}`);
  }

  const userId = (ctxDoc as any).userId as string;
  const processId = resolveProcessId((ctxDoc as any).processId);
  const requiredEntries = normalizeRequiredForms((ctxDoc as any).requiredForms);

  if (requiredEntries.length === 0) {
    throw new Error(
      `SituationalContext ${situationalContextId} has no requiredForms.`
    );
  }

  // 2. For each (form, beneficiary) entry, find the most recent matching
  //    FilledFormMap. Lookup keys on beneficiaryKey when present so each
  //    beneficiary's fill is paired with the right PDF.
  const forms: PipelineFormResult[] = [];

  for (const entry of requiredEntries) {
    const { formId, beneficiaryKey } = entry;
    const label = beneficiaryKey ? `${formId} (${beneficiaryKey})` : formId;

    const query: Record<string, unknown> = { userId, formId };
    if (beneficiaryKey) {
      query.beneficiaryKey = beneficiaryKey;
    } else {
      // Match docs that have no beneficiaryKey set (household-scope) — exclude
      // per-beneficiary fills from being chosen as a household-scope match.
      query.beneficiaryKey = { $in: [null, undefined, ""] };
    }

    const filledMap = await FilledFormMap
      .findOne(query)
      .sort({ createdAt: -1 })
      .lean();

    if (!filledMap) {
      console.warn(`[runPipeline] ⚠️  No FilledFormMap found for ${label} (userId: ${userId}) — skipping`);
      forms.push({
        formId,
        beneficiaryKey,
        filledFormMapId: "",
        success: false,
        outputPath: "",
        filledFields: [],
        skippedFields: [],
        errors: [`No FilledFormMap found for "${label}". Run fillFormMap first.`],
      });
      continue;
    }

    const filledFormMapId = String((filledMap as any)._id);

    try {
      const fillResult = await fillForm({
        formId,
        userId,
        filledFormMapId,
        formPdfPath: getBlankPdfPath(processId, formId),
      });

      console.log(
        `[runPipeline] ${fillResult.success ? "✓" : "✗"} ${label} → ${fillResult.outputPath}`
      );

      forms.push({ formId, beneficiaryKey, filledFormMapId, ...fillResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runPipeline] ❌ ${label}: ${message}`);
      forms.push({
        formId,
        beneficiaryKey,
        filledFormMapId,
        success: false,
        outputPath: "",
        filledFields: [],
        skippedFields: [],
        errors: [message],
      });
    }
  }

  return { situationalContextId, userId, forms };
}
