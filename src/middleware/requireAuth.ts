import { Request, Response, NextFunction } from "express";
import { OAuth2Client } from "google-auth-library";

const GOOGLE_CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ??
  "51203109879-m7tappvbp655f99f0j0s13qjes30opfa.apps.googleusercontent.com";

const client = new OAuth2Client(GOOGLE_CLIENT_ID);

export interface AuthPayload {
  sub: string;
  email: string;
  name: string;
  picture: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/** Returns a short auth status string for logging. */
export function authTag(req: Request): string {
  return req.auth ? `auth=${req.auth.sub}` : "auth=none";
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  console.log(`[requireAuth] ${req.method} ${req.path} | Verifying bearer token`);

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    console.log(`[requireAuth] ${req.method} ${req.path} | 401 — no bearer token`);
    res
      .status(401)
      .json({ error: "Authentication required. Please sign in with Google." });
    return;
  }

  const idToken = header.slice(7);

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub) {
      console.log(`[requireAuth] ${req.method} ${req.path} | 401 — token missing sub`);
      res.status(401).json({ error: "Invalid authentication token." });
      return;
    }

    req.auth = {
      sub: payload.sub,
      email: payload.email ?? "",
      name: payload.name ?? "",
      picture: payload.picture ?? "",
    };
    console.log(`[requireAuth] ${req.method} ${req.path} | Verified user=${payload.sub}`);
    next();
  } catch (err) {
    console.error(`[requireAuth] ${req.method} ${req.path} | 401 — verification failed:`, err);
    res.status(401).json({
      error: "Authentication token expired or invalid. Please sign in again.",
    });
  }
}

/**
 * Admin gate for form-setup routes (form-map, form-context, form-fill).
 * These run expensive Anthropic calls and are not part of the user flow, so
 * only emails listed in ADMIN_EMAILS (comma-separated) may call them.
 * Must run after requireAuth. Fails closed when ADMIN_EMAILS is unset.
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = req.auth?.email.toLowerCase();
  if (!email || !admins.includes(email)) {
    console.log(`[requireAdmin] ${req.method} ${req.path} | 403 — ${authTag(req)} not an admin`);
    res.status(403).json({ error: "Admin access required." });
    return;
  }
  next();
}
