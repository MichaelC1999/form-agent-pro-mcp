import { Schema, model, Document } from "mongoose";

export interface IFilledAffidavit {
  /** Process this affidavit belongs to (e.g. "italy-student-visa") */
  processId: string;
  /** Affidavit identifier — file basename without extension (e.g. "bank-sponsorship-affidavit") */
  affidavitName: string;
  userId: string;
  situationalContextId: string;
  /** Beneficiary the affidavit is for (when scoped) — usually the visa applicant */
  beneficiaryKey?: string;
  createdAt: Date;
  /**
   * "filled"  — Claude produced filled markdown.
   * "skipped" — Claude determined this affidavit doesn't apply to this situation
   *             (e.g. parental-travel-authorization for an adult applicant).
   */
  status: "filled" | "skipped";
  /** Filled markdown. Empty string when status="skipped". */
  filledMarkdown: string;
  /** Brief reason from Claude — useful for skipped, optional for filled */
  reason?: string;
}

export interface FilledAffidavitDocument extends IFilledAffidavit, Document {}

const FilledAffidavitSchema = new Schema<FilledAffidavitDocument>(
  {
    processId: { type: String, required: true, index: true },
    affidavitName: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    situationalContextId: { type: String, required: true, index: true },
    beneficiaryKey: { type: String },
    createdAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["filled", "skipped"], required: true },
    filledMarkdown: { type: String, default: "" },
    reason: { type: String },
  },
  { timestamps: false }
);

FilledAffidavitSchema.index({
  situationalContextId: 1,
  affidavitName: 1,
  beneficiaryKey: 1,
  createdAt: -1,
});

export const FilledAffidavit = model<FilledAffidavitDocument>(
  "FilledAffidavit",
  FilledAffidavitSchema
);
