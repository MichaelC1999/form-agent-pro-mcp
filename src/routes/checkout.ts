import { Router, Request, Response } from "express";
import { requireAuth, authTag } from "../middleware/requireAuth";
import { stripe, stripePriceId } from "../services/stripe";
import { logAppError } from "../models/AppError";

const router = Router();

// POST /api/checkout/create-session
//
// Creates a Stripe Checkout Session in embedded mode for the authenticated
// user. The returned clientSecret is consumed by the frontend's
// <EmbeddedCheckoutProvider/>. client_reference_id is set to the auth.sub so
// the eventual /api/situation/build call can verify the payer matches.
router.post("/create-session", requireAuth, async (req: Request, res: Response) => {
  console.log(`[POST /api/checkout/create-session] ${authTag(req)} | Creating session`);

  try {
    const userId = req.auth!.sub;
    const session = await stripe().checkout.sessions.create({
      ui_mode: "embedded",
      mode: "payment",
      line_items: [{ price: stripePriceId(), quantity: 1 }],
      client_reference_id: userId,
      redirect_on_completion: "never",
    });

    res.json({ sessionId: session.id, clientSecret: session.client_secret });
  } catch (err) {
    console.error(`[POST /api/checkout/create-session] ${authTag(req)} | 500`, err);
    logAppError({
      err,
      service: "POST /api/checkout/create-session",
      request: req,
      errorType: "payment",
    });
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

// GET /api/checkout/session/:id — status poll (for the rare retry case)
router.get("/session/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const session = await stripe().checkout.sessions.retrieve(req.params.id);
    if (session.client_reference_id !== req.auth!.sub) {
      res.status(403).json({ error: "Session does not belong to this user." });
      return;
    }
    res.json({
      sessionId: session.id,
      paymentStatus: session.payment_status,
      status: session.status,
    });
  } catch (err) {
    console.error("[GET /api/checkout/session]", err);
    logAppError({
      err,
      service: "GET /api/checkout/session/:id",
      request: req,
      errorType: "payment",
    });
    res.status(404).json({ error: "Session not found." });
  }
});

export default router;
