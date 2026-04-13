import * as fs from "fs";
import * as path from "path";
import { FilledFormMap } from "../models/FilledFormMap";
import { fillPdfWithPdftk } from "../lib/pdf";
import type { FillFormInput, FillFormOutput, FormType, FieldMap } from "../types";

// ─── Text sanitizer ───────────────────────────────────────────────────────────

/**
 * Light sanitization applied to every text-field value before it reaches the
 * PDF layer.
 *
 * NFC (Canonical Decomposition, followed by Canonical Composition) normalises
 * decomposed Unicode sequences — e.g. the two-codepoint form "a" + U+0303
 * (combining tilde) — into their single precomposed codepoint ("ã").
 * Precomposed form is what most PDF fonts index by codepoint and is the
 * canonical shape expected when encoding as UTF-16 BE in FDF strings.
 *
 * The byte-level encoding fix (UTF-8 mojibake → UTF-16 BE hex) is handled
 * downstream in pdf.ts; this step is a complementary string-level pass.
 */
function sanitizeTextValue(value: string): string {
  return value.normalize("NFC");
}

// ─── Text overflow helper ─────────────────────────────────────────────────────

/**
 * Wraps long text values so they display cleanly inside PDF form fields.
 *
 * USCIS form fields have fixed visual widths. When a value exceeds the display
 * threshold we insert newline characters at word boundaries so the text wraps
 * inside the field rather than overflowing or being clipped.
 *
 * This is a best-effort heuristic — the exact visible capacity varies per field.
 * Values that are already short are returned unchanged.
 */
const TEXT_WRAP_THRESHOLD = 45; // characters — tune per form if needed

function prepareTextValue(value: string, threshold = TEXT_WRAP_THRESHOLD): string {
  if (value.length <= threshold) return value;

  // Word-wrap: accumulate words into lines, flushing when the line would exceed
  // the threshold. Multi-word values become newline-separated runs.
  const words = value.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current.length > 0 ? `${current} ${word}` : word;
    if (candidate.length > threshold && current.length > 0) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);

  return lines.join("\n");
}

// ─── Form filler interface (compartmentalized for future form types) ──────────

/**
 * Internal params passed to a form filler implementation.
 * All filler-specific concerns (paths, directories) are resolved before this
 * point so each implementation stays focused on the mechanics of its form type.
 */
interface FormFillerParams {
  /** Logical form identifier — used for naming the output file */
  formId: string;
  /** User identifier — included in the output filename for traceability */
  userId: string;
  /** Filled field map from the LLM step: { fieldId → value } */
  fields: FieldMap;
  /** Absolute path to the blank PDF template */
  formPdfPath: string;
  /** Absolute path to the directory where the output should be written */
  outputDir: string;
}

interface FormFillerResult {
  /** Absolute path to the written output artifact */
  outputPath: string;
  /** Field IDs that received a non-empty value */
  filledFields: string[];
  /** Field IDs that were blank in the FilledFormMap and left untouched */
  skippedFields: string[];
  /** Non-fatal error messages encountered during filling */
  errors: string[];
}

/**
 * Contract for all form filler implementations.
 *
 * Adding a new form type (e.g. web-form automation) means creating a class that
 * implements this interface and registering it in getFormFiller() below.
 * The fillForm service remains unchanged.
 */
interface IFormFiller {
  fill(params: FormFillerParams): Promise<FormFillerResult>;
}

// ─── PDF filler implementation ────────────────────────────────────────────────

class PdfFormFiller implements IFormFiller {
  async fill({
    formId,
    userId,
    fields,
    formPdfPath,
    outputDir,
  }: FormFillerParams): Promise<FormFillerResult> {
    // ── Validate blank PDF ─────────────────────────────────────────────────
    if (!fs.existsSync(formPdfPath)) {
      throw new Error(
        `Blank PDF not found at "${formPdfPath}". ` +
        `Pass the correct path via formPdfPath.`
      );
    }

    // ── Ensure output directory ────────────────────────────────────────────
    fs.mkdirSync(outputDir, { recursive: true });

    // Timestamped output filename: [userId]-[formId]-[mmddyyyy hhmm].pdf
    const now = new Date();
    const mm   = String(now.getMonth() + 1).padStart(2, "0");
    const dd   = String(now.getDate()).padStart(2, "0");
    const yyyy = String(now.getFullYear());
    const hh   = String(now.getHours()).padStart(2, "0");
    const min  = String(now.getMinutes()).padStart(2, "0");
    const timestamp = `${mm}${dd}${yyyy} ${hh}${min}`;
    const outputPath = path.join(outputDir, `${userId}-${formId}-${timestamp}.pdf`);

    const preparedFields: Record<string, string> = {};
    const filledFields: string[] = [];
    const skippedFields: string[] = [];
    const errors: string[] = [];

    for (const [fieldId, rawValue] of Object.entries(fields)) {
      if (!rawValue) {
        skippedFields.push(fieldId);
        continue;
      }

      // Checkbox values ("1" or "0") are passed through verbatim — no text
      // wrapping. The FDF template patching in fillPdfWithPdftk identifies
      // which fields are checkboxes from the template structure, so we don't
      // need pdftk dump_data_fields here.
      if (rawValue === "1" || rawValue === "0") {
        preparedFields[fieldId] = rawValue;
      } else {
        preparedFields[fieldId] = prepareTextValue(sanitizeTextValue(rawValue));
      }

      filledFields.push(fieldId);
    }

    // ── Write the filled PDF ───────────────────────────────────────────────
    try {
      fillPdfWithPdftk(formPdfPath, preparedFields, outputPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`fillPdfWithPdftk failed: ${msg}`);
      return { outputPath, filledFields, skippedFields, errors };
    }

    return { outputPath, filledFields, skippedFields, errors };
  }
}

// ─── Form filler factory ──────────────────────────────────────────────────────

/**
 * Returns the filler implementation for the requested form type.
 *
 * To add a new form type:
 *   1. Create a class that implements IFormFiller.
 *   2. Add it to the switch below.
 *   3. Add the new type to the FormType union in src/types/index.ts.
 */
function getFormFiller(formType: FormType): IFormFiller {
  switch (formType) {
    case "pdf":
      return new PdfFormFiller();
    default: {
      // TypeScript narrowing: if FormType is extended, this becomes a compile
      // error rather than a silent runtime gap.
      const exhaustiveCheck: never = formType;
      throw new Error(
        `Unsupported form type: "${exhaustiveCheck}". ` +
        `Supported types: pdf`
      );
    }
  }
}

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * Fills a government form using the values stored in a FilledFormMap document.
 *
 * The service is intentionally value-agnostic — it trusts the FilledFormMap
 * as the authoritative source of field values and does not modify them beyond
 * the display-level transformations handled inside each filler implementation.
 *
 * Steps:
 *  1. Load the FilledFormMap from MongoDB by ID.
 *  2. Select the correct IFormFiller implementation for the requested formType.
 *  3. Delegate to the filler, which handles format-specific edge cases.
 *  4. Return a structured result describing which fields were filled/skipped.
 */
export async function fillForm(input: FillFormInput): Promise<FillFormOutput> {
  const {
    formId,
    userId,
    filledFormMapId,
    formPdfPath,
    outputDir,
    formType = "pdf",
  } = input;

  // ── Resolve paths ────────────────────────────────────────────────────────
  const resolvedPdfPath = path.isAbsolute(formPdfPath)
    ? formPdfPath
    : path.resolve(process.cwd(), formPdfPath);

  const resolvedOutputDir = outputDir
    ? path.resolve(process.cwd(), outputDir)
    : path.resolve(process.cwd(), "output", formId);

  // ── Load FilledFormMap ────────────────────────────────────────────────────
  console.log(`[fillForm] Loading FilledFormMap "${filledFormMapId}"...`);
  const filledMapDoc = await FilledFormMap.findById(filledFormMapId).lean();
  if (!filledMapDoc) {
    throw new Error(`No FilledFormMap found for id "${filledFormMapId}".`);
  }

  const fields = filledMapDoc.fields as FieldMap;
  const totalFields = Object.keys(fields).length;
  const nonEmptyFields = Object.values(fields).filter((v) => v !== "").length;

  console.log(
    `[fillForm] FilledFormMap loaded — ` +
    `${nonEmptyFields}/${totalFields} non-empty fields, ` +
    `assumptionLevel: "${filledMapDoc.assumptionLevel}", ` +
    `formType: "${formType}"`
  );

  // ── Select and run filler ─────────────────────────────────────────────────
  const filler = getFormFiller(formType);

  const result = await filler.fill({
    formId,
    userId,
    fields,
    formPdfPath: resolvedPdfPath,
    outputDir: resolvedOutputDir,
  });

  // ── Log result ────────────────────────────────────────────────────────────
  if (result.errors.length > 0) {
    console.error(`[fillForm] ❌ Completed with ${result.errors.length} error(s):`);
    result.errors.forEach((e) => console.error(`  • ${e}`));
  } else {
    console.log(
      `[fillForm] ✅ ${result.filledFields.length} fields written, ` +
      `${result.skippedFields.length} blank fields skipped`
    );
    console.log(`[fillForm] 📄 Output: ${result.outputPath}`);
  }

  return {
    success: result.errors.length === 0,
    outputPath: result.outputPath,
    filledFields: result.filledFields,
    skippedFields: result.skippedFields,
    errors: result.errors,
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI:
 *   npx ts-node src/services/fillForm.ts <formId> <filledFormMapId> <formPdfPath> [outputDir] [formType]
 *
 * Arguments:
 *   formId           — e.g. "i-130"
 *   filledFormMapId  — MongoDB _id from a previous fillFormMap run
 *   formPdfPath      — path to the blank PDF template, e.g. assets/forms/i-130/blank.pdf
 *   outputDir        — (optional) output directory, defaults to output/<formId>/
 *   formType         — (optional) "pdf" (default)
 *
 * Examples:
 *   npx ts-node src/services/fillForm.ts i-130 68a1b2c3d4e5f600 assets/forms/i-130/blank.pdf
 *   npx ts-node src/services/fillForm.ts i-130 68a1b2c3d4e5f600 assets/forms/i-130/blank.pdf output/i-130
 */
if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    const [, , formId, filledFormMapId, formPdfPath, outputDir, formType] =
      process.argv;

    if (!formId || !filledFormMapId || !formPdfPath) {
      console.error(
        "Usage: ts-node fillForm.ts <formId> <filledFormMapId> <formPdfPath> [outputDir] [formType]\n" +
        "\n" +
        "  formId          — e.g. i-130\n" +
        "  filledFormMapId — MongoDB _id from a fillFormMap run\n" +
        "  formPdfPath     — path to the blank PDF template\n" +
        "  outputDir       — (optional) defaults to output/<formId>/\n" +
        "  formType        — (optional) defaults to pdf\n" +
        "\n" +
        "Example:\n" +
        "  npx ts-node src/services/fillForm.ts i-130 68a1b2c3d4e5f600 assets/forms/i-130/blank.pdf"
      );
      process.exit(1);
    }

    const validFormTypes: FormType[] = ["pdf"];
    const resolvedFormType: FormType =
      formType && validFormTypes.includes(formType as FormType)
        ? (formType as FormType)
        : "pdf";

    // userId is not needed to locate the FilledFormMap by its _id, but we
    // include it in the output filename for traceability.
    const userId = `cli-${filledFormMapId}`;

    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    try {
      const result = await fillForm({
        formId,
        userId,
        filledFormMapId,
        formPdfPath,
        outputDir: outputDir || undefined,
        formType: resolvedFormType,
      });

      if (!result.success) {
        console.error("\n❌ Fill completed with errors:");
        result.errors.forEach((e) => console.error(`  • ${e}`));
        await disconnectDB();
        process.exit(1);
      }

      console.log("\n✅ Form filled successfully");
      console.log(`   Form type     : ${resolvedFormType}`);
      console.log(`   Fields filled : ${result.filledFields.length}`);
      console.log(`   Fields skipped: ${result.skippedFields.length} (blank in FilledFormMap)`);
      console.log(`   Output        : ${result.outputPath}\n`);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      await disconnectDB();
      process.exit(1);
    }

    await disconnectDB();
    process.exit(0);
  })();
}
