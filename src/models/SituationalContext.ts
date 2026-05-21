import { Schema, model, Document } from "mongoose";
import type {
  ISituationalContext,
  ParsedDocument,
  FormGenerationFailure,
  AdditionalContext,
} from "../types";

export interface SituationalContextDocument extends ISituationalContext, Document {}

const FormGenerationFailureSchema = new Schema<FormGenerationFailure>(
  {
    formId: { type: String, required: true },
    beneficiaryKey: { type: String },
    code: { type: String },
    reason: { type: String, required: true },
    failedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const ParsedDocumentSchema = new Schema<ParsedDocument>(
  {
    originalName: { type: String, required: true },
    mimeCategory: { type: String, enum: ["pdf", "image", "text"], required: true },
    rawText: { type: String, default: "" },
    extractedFacts: { type: Schema.Types.Mixed },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const AdditionalContextSchema = new Schema<AdditionalContext>(
  {
    formId: { type: String, required: true },
    beneficiaryKey: { type: String },
    userNote: { type: String, default: "" },
    documents: { type: [ParsedDocumentSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SituationalContextSchema = new Schema<SituationalContextDocument>(
  {
    userId: { type: String, required: true, index: true },
    createdAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["processing", "ready", "error"],
      default: "processing",
    },
    // partyData: open-ended party/subject map — stored as Mixed
    partyData: { type: Schema.Types.Mixed, required: true, default: {} },
    documents: { type: [ParsedDocumentSchema], default: [] },
    situationSummary: { type: String, default: "" },
    // Mixed so both legacy `["i-485", "i-130"]` and the current
    // `[{ formId: "i-485", beneficiaryKey: "Maria" }]` shape can be stored.
    // Always read through `normalizeRequiredForms` from types/index.ts.
    requiredForms: { type: Schema.Types.Mixed, default: [] },
    // Set by the background pipeline when it finishes processing every entry
    // in requiredForms. Frontend uses this to flip "Pending" → "Not generated"
    // for any form that didn't produce a FilledFormMap.
    pipelineCompletedAt: { type: Date },
    failedForms: { type: [FormGenerationFailureSchema], default: [] },
    additionalContexts: { type: [AdditionalContextSchema], default: [] },
  },
  { timestamps: false }
);

SituationalContextSchema.index({ userId: 1, createdAt: -1 });

export const SituationalContext = model<SituationalContextDocument>(
  "SituationalContext",
  SituationalContextSchema
);
