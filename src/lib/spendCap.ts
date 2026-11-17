import { Request, Response, NextFunction } from "express";
import { AnthropicLog } from "../models/AnthropicLog";

// Spend is re-aggregated from MongoDB at most once per minute.
const CACHE_MS = 60_000;
let cached: { day: string; usd: number; at: number } | null = null;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Estimated Anthropic spend since 00:00 UTC today, from AnthropicLog.costUsd. */
export async function getTodaySpendUsd(): Promise<number> {
  const day = utcDay();
  if (cached && cached.day === day && Date.now() - cached.at < CACHE_MS) return cached.usd;

  const [row] = await AnthropicLog.aggregate<{ usd: number }>([
    { $match: { createdAt: { $gte: new Date(`${day}T00:00:00.000Z`) } } },
    { $group: { _id: null, usd: { $sum: { $ifNull: ["$costUsd", 0] } } } },
  ]);
  cached = { day, usd: row?.usd ?? 0, at: Date.now() };
  return cached.usd;
}

export type SpendCheck = { ok: true } | { ok: false; reason: "cap_reached" | "unavailable" };

/**
 * Whether new model-calling work may start, given DAILY_SPEND_CAP_USD.
 * Unset or non-positive cap = no limit. Fails closed if spend can't be read.
 * Jobs already running finish, and concurrent requests near the limit can
 * overshoot it slightly.
 */
export async function checkSpendBudget(label: string): Promise<SpendCheck> {
  const cap = parseFloat(process.env.DAILY_SPEND_CAP_USD ?? "");
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };

  try {
    const spent = await getTodaySpendUsd();
    if (spent >= cap) {
      console.warn(`[spendCap] ${label} | blocked — daily cap reached ($${spent.toFixed(2)} / $${cap})`);
      return { ok: false, reason: "cap_reached" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[spendCap] Failed to read today's spend:", err);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Express guard for model-calling routes; GET requests (polling, downloads)
 * always pass. Mount before route handlers so a blocked request never
 * consumes a payment.
 */
export async function requireSpendBudget(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "GET") return next();

  const check = await checkSpendBudget(`${req.method} ${req.originalUrl}`);
  if (check.ok) return next();
  res.status(503).json({
    error:
      check.reason === "cap_reached"
        ? "Service is at capacity for today. Please try again tomorrow."
        : "Service temporarily unavailable. Please try again shortly.",
  });
}
