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
