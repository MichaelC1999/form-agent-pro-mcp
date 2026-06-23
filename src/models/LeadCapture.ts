import { Schema, model, Document } from "mongoose";

export type LeadCaptureSource = "inline" | "sticky" | "exit_intent";

export const LEAD_CAPTURE_SOURCES: LeadCaptureSource[] = [
  "inline",
  "sticky",
  "exit_intent",
];

export interface LeadCaptureDocument extends Document {
  email: string;
  timeline?: string;
  source: LeadCaptureSource;
  business?: string;
  path?: string;
  referrer?: string;
  userAgent?: string;
  createdAt: Date;
}

const LeadCaptureSchema = new Schema<LeadCaptureDocument>(
  {
    email: { type: String, required: true, index: true },
    timeline: { type: String },
    source: {
      type: String,
      required: true,
      enum: LEAD_CAPTURE_SOURCES,
      index: true,
    },
    business: { type: String, index: true },
    path: { type: String },
    referrer: { type: String },
    userAgent: { type: String },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const LeadCapture = model<LeadCaptureDocument>(
  "LeadCapture",
  LeadCaptureSchema
);
