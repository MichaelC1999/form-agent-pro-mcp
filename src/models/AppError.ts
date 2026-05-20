import { Schema, model, Document } from "mongoose";
import type { Request } from "express";
import type { AppErrorType, IAppError } from "../types";

export interface AppErrorDocument extends IAppError, Document {}

const AppErrorSchema = new Schema<AppErrorDocument>(
  {
    errorType: { type: String, required: true, index: true },
    service: { type: String, required: true, index: true },
    route: { type: String, index: true },
    message: { type: String, required: true },
    stack: { type: String },
    code: { type: String, index: true },
    ipAddress: { type: String, index: true },
    userEmail: { type: String, index: true },
    userId: { type: String, index: true },
    formId: { type: String, index: true },
    situationalContextId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: false }
);

export const AppError = model<AppErrorDocument>("AppError", AppErrorSchema);

// ─── Typed error classes ─────────────────────────────────────────────────────
//
// Services throw these so routes (which know the request context) can decide
// which AppErrorType / status code to use without parsing message strings.

/** Claude returned an explicit `{ error: ... }` JSON object. */
export class ClaudeContentError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly service: string;
  readonly rawResponse?: string;
  constructor(args: {
    service: string;
    code: string;
    message: string;
    details?: string;
    rawResponse?: string;
  }) {
    super(args.message);
    this.name = "ClaudeContentError";
    this.code = args.code;
    this.details = args.details;
    this.service = args.service;
    this.rawResponse = args.rawResponse;
  }
}

/** Claude response could not be parsed as JSON. */
export class ClaudeParseError extends Error {
  readonly service: string;
  readonly rawResponse?: string;
  constructor(args: { service: string; message: string; rawResponse?: string }) {
    super(args.message);
    this.name = "ClaudeParseError";
    this.service = args.service;
    this.rawResponse = args.rawResponse;
  }
}

// ─── Request context extraction ──────────────────────────────────────────────

export interface AppErrorRequestMeta {
  ipAddress?: string;
  userEmail?: string;
  userId?: string;
  route?: string;
}

/** Pull IP + auth identity off an Express request for error tagging. */
export function requestErrorMeta(req: Request, routeLabel?: string): AppErrorRequestMeta {
  const forwarded = req.headers["x-forwarded-for"];
  const forwardedFirst = Array.isArray(forwarded)
    ? forwarded[0]
    : typeof forwarded === "string"
    ? forwarded.split(",")[0]?.trim()
    : undefined;
  const ipAddress = forwardedFirst || req.ip || req.socket?.remoteAddress || undefined;

  return {
    ipAddress,
    userEmail: req.auth?.email,
    userId: req.auth?.sub,
    route: routeLabel ?? `${req.method} ${req.originalUrl ?? req.path}`,
  };
}

// ─── Fire-and-forget logger ──────────────────────────────────────────────────

export interface LogAppErrorInput {
  err: unknown;
  service: string;
  errorType?: AppErrorType;
  request?: AppErrorRequestMeta | Request;
  formId?: string;
  situationalContextId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/** Maps thrown errors to the right AppErrorType when caller didn't specify. */
function inferErrorType(err: unknown): AppErrorType {
  if (err instanceof ClaudeContentError) return "anthropic_content";
  if (err instanceof ClaudeParseError) return "anthropic_parse";
  // The Anthropic SDK throws errors whose constructor name starts with "Anthropic"
  // (e.g. APIError, RateLimitError). Detect by name to avoid importing the SDK here.
  if (err && typeof err === "object") {
    const name = (err as { name?: string; constructor?: { name?: string } }).name
      ?? (err as { constructor?: { name?: string } }).constructor?.name;
    if (typeof name === "string" && name.startsWith("Anthropic")) {
      return "anthropic_api";
    }
  }
  return "server";
}

function isRequest(value: unknown): value is Request {
  return !!value && typeof value === "object" && "headers" in (value as object);
}

/**
 * Persists an AppError record to MongoDB. Fire-and-forget — never throws,
 * never blocks the calling handler. Safe to call from any catch block.
 */
export function logAppError(input: LogAppErrorInput): void {
  const { err, service, formId, situationalContextId, userId, metadata } = input;
  const errorType = input.errorType ?? inferErrorType(err);

  const meta: AppErrorRequestMeta = isRequest(input.request)
    ? requestErrorMeta(input.request)
    : input.request ?? {};

  const errObj = err as {
    message?: string;
    stack?: string;
    code?: string | number;
    details?: string;
    rawResponse?: string;
  };

  const message =
    typeof errObj?.message === "string"
      ? errObj.message
      : typeof err === "string"
      ? err
      : "Unknown error";

  const code = typeof errObj?.code !== "undefined" ? String(errObj.code) : undefined;

  // Merge Claude-specific detail into metadata if present
  const mergedMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
  if (errObj?.details) mergedMetadata.details = errObj.details;
  if (errObj?.rawResponse) mergedMetadata.rawResponse = errObj.rawResponse;

  AppError.create({
    errorType,
    service,
    route: meta.route,
    message,
    stack: errObj?.stack,
    code,
    ipAddress: meta.ipAddress,
    userEmail: meta.userEmail,
    userId: userId ?? meta.userId,
    formId,
    situationalContextId,
    metadata: Object.keys(mergedMetadata).length > 0 ? mergedMetadata : undefined,
  }).catch((logErr: unknown) => {
    console.warn(
      `[AppError] Failed to persist error for service="${service}":`,
      logErr instanceof Error ? logErr.message : logErr
    );
  });
}
