import { Schema, model, Document } from "mongoose";

export interface Step1InputDocument extends Document {
  text: string;
  sessionId?: string;
  createdAt: Date;
}

const Step1InputSchema = new Schema<Step1InputDocument>(
  {
    text: { type: String, required: true },
    sessionId: { type: String, index: true },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

export const Step1Input = model<Step1InputDocument>(
  "Step1Input",
  Step1InputSchema
);
