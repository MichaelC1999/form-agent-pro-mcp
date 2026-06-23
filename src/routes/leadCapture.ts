import { Router, Request, Response } from "express";
import {
  LeadCapture,
  LeadCaptureSource,
  LEAD_CAPTURE_SOURCES,
} from "../models/LeadCapture";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/lead-capture
// Body: { email, source, timeline?, business?, path?, referrer? }
// Records an email opt-in from the landing page lead-magnet capture
// (inline section, sticky bar, or desktop exit-intent overlay).
// <!-- BACKEND --> lead-magnet delivery + nurture enrollment not wired here yet.
router.post("/", async (req: Request, res: Response) => {
  try {
    const { email, source, timeline, business, path, referrer } =
      req.body as {
        email?: string;
        source?: string;
        timeline?: string;
        business?: string;
        path?: string;
        referrer?: string;
      };

    if (!email || typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      res.status(400).json({ error: "invalid or missing 'email'" });
      return;
    }

    if (!source || !LEAD_CAPTURE_SOURCES.includes(source as LeadCaptureSource)) {
      res.status(400).json({ error: "invalid or missing 'source'" });
      return;
    }

    const userAgent = req.get("user-agent") ?? undefined;

    const doc = await LeadCapture.create({
      email: email.trim().toLowerCase(),
      source: source as LeadCaptureSource,
      timeline: timeline?.trim() || undefined,
      business,
      path,
      referrer,
      userAgent,
    });

    res.status(201).json({ _id: doc._id, createdAt: doc.createdAt });
  } catch (err) {
    console.error("[POST /api/lead-capture]", err);
    res.status(500).json({ error: "Failed to record lead capture" });
  }
});

export default router;
