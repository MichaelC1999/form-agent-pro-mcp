import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectDB } from "./lib/db";

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

// ─── API routes ───────────────────────────────────────────────────────────────
//
// Form Setup (once per form)
app.use("/api/form-map", formMapRoutes);         // build FormMap from blank PDF
app.use("/api/form-context", formContextRoutes); // build FormContext via Anthropic
//
// User Workflow (once per user)
app.use("/api/situation", situationalContextRoutes); // build SituationalContext
//
// Convergence + Execution (once per form × user)
app.use("/api/filled-map", filledFormMapRoutes); // fill the field map via Anthropic
app.use("/api/form-fill", formFillRoutes);       // fill PDF + extract aux helper
//
// End-to-end pipeline (situation → filled PDFs in one call)
app.use("/api/pipeline", pipelineRoutes);        // POST /api/pipeline/run
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
