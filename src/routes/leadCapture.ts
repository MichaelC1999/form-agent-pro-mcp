import { Router, Request, Response } from "express";
import {
  LeadCapture,
  LeadCaptureSource,
  LEAD_CAPTURE_SOURCES,
} from "../models/LeadCapture";
import { sendChecklistEmail } from "../services/email";

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/lead-capture
// Body: { email, source, timeline?, business?, path?, referrer? }
// Records an email opt-in from the landing page lead-magnet capture
// (inline section, sticky bar, or desktop exit-intent overlay). After the
// lead is persisted, fire off the founder's note + checklist PDF as a
// background send so SMTP latency never blocks the 201 response.
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

    const normalizedEmail = email.trim().toLowerCase();
    const userAgent = req.get("user-agent") ?? undefined;

    const doc = await LeadCapture.create({
      email: normalizedEmail,
      source: source as LeadCaptureSource,
      timeline: timeline?.trim() || undefined,
      business,
      path,
      referrer,
      userAgent,
    });

    res.status(201).json({ _id: doc._id, createdAt: doc.createdAt });

    // Fire-and-forget: deliver the checklist PDF + founder note. We've
    // already 201'd the client; SMTP delays or failures must not surface
    // as request errors. Log the result for ops follow-up.
    sendChecklistEmail(normalizedEmail)
      .then((result) => {
        if (!result.ok) {
          console.error(
            "[lead-capture] checklist email failed",
            { email: normalizedEmail, error: result.error }
          );
        } else {
          console.log(
            "[lead-capture] checklist email sent",
            { email: normalizedEmail, messageId: result.messageId }
          );
        }
      })
      .catch((err) => {
        console.error("[lead-capture] checklist email threw", err);
      });
  } catch (err) {
    console.error("[POST /api/lead-capture]", err);
    res.status(500).json({ error: "Failed to record lead capture" });
  }
});

export default router;
