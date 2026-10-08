import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execSync, spawnSync } from "child_process";
import {
  PDFDocument, PDFName, PDFArray, PDFRef, PDFDict, PDFString, PDFHexString,
  type PDFContext, type PDFObject,
} from "pdf-lib";
import { FormMap } from "../models/FormMap";
import { readFieldMeta } from "../lib/pdf";
import type { BuildFormMapInput, IFormMap, FieldMap, FieldMeta } from "../types";

// ─── Tool availability ────────────────────────────────────────────────────────

function isPdftkAvailable(): boolean {
  try {
    execSync("pdftk --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function isQpdfAvailable(): boolean {
  try {
    execSync("qpdf --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─── Extraction strategies ────────────────────────────────────────────────────

/**
 * Strategy 1 — pdftk dump_data_fields
 *
 * Reads the AcroForm /Fields hierarchy via pdftk. Reliable for forms where
 * all fields are registered in /Fields. Returns XFA-style fully-qualified
 * field names. Note: misses orphaned widget annotations (see Strategy 2).
 */
function extractWithPdftk(pdfPath: string): { fields: FieldMap; raw: string } | null {
  const result = spawnSync("pdftk", [pdfPath, "dump_data_fields"], { encoding: "utf-8" });
  if (result.status !== 0 || !result.stdout.trim()) return null;

  const fields: FieldMap = {};
  const fieldMatches = result.stdout.matchAll(/^FieldName: (.+)$/gm);
  for (const match of fieldMatches) {
    fields[match[1].trim()] = "";
  }

  return Object.keys(fields).length > 0 ? { fields, raw: result.stdout } : null;
}

/**
 * Strategy 2 — pdf-lib page annotation walk
 *
 * Walks every page's /Annots array and collects Widget annotations that carry
 * a /T (field name) value, recording each under its fully-qualified name (see
 * getQualifiedFieldName). This catches "orphaned widgets" — form fields that
 * exist as page annotations but are NOT registered in the AcroForm /Fields
 * hierarchy. Several current USCIS forms (e.g. I-485) use this pattern:
 * pdftk dump_data_fields sees only the ~13 AcroForm-registered entries while
 * the form actually has 700+ widget annotations spread across pages.
 *
 * Barcode fields (PDF417 etc.) are excluded because they encode page data
 * automatically and are never user-fillable.
 */
const BARCODE_RE = /barcode/i;

/**
 * Decode a raw PDF string value as returned by PDFString.asString().
 *
 * PDFString.asString() returns the raw bytes of the PDF string object —
 * it does NOT perform charset conversion. USCIS forms store field names as
 * UTF-16 BE (PDF spec §7.9.2): two-byte BOM (0xFE 0xFF) followed by 16-bit
 * big-endian code units. JavaScript sees the BOM as chars 'þÿ' and each
 * null byte between ASCII characters as a space.
 *
 * This function detects the BOM and decodes accordingly, returning a clean
 * Unicode string in either case.
 */
function decodePdfString(raw: string): string {
  if (raw.charCodeAt(0) === 0xFE && raw.charCodeAt(1) === 0xFF) {
    // UTF-16 BE: skip 2-byte BOM, read pairs of bytes
    let decoded = "";
    for (let j = 2; j + 1 < raw.length; j += 2) {
      decoded += String.fromCharCode((raw.charCodeAt(j) << 8) | raw.charCodeAt(j + 1));
    }
    return decoded;
  }
  return raw;
}

/** Decodes one /T value (a single segment of a field name) to a plain string. */
function readPartialName(tVal: PDFObject): string {
  if (tVal instanceof PDFHexString) return tVal.decodeText();
  const raw = tVal instanceof PDFString
    ? tVal.asString()
    : tVal.toString().replace(/^\(|\)$/g, "");
  return decodePdfString(raw);
}

/**
 * Builds a widget's fully-qualified field name by walking its /Parent chain
 * and joining each /T segment with "." — the same name pdftk, pdf-lib, and
 * the PDF filler use (e.g. "form1[0].Page1[0].Line1a_FamilyName[0]").
 *
 * A widget's own /T is only the last segment of that name. Current USCIS
 * editions nest every field under form1[0] → PageN[0], so reading the widget's
 * /T alone yields "Line1a_FamilyName[0]" — a name no other strategy reports
 * and nothing downstream can fill.
 */
function getQualifiedFieldName(widget: PDFDict, context: PDFContext): string {
  const parts: string[] = [];
  const seen = new Set<PDFDict>();
  let node: PDFDict | undefined = widget;

  while (node && !seen.has(node)) {
    seen.add(node);
    const tVal = node.get(PDFName.of("T"));
    if (tVal) parts.unshift(readPartialName(tVal));

    const parentVal: PDFObject | undefined = node.get(PDFName.of("Parent"));
    const parent: PDFObject | undefined =
      parentVal instanceof PDFRef ? context.lookup(parentVal) : parentVal;
    node = parent instanceof PDFDict ? parent : undefined;
  }

  return parts.join(".");
}

async function extractWithPageAnnotations(pdfPath: string): Promise<FieldMap | null> {
  try {
    const bytes = fs.readFileSync(pdfPath);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const context = doc.context;
    const pages = doc.getPages();

    const fields: FieldMap = {};

    for (const page of pages) {
      const annotsVal = page.node.get(PDFName.of("Annots"));
      if (!annotsVal) continue;

      let annotsArr: PDFArray | undefined;
      if (annotsVal instanceof PDFRef) {
        const resolved = context.lookup(annotsVal);
        if (resolved instanceof PDFArray) annotsArr = resolved;
      } else if (annotsVal instanceof PDFArray) {
        annotsArr = annotsVal;
      }
      if (!annotsArr) continue;

      for (let i = 0; i < annotsArr.size(); i++) {
        const annotRef = annotsArr.get(i);

        let annotDict: PDFDict | undefined;
        if (annotRef instanceof PDFRef) {
          const resolved = context.lookup(annotRef);
          if (resolved instanceof PDFDict) annotDict = resolved;
        } else if (annotRef instanceof PDFDict) {
          annotDict = annotRef;
        }
        if (!annotDict) continue;

        // Only Widget annotations
        const subtype = annotDict.get(PDFName.of("Subtype"));
        if (!subtype || subtype.toString() !== "/Widget") continue;

        // /T holds the widget's own name segment; the full name comes from
        // its /Parent chain
        if (!annotDict.get(PDFName.of("T"))) continue;

        const name = getQualifiedFieldName(annotDict, context);

        if (name && !BARCODE_RE.test(name)) {
          fields[name] = "";
        }
      }
    }

    return Object.keys(fields).length > 0 ? fields : null;
  } catch {
    return null;
  }
}

/**
 * Strategy 3 — pdf-lib AcroForm reader
 *
 * Works well for standard AcroForm PDFs where all fields are properly
 * registered in the /Fields hierarchy.
 */
async function extractWithPdfLib(pdfPath: string): Promise<FieldMap | null> {
  try {
    const bytes = fs.readFileSync(pdfPath);
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const pdfFields = form.getFields();
    if (pdfFields.length === 0) return null;

    const fields: FieldMap = {};
    for (const f of pdfFields) {
      fields[f.getName()] = "";
    }
    return fields;
  } catch {
    return null;
  }
}

/**
 * Strategy 4 — qpdf stream decompress + regex scan
 *
 * Last-resort for PDFs where page-annots, pdftk, and pdf-lib all yield zero fields.
 * Decompresses all streams with qpdf and scans for /T (fieldName) patterns
 * directly in the raw PDF content.
 */
async function extractWithQpdf(pdfPath: string): Promise<FieldMap | null> {
  if (!isQpdfAvailable()) return null;

  const tmpPath = path.join(
    os.tmpdir(),
    `immi-qpdf-${Date.now()}.pdf`
  );

  try {
    const result = spawnSync(
      "qpdf",
      ["--qdf", "--object-streams=disable", pdfPath, tmpPath],
      { encoding: "utf-8" }
    );
    if (result.status !== 0 || !fs.existsSync(tmpPath)) return null;

    const raw = fs.readFileSync(tmpPath, "utf-8");

    // Match /T (fieldName) patterns — covers most AcroForm field declarations
    const fields: FieldMap = {};
    const tMatches = raw.matchAll(/\/T\s*\(([^)]+)\)/g);
    for (const match of tMatches) {
      const name = match[1].trim();
      if (name) fields[name] = "";
    }

    return Object.keys(fields).length > 0 ? fields : null;
  } finally {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    }
  }
}

/**
 * Strategy 5 — raw binary regex scan (no external tools)
 *
 * Absolute fallback. Reads the PDF buffer as a latin-1 string and searches
 * for /T field patterns. Less reliable than the above but requires nothing
 * beyond Node.js.
 */
function extractWithRawScan(pdfPath: string): FieldMap | null {
  try {
    // Read as latin1 to avoid buffer corruption on binary content
    const raw = fs.readFileSync(pdfPath).toString("latin1");
    const fields: FieldMap = {};

    const tMatches = raw.matchAll(/\/T\s*\(([^)]{1,200})\)/g);
    for (const match of tMatches) {
      // Basic unescape for backslash-encoded parens
      const name = match[1].replace(/\\([()\\])/g, "$1").trim();
      if (name && !name.includes("\x00")) fields[name] = "";
    }

    return Object.keys(fields).length > 0 ? fields : null;
  } catch {
    return null;
  }
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Run all extraction strategies and merge the results.
 *
 * The "stop at first success" approach fails for USCIS forms like I-485 where
 * pdftk finds only the 13 AcroForm-registered entries while the form actually
 * has 700+ widget annotations on individual pages. Running all strategies and
 * unioning the results ensures we never under-count fields regardless of how
 * the PDF was authored.
 *
 * Pre-processing:
 *   If the PDF has an owner password (but an empty user password, as many USCIS
 *   forms do), pdf-lib's ignoreEncryption:true flag bypasses the error but does
 *   NOT decrypt the string values — /T field names in page Widget annotations
 *   come back as binary garbage. We run `qpdf --decrypt` first (if available)
 *   to produce a plaintext copy, which all strategies below then receive.
 *
 * Strategy run order (all attempted):
 *   1. page-annots — pdf-lib page annotation walk (catches orphaned widgets)
 *   2. pdftk       — AcroForm hierarchy via dump_data_fields
 *   3. pdf-lib     — AcroForm reader
 *   4. qpdf        — decompressed /T scan (only if 1–3 all return nothing)
 *   5. raw-scan    — binary /T scan         (only if 1–3 all return nothing)
 *
 * The strategy label in the result lists all contributors and their counts.
 */
async function extractFields(
  pdfPath: string
): Promise<{ fields: FieldMap; strategy: string }> {
  // ── Pre-processing: decrypt if the PDF has an owner password ──────────────
  // PDFs with an owner password (but empty user password — e.g. USCIS I-485)
  // store Widget /T field names in encrypted form. pdf-lib's ignoreEncryption
  // flag bypasses the error but does NOT decrypt the bytes, so field names come
  // back as binary garbage. We use pdftk `output` to write a plaintext copy
  // first (pdftk handles the empty user password automatically), then run all
  // extraction strategies on that decrypted copy.
  let workingPath = pdfPath;
  let tmpDecryptedPath: string | null = null;

  if (isPdftkAvailable()) {
    const tmpPath = path.join(os.tmpdir(), `immi-decrypt-${Date.now()}.pdf`);
    const decryptResult = spawnSync(
      "pdftk",
      [pdfPath, "output", tmpPath],
      { encoding: "utf-8" }
    );
    if (decryptResult.status === 0 && fs.existsSync(tmpPath)) {
      workingPath = tmpPath;
      tmpDecryptedPath = tmpPath;
    }
  } else if (isQpdfAvailable()) {
    const tmpPath = path.join(os.tmpdir(), `immi-decrypt-${Date.now()}.pdf`);
    const decryptResult = spawnSync(
      "qpdf",
      ["--decrypt", pdfPath, tmpPath],
      { encoding: "utf-8" }
    );
    if (decryptResult.status === 0 && fs.existsSync(tmpPath)) {
      workingPath = tmpPath;
      tmpDecryptedPath = tmpPath;
    }
  }

  const merged: FieldMap = {};
  const contributors: string[] = [];

  try {
    // 1. Page annotation walk — catches orphaned widgets
    const pageAnnot = await extractWithPageAnnotations(workingPath);
    if (pageAnnot) {
      const n = Object.keys(pageAnnot).length;
      Object.assign(merged, pageAnnot);
      contributors.push(`page-annots(${n})`);
    }

    // 2. pdftk dump_data_fields
    if (isPdftkAvailable()) {
      const pdftk = extractWithPdftk(workingPath);
      if (pdftk) {
        const before = Object.keys(merged).length;
        Object.assign(merged, pdftk.fields);
        const added = Object.keys(merged).length - before;
        contributors.push(`pdftk(${Object.keys(pdftk.fields).length}${added > 0 ? `,+${added} new` : ""})`);
      }
    }

    // 3. pdf-lib AcroForm reader
    const pdfLib = await extractWithPdfLib(workingPath);
    if (pdfLib) {
      const before = Object.keys(merged).length;
      Object.assign(merged, pdfLib);
      const added = Object.keys(merged).length - before;
      contributors.push(`pdf-lib(${Object.keys(pdfLib).length}${added > 0 ? `,+${added} new` : ""})`);
    }

    if (Object.keys(merged).length > 0) {
      return { fields: merged, strategy: contributors.join(" + ") };
    }

    // 4 & 5 — last-resort fallbacks (only reached if all three above found nothing)
    const qpdf = await extractWithQpdf(workingPath);
    if (qpdf) return { fields: qpdf, strategy: "qpdf" };

    const raw = extractWithRawScan(workingPath);
    if (raw) return { fields: raw, strategy: "raw-scan" };

    throw new Error(
      `Could not extract any fields from PDF at "${pdfPath}". ` +
      `Tried: page-annots, pdftk${isPdftkAvailable() ? "" : " (not installed)"}, ` +
      `pdf-lib, qpdf${isQpdfAvailable() ? "" : " (not installed)"}, raw-scan.`
    );
  } finally {
    if (tmpDecryptedPath) {
      try { fs.unlinkSync(tmpDecryptedPath); } catch { /* ignore cleanup failure */ }
    }
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface BuildFormMapResult extends IFormMap {
  strategy: string;       // which extraction method succeeded
  fieldCount: number;     // total number of fields found
}

/**
 * buildFormMap
 *
 * Given a form ID and a path to a blank PDF, extracts all fillable field IDs
 * and saves an empty FormMap to MongoDB. Tries four extraction strategies in
 * order: pdftk → pdf-lib → qpdf → raw binary scan.
 *
 * Can be called directly as a library function or wrapped by a CLI / HTTP route.
 */
export async function buildFormMap(
  input: BuildFormMapInput
): Promise<BuildFormMapResult> {
  const { formId, formPdfPath, version = "1.0" } = input;

  if (!fs.existsSync(formPdfPath)) {
    throw new Error(`PDF not found: ${formPdfPath}`);
  }

  const { fields, strategy } = await extractFields(formPdfPath);
  const fieldCount = Object.keys(fields).length;

  // Input constraints (checkbox / max length / dropdown options) for the
  // fields in this map — fillFormMap uses them to prompt for and validate values
  const allMeta = readFieldMeta(formPdfPath);
  const fieldMeta: Record<string, FieldMeta> = {};
  for (const id of Object.keys(fields)) {
    if (allMeta[id]) fieldMeta[id] = allMeta[id];
  }

  const doc = await FormMap.create({
    formId,
    version,
    createdAt: new Date(),
    fields,
    ...(Object.keys(fieldMeta).length > 0 ? { fieldMeta } : {}),
  });

  const saved = doc.toObject() as IFormMap;
  return { ...saved, strategy, fieldCount };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * Allows direct CLI execution:
 *   npx ts-node src/services/buildFormMap.ts <formId> <pdfPath> [version]
 *
 * Requires MONGODB_URI in the environment.
 */
if (require.main === module) {
  (async () => {
    // Load .env before anything else so MONGODB_URI etc. are available
    const dotenv = await import("dotenv");
    dotenv.config();

    const [, , formId, formPdfPath, version] = process.argv;

    if (!formId || !formPdfPath) {
      console.error("Usage: ts-node buildFormMap.ts <formId> <pdfPath> [version]");
      process.exit(1);
    }

    // Lazy-connect to MongoDB only when running as CLI
    const { connectDB } = await import("../lib/db");
    await connectDB();

    try {
      const result = await buildFormMap({ formId, formPdfPath, version });
      console.log(`\n✅ FormMap saved for "${result.formId}" (v${result.version})`);
      console.log(`   Strategy : ${result.strategy}`);
      console.log(`   Fields   : ${result.fieldCount}`);
      console.log(`   Metadata : ${Object.keys(result.fieldMeta ?? {}).length} fields`);
      console.log(`   MongoDB _id: ${(result as any)._id}\n`);
      process.exit(0);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  })();
}
