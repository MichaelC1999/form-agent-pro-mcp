import { Schema, model } from "mongoose";

/**
 * Short-lived download links handed to MCP clients by get_filled_pdf.
 * The link's random token is the credential, stored only as a SHA-256 hash,
 * and the record expires through a TTL index on `expiresAt`.
 */
const McpDownloadSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    kind: { type: String, enum: ["form", "merged"], required: true },
    userId: { type: String, required: true },
    situationalContextId: { type: String, required: true },
    /** Set when kind is "form". */
    filledFormMapId: { type: String },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false }
);
McpDownloadSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const McpDownload = model("McpDownload", McpDownloadSchema);
