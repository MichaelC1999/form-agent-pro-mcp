import { Schema, model, Document } from "mongoose";
import type { ISituationalContext, ParsedDocument } from "../types";

export interface SituationalContextDocument extends ISituationalContext, Document {}

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
  },
  { timestamps: false }
);

SituationalContextSchema.index({ userId: 1, createdAt: -1 });

export const SituationalContext = model<SituationalContextDocument>(
  "SituationalContext",
  SituationalContextSchema
);
