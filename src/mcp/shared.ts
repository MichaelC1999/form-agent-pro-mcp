import { Router } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/** Where Stripe sends MCP users after they pay (no app page to return to). */
export const CHECKOUT_COMPLETE_PATH = "/checkout/complete";

/** The signed-in user behind an MCP tool call, from the access token. */
export function mcpCaller(authInfo: AuthInfo | undefined): { userId: string; email?: string } | null {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string" || userId === "") return null;
  const email = typeof authInfo?.extra?.email === "string" ? authInfo.extra.email : undefined;
  return { userId, email };
}

/** Public pages MCP users land on outside their AI app. */
export const mcpPublicRouter = Router();

mcpPublicRouter.get(CHECKOUT_COMPLETE_PATH, (_req, res) => {
  res
    .type("html")
    .send(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
        "<title>Payment received</title>" +
        "<body style='font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem'>" +
        "<h1>Payment received</h1><p>Go back to your AI app and tell it you've paid. " +
        "It will start preparing your forms.</p></body>"
    );
});
