import * as path from "path";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { fillForm } from "./fillForm";

const ASSETS_FORMS_DIR = path.resolve(__dirname, "../../assets/forms");

function getBlankPdfPath(formId: string): string {
  return path.join(ASSETS_FORMS_DIR, formId, "blank.pdf");
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PipelineFormResult {
  formId: string;
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
  const requiredForms: string[] = (ctxDoc as any).requiredForms ?? [];

  if (requiredForms.length === 0) {
    throw new Error(
      `SituationalContext ${situationalContextId} has no requiredForms.`
    );
  }

  // 2. For each required form, find the most recent FilledFormMap
  const forms: PipelineFormResult[] = [];

  for (const formId of requiredForms) {
    const filledMap = await FilledFormMap
      .findOne({ userId, formId })
      .sort({ createdAt: -1 })
      .lean();

    if (!filledMap) {
      console.warn(`[runPipeline] ⚠️  No FilledFormMap found for form "${formId}" (userId: ${userId}) — skipping`);
      forms.push({
        formId,
        filledFormMapId: "",
        success: false,
        outputPath: "",
        filledFields: [],
        skippedFields: [],
        errors: [`No FilledFormMap found for form "${formId}". Run fillFormMap first.`],
      });
      continue;
    }

    const filledFormMapId = String((filledMap as any)._id);

    try {
      const fillResult = await fillForm({
        formId,
        userId,
        filledFormMapId,
        formPdfPath: getBlankPdfPath(formId),
      });

      console.log(
        `[runPipeline] ${fillResult.success ? "✓" : "✗"} ${formId} → ${fillResult.outputPath}`
      );

      forms.push({ formId, filledFormMapId, ...fillResult });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[runPipeline] ❌ ${formId}: ${message}`);
      forms.push({
        formId,
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
