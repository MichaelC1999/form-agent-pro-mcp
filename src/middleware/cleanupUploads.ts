import * as fs from "fs";
import type { Request, Response, NextFunction } from "express";

/**
 * Uploaded documents (passports, certificates, …) land in the OS temp dir via
 * multer. Only their extracted text is kept (in MongoDB); the original files
 * must not linger on disk.
 */

/** Best-effort delete of temp files. Never throws. */
export function deleteTempFiles(paths: Array<string | undefined>): void {
  for (const p of paths) {
    if (!p) continue;
    try {
      fs.unlinkSync(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[cleanupUploads] Failed to delete temp file ${p}:`, err);
      }
    }
  }
}

function uploadedPaths(req: Request): string[] {
  const files = req.files;
  const list = Array.isArray(files) ? files : files ? Object.values(files).flat() : [];
  return [...list.map((f) => f.path), ...(req.file ? [req.file.path] : [])];
}

/**
 * Deletes this request's multer uploads once the response is finished —
 * on success and on every early return (400/402/403/…).
 *
 * A handler that hands the files to background work sets
 * `res.locals.keepUploads = true`; that background work must then delete
 * them itself (see startSituationBuild).
 */
export function cleanupUploadsOnFinish(req: Request, res: Response, next: NextFunction): void {
  res.on("close", () => {
    if (res.locals.keepUploads) return;
    deleteTempFiles(uploadedPaths(req));
  });
  next();
}
