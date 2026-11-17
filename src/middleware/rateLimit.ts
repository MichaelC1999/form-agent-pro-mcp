import rateLimit from "express-rate-limit";

/** Per-IP request budget, read from env with a default. */
function envInt(name: string, fallback: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Broad per-IP limit for all /api traffic. Generous enough for the report
 * page's status polling; stops scripted floods.
 */
export const generalLimiter = rateLimit({
  windowMs: 60_000,
  limit: envInt("RATE_LIMIT_GENERAL_PER_MIN", 300),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down." },
});

/**
 * Tight per-IP limit for requests that start model calls. GETs (polling,
 * downloads) are skipped. Per-user caps come later with usage metering.
 */
export const inferenceLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: envInt("RATE_LIMIT_INFERENCE_PER_15MIN", 10),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.method === "GET",
  message: { error: "Too many submissions. Please wait a few minutes and try again." },
});
