import { Schema, model, Document } from "mongoose";
import type { IFormContext, FormFieldContext, FormMetadata } from "../types";

export interface FormContextDocument extends IFormContext, Document {}

const FormMetadataSchema = new Schema<FormMetadata>(
  {
    purpose: { type: String, default: "" },
    situations: { type: String, default: "" },
    "use-cases": { type: String, default: "" },
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
  },
  { timestamps: false }
);

FormContextSchema.index({ formId: 1, createdAt: -1 });

export const FormContext = model<FormContextDocument>("FormContext", FormContextSchema);
