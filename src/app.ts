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

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "10mb" }));
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
