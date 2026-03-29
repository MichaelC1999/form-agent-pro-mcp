import { Schema, model, Document } from "mongoose";
import type { IAnthropicLog } from "../types";

export interface AnthropicLogDocument extends IAnthropicLog, Document {}

const AnthropicLogSchema = new Schema<AnthropicLogDocument>(
  {
    service: { type: String, required: true, index: true },
    anthropicModel: { type: String, required: true },
    formId: { type: String, index: true },
    userId: { type: String, index: true },
    situationalContextId: { type: String, index: true },
    stopReason: { type: String },
    usage: {
      inputTokens: { type: Number },
      outputTokens: { type: Number },
    },
    payload: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const AnthropicLog = model<AnthropicLogDocument>(
  "AnthropicLog",
  AnthropicLogSchema
);

// ─── Fire-and-forget logging helper ──────────────────────────────────────────

export interface AnthropicLogContext {
  service: string;
  formId?: string;
  userId?: string;
  situationalContextId?: string;
}

/**
 * Persists the entire Anthropic response payload to MongoDB.
 * Non-blocking — errors are logged to console.warn and never rethrow,
 * so a logging failure never interrupts the calling service.
 */
export function logAnthropicResponse(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any,
  ctx: AnthropicLogContext
): void {
  AnthropicLog.create({
    service: ctx.service,
    anthropicModel: response.model ?? "unknown",
    formId: ctx.formId,
    userId: ctx.userId,
    situationalContextId: ctx.situationalContextId,
    stopReason: response.stop_reason ?? null,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined,
    payload: JSON.parse(JSON.stringify(response)),
  }).catch((err: unknown) => {
    console.warn(
      `[AnthropicLog] Failed to persist response for service="${ctx.service}":`,
      err instanceof Error ? err.message : err
    );
  });
}
