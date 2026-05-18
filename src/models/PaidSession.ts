import { Schema, model, Document } from "mongoose";

export interface PaidSessionDocument extends Document {
  sessionId: string;
  userId: string;
  consumedAt: Date;
}

const PaidSessionSchema = new Schema<PaidSessionDocument>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    consumedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

export const PaidSession = model<PaidSessionDocument>(
  "PaidSession",
  PaidSessionSchema
);
