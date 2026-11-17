import { Schema, model, Document } from "mongoose";
import type { IAnthropicLog } from "../types";
import { estimateCostUsd } from "../lib/pricing";
import { currentUsage } from "../lib/usageContext";

export interface AnthropicLogDocument extends IAnthropicLog, Document {
  /** Estimated USD cost of the call; summed by the daily spend caps. */
  costUsd?: number;
  /** Entry point: "web" (website/API) or "mcp" (AI agent). */
  channel?: "web" | "mcp";
  /** MCP tool that started the work, when channel is "mcp". */
  mcpTool?: string;
}

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
      cacheReadTokens: { type: Number },
      cacheCreationTokens: { type: Number },
    },
    costUsd: { type: Number },
    channel: { type: String, enum: ["web", "mcp"], index: true },
    mcpTool: { type: String },
    payload: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);
// Per-user daily spend lookups.
AnthropicLogSchema.index({ userId: 1, createdAt: 1 });

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
  const anthropicModel: string = response.model ?? "unknown";
  const usageCtx = currentUsage();
  const usage = response.usage
    ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      }
    : undefined;

  AnthropicLog.create({
    service: ctx.service,
    anthropicModel,
    formId: ctx.formId,
    userId: ctx.userId,
    situationalContextId: ctx.situationalContextId,
    stopReason: response.stop_reason ?? null,
    usage,
    costUsd: usage ? estimateCostUsd(anthropicModel, usage) : undefined,
    channel: usageCtx.channel,
    mcpTool: usageCtx.mcpTool,
    payload: JSON.parse(JSON.stringify(response)),
  }).catch((err: unknown) => {
    console.warn(
      `[AnthropicLog] Failed to persist response for service="${ctx.service}":`,
      err instanceof Error ? err.message : err
    );
  });
}
