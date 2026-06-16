import { Router, Request, Response } from "express";
import { LandingEvent, LandingButton } from "../models/LandingEvent";

const router = Router();

const ALLOWED_BUTTONS: LandingButton[] = [
  "cta_primary",
  "cta_secondary",
  "cta_tertiary",
];

// POST /api/landing-event
// Body: { button, business?, href?, label?, path?, referrer? }
// Records a click on one of the three landing-page CTAs so we can compare
// engagement against ad-platform click totals.
router.post("/", async (req: Request, res: Response) => {
  try {
    const { button, business, href, label, path, referrer } = req.body as {
      button?: string;
      business?: string;
      href?: string;
      label?: string;
      path?: string;
      referrer?: string;
    };

    if (!button || !ALLOWED_BUTTONS.includes(button as LandingButton)) {
      res.status(400).json({ error: "invalid or missing 'button'" });
      return;
    }

    const userAgent = req.get("user-agent") ?? undefined;

    const doc = await LandingEvent.create({
      button: button as LandingButton,
      business,
      href,
      label,
      path,
      referrer,
      userAgent,
    });

    res.status(201).json({ _id: doc._id, createdAt: doc.createdAt });
  } catch (err) {
    console.error("[POST /api/landing-event]", err);
    res.status(500).json({ error: "Failed to record landing event" });
  }
});

export default router;
