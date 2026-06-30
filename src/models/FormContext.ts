import { Schema, model, Document } from "mongoose";
import type { IFormContext, FormFieldContext, FormMetadata } from "../types";

export interface FormContextDocument extends IFormContext, Document {}

const FormMetadataSchema = new Schema<FormMetadata>(
  {
    purpose: { type: String, default: "" },
    situations: { type: String, default: "" },
    "use-cases": { type: String, default: "" },
    // "per-beneficiary" | "household" — drives whether requiredForms entries
    // for this form need a beneficiaryKey. Absent on legacy FormContexts.
    scope: { type: String, enum: ["per-beneficiary", "household"] },
  },
  { strict: false } // allow extra keys in formMetadata
);

const FormFieldContextSchema = new Schema<FormFieldContext>(
  {
    field: { type: String, required: true },
    description: { type: String, default: "" },
    party: { type: String, default: "" },
    notes: { type: String, default: "" },
  },
  { _id: false }
);

const FormContextSchema = new Schema<FormContextDocument>(
  {
    formId: { type: String, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    formMetadata: { type: FormMetadataSchema, default: {} },
    fields: { type: [FormFieldContextSchema], default: [] },
    // Processes this form applies to (e.g. ["aos"]). A form can belong to
    // multiple processes. Absent on legacy docs.
    applicableProcesses: { type: [String], default: undefined, index: true },
  },
  { timestamps: false }
);

FormContextSchema.index({ formId: 1, createdAt: -1 });
FormContextSchema.index({ formId: 1, applicableProcesses: 1, createdAt: -1 });

export const FormContext = model<FormContextDocument>("FormContext", FormContextSchema);
