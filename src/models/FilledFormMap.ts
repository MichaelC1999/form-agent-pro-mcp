import { Schema, model, Document } from "mongoose";
import type { IFilledFormMap, AssumptionLevel } from "../types";

export interface FilledFormMapDocument extends IFilledFormMap, Document {}

const SkippedFieldSchema = new Schema(
  {
    fieldId: { type: String, required: true },
    reason:  { type: String, required: true },
  },
  { _id: false }
);

const FilledFormMapSchema = new Schema<FilledFormMapDocument>(
  {
    formId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    // Absent for legacy single-beneficiary fills and for forms filed once
    // per household (I-864, N-400, etc.).
    beneficiaryKey: { type: String, index: true },
    assumptionLevel: {
      type: String,
      enum: ["conservative", "moderate", "liberal"] as AssumptionLevel[],
      default: "liberal",
    },
    // Process this fill was generated for. Inherited from the
    // SituationalContext at fill time. Absent on legacy fills.
    processId: { type: String, index: true },
    // fields: { "<fieldId>": "filled value" }
    fields:  { type: Schema.Types.Mixed, required: true, default: {} },
    // skipped: fields the LLM could not confidently fill, with reasons
    skipped: { type: [SkippedFieldSchema], default: [] },
  },
  { timestamps: false }
);

FilledFormMapSchema.index({ formId: 1, userId: 1, createdAt: -1 });
// Compound index for the per-beneficiary dedupe used by /pdf/merged.
FilledFormMapSchema.index({ userId: 1, formId: 1, beneficiaryKey: 1, createdAt: -1 });

export const FilledFormMap = model<FilledFormMapDocument>("FilledFormMap", FilledFormMapSchema);
