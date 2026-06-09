import { Router, Request, Response } from "express";
import { Step1Input } from "../models/Step1Input";

const router = Router();

// POST /api/step1-input
// Body: { text: string, sessionId?: string }
// Creates a new Step1Input document and returns its id.
router.post("/", async (req: Request, res: Response) => {
  try {
    const { text, sessionId } = req.body as { text?: string; sessionId?: string };
    if (typeof text !== "string" || text.length === 0) {
      res.status(400).json({ error: "text is required" });
      return;
    }
    if (text.length > 10000) {
      res.status(413).json({ error: "text exceeds 10,000 character limit" });
      return;
    }
    const doc = await Step1Input.create({
      text,
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined,
    });
    res.status(201).json({ _id: doc._id, createdAt: doc.createdAt });
  } catch (err) {
    console.error("[POST /api/step1-input]", err);
    res.status(500).json({ error: "Failed to save Step1Input" });
  }
});

export default router;
