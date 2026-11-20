/**
 * Test mode: accounts listed in PAYMENT_EXEMPT_EMAILS (comma-separated) skip
 * the Stripe step in the MCP flow. Spend caps and rate limits still apply.
 *
 * The email must come from a verified Google sign-in (never from tool input).
 * Fails closed: unset or empty means nobody is exempt.
 */
export function isPaymentExempt(verifiedEmail: string | undefined): boolean {
  if (!verifiedEmail) return false;
  const exempt = (process.env.PAYMENT_EXEMPT_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return exempt.includes(verifiedEmail.trim().toLowerCase());
}
