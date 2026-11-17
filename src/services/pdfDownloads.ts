import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Response } from "express";
import { PDFDocument } from "pdf-lib";
import { fillForm } from "./fillForm";
import { FilledFormMap } from "../models/FilledFormMap";
import { normalizeRequiredForms } from "../types";
import type { RequiredFormsStored } from "../types";
import { getBlankPdfPath, resolveProcessId } from "../lib/processes";

/**
 * PDF generation shared by the web download routes (/api/pdf) and the MCP
 * download links. PDFs are generated on demand into temp files and deleted
 * after streaming.
 */

/** Generate a filled PDF for a FilledFormMap and return the output path. */
export async function generatePdf(
  filledFormMapId: string,
  formId: string,
  userId: string,
  processId: string
): Promise<string> {
  const blankPath = getBlankPdfPath(processId, formId);
  if (!fs.existsSync(blankPath)) {
    throw new Error(`Blank PDF not found for form "${formId}" in process "${processId}".`);
  }

  const tmpDir = path.join(os.tmpdir(), `pdf-${filledFormMapId}-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const result = await fillForm({
    formId,
    userId,
    filledFormMapId,
    formPdfPath: blankPath,
    outputDir: tmpDir,
  });

  if (!result.success) {
    throw new Error(`PDF generation failed for "${formId}": ${result.errors.join("; ")}`);
  }

  return result.outputPath;
}

/** Stream a PDF file as a download response, then delete the temp file. */
export function streamPdfAndCleanup(res: Response, filePath: string, filename: string): void {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", fs.statSync(filePath).size);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
  stream.on("end", () => {
    try {
      fs.unlinkSync(filePath);
      fs.rmdirSync(path.dirname(filePath), { recursive: true } as any);
    } catch {
      // Best-effort cleanup
    }
  });
}

/** Minimal FilledFormMap shape the download code needs. */
export interface MapForPdf {
  _id: unknown;
  formId: string;
  beneficiaryKey?: string;
  processId?: string;
  createdAt: Date;
}

/**
 * The FilledFormMaps that belong to a situation's required forms.
 *
 * FilledFormMaps aren't linked to a SituationalContext by ID, so this takes
 * the user's latest map per (formId, beneficiaryKey). With `onlyAfter`,
 * maps created before that time are ignored, so an older submission's forms
 * can't show through on a newer situation.
 */
export async function selectMapsForContext(
  userId: string,
  requiredForms: RequiredFormsStored | undefined | null,
  opts: { onlyAfter?: Date } = {}
): Promise<MapForPdf[]> {
  const query: Record<string, unknown> = { userId };
  if (opts.onlyAfter) query.createdAt = { $gte: opts.onlyAfter };
  const allMaps = (await FilledFormMap.find(query)
    .sort({ createdAt: -1 })
    .select({ formId: 1, beneficiaryKey: 1, processId: 1, createdAt: 1 })
    .lean()) as unknown as MapForPdf[];

  // Deduplicate by (formId, beneficiaryKey). The key encodes both so a
  // multi-beneficiary submission keeps a distinct fill per beneficiary.
  const dedupKey = (formId: string, beneficiaryKey: string | undefined): string =>
    `${formId}::${beneficiaryKey ?? ""}`;
  const latestPerEntry = new Map<string, MapForPdf>();
  for (const m of allMaps) {
    const k = dedupKey(m.formId, m.beneficiaryKey);
    if (!latestPerEntry.has(k)) latestPerEntry.set(k, m);
  }

  return normalizeRequiredForms(requiredForms)
    .map((e) => latestPerEntry.get(dedupKey(e.formId, e.beneficiaryKey)))
    .filter((m): m is MapForPdf => Boolean(m));
}

/**
 * Generates each map's PDF and merges them into one file. Forms that fail to
 * generate are skipped and reported through `onSkip`. Returns the merged
 * file path, or null if no form could be generated.
 */
export async function buildMergedPdf(
  maps: MapForPdf[],
  userId: string,
  contextProcessId: string | undefined,
  onSkip: (formId: string, err: unknown) => void
): Promise<string | null> {
  const ctxProcessId = resolveProcessId(contextProcessId);
  const pdfPaths: string[] = [];
  for (const m of maps) {
    try {
      pdfPaths.push(await generatePdf(String(m._id), m.formId, userId, resolveProcessId(m.processId ?? ctxProcessId)));
    } catch (err) {
      onSkip(m.formId, err);
    }
  }
  if (pdfPaths.length === 0) return null;

  // Merge all PDFs using pdf-lib
  const mergedPdf = await PDFDocument.create();
  for (const pdfPath of pdfPaths) {
    const donor = await PDFDocument.load(fs.readFileSync(pdfPath));
    const copiedPages = await mergedPdf.copyPages(donor, donor.getPageIndices());
    for (const page of copiedPages) mergedPdf.addPage(page);
  }
  const mergedBytes = await mergedPdf.save();

  const tmpMergedPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "merged-")), "merged.pdf");
  fs.writeFileSync(tmpMergedPath, mergedBytes);

  // Clean up individual temp PDFs
  for (const p of pdfPaths) {
    try {
      fs.unlinkSync(p);
      fs.rmdirSync(path.dirname(p), { recursive: true } as any);
    } catch {
      // Best-effort
    }
  }
  return tmpMergedPath;
}
