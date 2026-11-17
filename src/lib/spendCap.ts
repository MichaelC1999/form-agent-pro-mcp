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

export type SpendCheck = { ok: true } | { ok: false; reason: "cap_reached" | "user_cap_reached" | "unavailable" };

/** One user's estimated Anthropic spend since 00:00 UTC today. Not cached. */
export async function getUserTodaySpendUsd(userId: string): Promise<number> {
  const [row] = await AnthropicLog.aggregate<{ usd: number }>([
    { $match: { userId, createdAt: { $gte: new Date(`${utcDay()}T00:00:00.000Z`) } } },
    { $group: { _id: null, usd: { $sum: { $ifNull: ["$costUsd", 0] } } } },
  ]);
  return row?.usd ?? 0;
}

/**
 * Whether this user may start new model-calling work, given
 * USER_DAILY_SPEND_CAP_USD. Unset or non-positive cap = no per-user limit.
 * Fails closed if spend can't be read. Background work already running
 * finishes, so a user can end slightly over the cap.
 */
export async function checkUserSpendBudget(userId: string, label: string): Promise<SpendCheck> {
  const cap = parseFloat(process.env.USER_DAILY_SPEND_CAP_USD ?? "");
  if (!Number.isFinite(cap) || cap <= 0) return { ok: true };

  try {
    const spent = await getUserTodaySpendUsd(userId);
    if (spent >= cap) {
      console.warn(`[spendCap] ${label} | blocked — user ${userId} at daily cap ($${spent.toFixed(2)} / $${cap})`);
      return { ok: false, reason: "user_cap_reached" };
    }
    return { ok: true };
  } catch (err) {
    console.error("[spendCap] Failed to read user's spend:", err);
    return { ok: false, reason: "unavailable" };
  }
}

/**
 * Express guard for model-calling routes, per signed-in user. Must run after
 * requireAuth and before any payment check, so a blocked request never
 * consumes a payment.
 */
export async function requireUserSpendBudget(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.auth?.sub;
  if (!userId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const check = await checkUserSpendBudget(userId, `${req.method} ${req.originalUrl}`);
  if (check.ok) return next();
  if (check.reason === "user_cap_reached") {
    res.status(429).json({ error: "You've reached today's usage limit. Please try again tomorrow." });
    return;
  }
  res.status(503).json({ error: "Service temporarily unavailable. Please try again shortly." });
}

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
