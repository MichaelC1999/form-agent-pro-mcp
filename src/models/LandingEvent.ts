import { Schema, model, Document } from "mongoose";

export type LandingButton = "cta_primary" | "cta_secondary" | "cta_tertiary";

export interface LandingEventDocument extends Document {
  button: LandingButton;
  business?: string;
  href?: string;
  label?: string;
  path?: string;
  referrer?: string;
  userAgent?: string;
  createdAt: Date;
}

const LandingEventSchema = new Schema<LandingEventDocument>(
  {
    button: {
      type: String,
      required: true,
      enum: ["cta_primary", "cta_secondary", "cta_tertiary"],
      index: true,
    },
    business: { type: String, index: true },
    href: { type: String },
    label: { type: String },
    path: { type: String },
    referrer: { type: String },
    userAgent: { type: String },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const LandingEvent = model<LandingEventDocument>(
  "LandingEvent",
  LandingEventSchema
);
