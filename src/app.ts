import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./lib/db";
import { requireAuth, requireAdmin } from "./middleware/requireAuth";
import { generalLimiter, inferenceLimiter } from "./middleware/rateLimit";
import { requireSpendBudget } from "./lib/spendCap";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { mcpRouter, mcpResourceUrl, requireMcpToken } from "./mcp/server";
import { mcpOAuthProvider, googleCallbackRouter, publicBaseUrl, MCP_SCOPE } from "./mcp/oauthProvider";

// Route modules
import formMapRoutes from "./routes/formMap";
import formContextRoutes from "./routes/formContext";
import situationalContextRoutes from "./routes/situationalContext";
import filledFormMapRoutes from "./routes/filledFormMap";
import formFillRoutes from "./routes/formFill";
import pipelineRoutes from "./routes/pipeline";
import pdfRoutes from "./routes/pdf";
import checkoutRoutes from "./routes/checkout";
import step1InputRoutes from "./routes/step1Input";
import landingEventRoutes from "./routes/landingEvent";
import leadCaptureRoutes from "./routes/leadCapture";

const app = express();

// Number of reverse-proxy hops in front of the app (DigitalOcean App Platform),
// so req.ip — used by the rate limiters — is the client, not the load balancer.
app.set("trust proxy", parseInt(process.env.TRUST_PROXY ?? "1", 10));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
// Also JSON-parse text/plain bodies so navigator.sendBeacon — which must use
// a CORS-safelisted content type to avoid Safari dropping the preflight on
// page unload — still arrives as a parsed object.
app.use(
  express.json({
    limit: "10mb",
    type: ["application/json", "text/plain"],
  })
);
app.use(express.urlencoded({ extended: true }));

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ─── MCP (Streamable HTTP) ───────────────────────────────────────────────────
// OAuth 2.1 for MCP clients: discovery metadata, dynamic client registration,
// /authorize, /token, /revoke (the SDK rate-limits these itself), plus the
// Google sign-in callback. Must be mounted at the app root.
app.use(
  mcpAuthRouter({
    provider: mcpOAuthProvider,
    issuerUrl: publicBaseUrl(),
    resourceServerUrl: mcpResourceUrl(),
    scopesSupported: [MCP_SCOPE],
    resourceName: "Form Agent Pro",
  })
);
app.use(googleCallbackRouter);
// Remote MCP endpoint for AI agents: signed-in callers only, rate-limited.
app.use("/mcp", generalLimiter, requireMcpToken, mcpRouter);

// ─── API routes ───────────────────────────────────────────────────────────────
//
// Every /api route is rate-limited per IP. Routers that call the model also
// get inferenceLimiter + requireSpendBudget (both skip GETs), mounted before
// the route handlers so a blocked request never consumes a Stripe payment.
app.use("/api", generalLimiter);
const modelGuards = [inferenceLimiter, requireSpendBudget];
//
// Form Setup (once per form) — admin-only: expensive and not part of the user flow
app.use("/api/form-map", requireAuth, requireAdmin, formMapRoutes);         // build FormMap from blank PDF
app.use("/api/form-context", requireAuth, requireAdmin, ...modelGuards, formContextRoutes); // build FormContext via Anthropic
//
// User Workflow (once per user)
app.use("/api/situation", ...modelGuards, situationalContextRoutes); // build SituationalContext
//
// Convergence + Execution (once per form × user)
app.use("/api/filled-map", ...modelGuards, filledFormMapRoutes); // fill the field map via Anthropic
app.use("/api/form-fill", requireAuth, requireAdmin, formFillRoutes); // fill PDF + extract aux helper (admin-only)
//
// End-to-end pipeline (situation → filled PDFs in one call)
app.use("/api/pipeline", ...modelGuards, pipelineRoutes); // POST /api/pipeline/run
//
// PDF download (on-demand generation + streaming)
app.use("/api/pdf", pdfRoutes);                  // GET /api/pdf/form/:id, /merged/:id
//
// Stripe Checkout (payment gate for /api/situation/build)
app.use("/api/checkout", checkoutRoutes);
//
// Step 1 text-capture (debounced writes from the /fill first text input)
app.use("/api/step1-input", step1InputRoutes);
//
// Landing-page CTA click tracking
app.use("/api/landing-event", landingEventRoutes);
//
// Landing-page lead-magnet email capture (inline, sticky, exit-intent)
app.use("/api/lead-capture", leadCaptureRoutes);

// ─── 404 fallback ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3001", 10);

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[server] immi-server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[server] Failed to connect to MongoDB:", err);
    process.exit(1);
  });

export default app;
