import * as path from "path";
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

/** Shown to the user with prepared forms (directory policy: direct disclosure for legal use cases). */
export const USER_REVIEW_NOTICE =
  "These forms are prepared for you to review, sign and file yourself. This is not legal advice, " +
  "and nothing has been submitted to USCIS or any government.";

/** Public pages MCP users land on outside their AI app. */
export const mcpPublicRouter = Router();

// ─── Brand icons ─────────────────────────────────────────────────────────────
// The formagent.pro logo (assets/brand, rendered from logo-profile.svg).
// Advertised in the MCP serverInfo and server.json, and served as the
// favicon so clients that look up the server's favicon find it too.
const BRAND_DIR = path.resolve(__dirname, "../../assets/brand");

/** Icon files served at the site root: URL path → file + type. */
const BRAND_ICONS: Record<string, { file: string; type: string }> = {
  "/favicon.ico": { file: "icon-48.png", type: "image/png" },
  "/icon.png": { file: "icon-512.png", type: "image/png" },
  "/icon-192.png": { file: "icon-192.png", type: "image/png" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

for (const [urlPath, { file, type }] of Object.entries(BRAND_ICONS)) {
  mcpPublicRouter.get(urlPath, (_req, res) => {
    res.type(type).set("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(BRAND_DIR, file));
  });
}

/** Icons in MCP format, as absolute URLs on this server. */
export function mcpIcons(baseUrl: URL): Array<{ src: string; mimeType: string; sizes: string[] }> {
  return [
    { src: new URL("/icon.png", baseUrl).toString(), mimeType: "image/png", sizes: ["512x512"] },
    { src: new URL("/icon-192.png", baseUrl).toString(), mimeType: "image/png", sizes: ["192x192"] },
    { src: new URL("/icon.svg", baseUrl).toString(), mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

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
