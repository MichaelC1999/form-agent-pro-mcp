import StripeCtor from "stripe";
import { PaidSession } from "../models/PaidSession";

type StripeClient = InstanceType<typeof StripeCtor>;

let _client: StripeClient | null = null;

export function stripe(): StripeClient {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  _client = new StripeCtor(key);
  return _client;
}

export function stripePriceId(): string {
  const id = process.env.STRIPE_PRICE_ID;
  if (!id) {
    throw new Error("STRIPE_PRICE_ID is not set");
  }
  return id;
}

/**
 * Creates a Stripe-hosted Checkout Session (a payment link the user opens in
 * a browser). Used by MCP clients, which can't render the web app's embedded
 * checkout. client_reference_id ties the payment to the user, the same as
 * the web flow, so assertSessionPaid works unchanged.
 */
export async function createHostedCheckoutSession(
  userId: string,
  successUrl: string
): Promise<{ sessionId: string; url: string }> {
  const session = await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price: stripePriceId(), quantity: 1 }],
    client_reference_id: userId,
    success_url: successUrl,
  });
  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { sessionId: session.id, url: session.url };
}

export interface AssertPaidResult {
  ok: boolean;
  status: number;
  error?: string;
}

/**
 * Verifies that the given Stripe Checkout Session is paid, belongs to userId,
 * and has not already been consumed. On success, records consumption so the
 * session cannot be replayed for a second submission.
 *
 * The same code path runs locally and in production — Stripe test-mode keys
 * drive the test environment, live keys drive prod.
 */
export async function assertSessionPaid(
  sessionId: string | undefined,
  userId: string
): Promise<AssertPaidResult> {
  if (!sessionId) {
    return { ok: false, status: 402, error: "Payment required." };
  }

  let session: Awaited<ReturnType<StripeClient["checkout"]["sessions"]["retrieve"]>>;
  try {
    session = await stripe().checkout.sessions.retrieve(sessionId);
  } catch (err) {
    console.error("[stripe] Failed to retrieve session", sessionId, err);
    return { ok: false, status: 402, error: "Payment session not found." };
  }

  if (session.payment_status !== "paid") {
    return { ok: false, status: 402, error: "Payment not completed." };
  }

  if (session.client_reference_id !== userId) {
    return { ok: false, status: 403, error: "Payment session does not belong to this user." };
  }

  try {
    await PaidSession.create({ sessionId, userId });
  } catch (err: unknown) {
    if (err && typeof err === "object" && (err as { code?: number }).code === 11000) {
      return { ok: false, status: 409, error: "Payment session already used." };
    }
    throw err;
  }

  return { ok: true, status: 200 };
}
