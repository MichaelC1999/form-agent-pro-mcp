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

/**
 * Blocks new model-calling requests once today's estimated spend reaches
 * DAILY_SPEND_CAP_USD. GET requests (polling, downloads) always pass.
 * Unset or non-positive cap = no limit. Jobs already running finish, and
 * concurrent requests near the limit can overshoot it slightly.
 * Mount before route handlers so a blocked request never consumes a payment.
 */
export async function requireSpendBudget(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method === "GET") return next();

  const cap = parseFloat(process.env.DAILY_SPEND_CAP_USD ?? "");
  if (!Number.isFinite(cap) || cap <= 0) return next();

  try {
    const spent = await getTodaySpendUsd();
    if (spent >= cap) {
      console.warn(`[spendCap] ${req.method} ${req.originalUrl} | 503 — daily cap reached ($${spent.toFixed(2)} / $${cap})`);
      res.status(503).json({ error: "Service is at capacity for today. Please try again tomorrow." });
      return;
    }
    next();
  } catch (err) {
    // Fail closed: if spend can't be measured, don't start new paid work.
    console.error("[spendCap] Failed to read today's spend:", err);
    res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
  }
}
