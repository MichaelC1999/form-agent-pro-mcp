import { Router, Request, Response } from "express";
import multer from "multer";
import * as os from "os";
import { buildSituationContext } from "../services/buildSituationContext";
import { SituationalContext } from "../models/SituationalContext";

const router = Router();
const upload = multer({ dest: os.tmpdir() });

function serverError(res: Response, err: unknown): void {
  console.error("[situationalContext]", err);
  res.status(500).json({ error: "An internal error occurred. Please try again." });
}

// POST /api/situation/build
router.post("/build", upload.array("documents", 20), async (req: Request, res: Response) => {
  try {
    const { userId, situationDescription, processDescription, additionalNotes } = req.body as {
      userId?: string;
      situationDescription?: string;
      processDescription?: string;
      additionalNotes?: string;
    };

    if (!userId) {
      res.status(400).json({ error: "userId is required" });
      return;
    }
    if (!situationDescription) {
      res.status(400).json({ error: "situationDescription is required" });
      return;
    }
    if (!processDescription) {
      res.status(400).json({ error: "processDescription is required" });
      return;
    }

    const uploadedFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

    const result = await buildSituationContext({
      userId,
      uiAnswers: {
        situationDescription,
        processDescription,
        additionalNotes,
      },
      uploadedFiles: uploadedFiles.map((f) => ({
        path: f.path,
        originalname: f.originalname,
        mimetype: f.mimetype,
      })),
    });

    res.status(201).json(result);
  } catch (err) {
    serverError(res, err);
  }
});

// GET /api/situation/user/:userId
router.get("/user/:userId", async (req: Request, res: Response) => {
  try {
    const docs = await SituationalContext.find({ userId: req.params.userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json(docs);
  } catch (err) {
    serverError(res, err);
  }
});

// GET /api/situation/:id
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const doc = await SituationalContext.findById(req.params.id);
    if (!doc) {
      res.status(404).json({ error: "Not found." });
      return;
    }
    res.json(doc.toObject());
  } catch (err) {
    serverError(res, err);
  }
});

export default router;
