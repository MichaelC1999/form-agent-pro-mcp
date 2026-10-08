import { Schema, model, Document } from "mongoose";
import type { IFormMap } from "../types";

export interface FormMapDocument extends IFormMap, Document {}

const FormMapSchema = new Schema<FormMapDocument>(
  {
    formId: { type: String, required: true, index: true },
    version: { type: String, required: true, default: "1.0" },
    createdAt: { type: Date, default: Date.now },
    // fields is a free-form object: { "<fieldId>": "" }
    fields: { type: Schema.Types.Mixed, required: true, default: {} },
    // fieldMeta: { "<fieldId>": { type, maxLength?, options? } } — see FieldMeta
    fieldMeta: { type: Schema.Types.Mixed },
  },
  { timestamps: false }
);

// Compound index so we can quickly look up the latest map for a form
FormMapSchema.index({ formId: 1, createdAt: -1 });

export const FormMap = model<FormMapDocument>("FormMap", FormMapSchema);
