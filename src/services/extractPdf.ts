import * as fs from "fs";
import { extractFieldValues } from "../lib/pdf";
import { FilledFormMap } from "../models/FilledFormMap";
import type { ExtractPdfInput, IFilledFormMap, FieldMap } from "../types";

// ─── Service ──────────────────────────────────────────────────────────────────

/**
 * extractPdf
 *
 * Reads all field values from an already-filled PDF via pdftk and either:
 *   - Creates a new FilledFormMap document in MongoDB (if existingMapId is not provided), or
 *   - Updates an existing FilledFormMap, merging the extracted values over stored ones
 *     (existing values are overwritten only when the PDF has a non-empty value for that field).
 *
 * The resulting FilledFormMap uses assumptionLevel "liberal" since the values
 * come directly from a human-filled PDF — there are no inference assumptions.
 *
 * Returns the saved/updated IFilledFormMap.
 */
export async function extractPdf(input: ExtractPdfInput): Promise<IFilledFormMap> {
  const { pdfPath, existingMapId } = input;

  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }

  // 1. Extract all field values from the filled PDF
  const fieldInfoMap = extractFieldValues(pdfPath);

  if (fieldInfoMap.size === 0) {
    throw new Error(
      `No fields found in PDF at "${pdfPath}". ` +
      `The PDF may be flat/non-interactive or pdftk could not read it.`
    );
  }

  // 2. Build a FieldMap from the extracted values
  const extractedFields: FieldMap = {};
  for (const [fieldId, info] of fieldInfoMap) {
    extractedFields[fieldId] = info.value ?? "";
  }

  const filledCount = Object.values(extractedFields).filter((v) => v !== "").length;
  console.log(
    `[extractPdf] Extracted ${fieldInfoMap.size} fields (${filledCount} non-empty) from "${pdfPath}"`
  );

  // 3a. Update an existing FilledFormMap if an ID was supplied
  if (existingMapId) {
    const existing = await FilledFormMap.findById(existingMapId);
    if (!existing) {
      throw new Error(`FilledFormMap not found: ${existingMapId}`);
    }

    // Merge: extracted non-empty values overwrite stored values; empty extracted
    // values do NOT wipe out existing stored values.
    const mergedFields: FieldMap = { ...(existing.fields as FieldMap) };
    for (const [fieldId, value] of Object.entries(extractedFields)) {
      if (value !== "") {
        mergedFields[fieldId] = value;
      } else if (!(fieldId in mergedFields)) {
        mergedFields[fieldId] = "";
      }
    }

    existing.fields = mergedFields;
    await existing.save();

    console.log(`[extractPdf] ✅ Updated FilledFormMap ${existingMapId}`);
    return existing.toObject() as IFilledFormMap;
  }

  // 3b. Derive formId from the PDF filename (best-effort) — e.g. "i-485.pdf" → "i-485"
  const pdfBasename = require("path").basename(pdfPath, ".pdf").toLowerCase();

  // 4. Create a new FilledFormMap
  const doc = await FilledFormMap.create({
    formId: pdfBasename,
    userId: "extracted",   // placeholder — caller should update if they know the user
    createdAt: new Date(),
    assumptionLevel: "liberal", // values come directly from a filled PDF
    fields: extractedFields,
  });

  console.log(`[extractPdf] ✅ Created new FilledFormMap ${doc._id} for form "${pdfBasename}"`);
  return doc.toObject() as IFilledFormMap;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI:
 *   npx ts-node src/services/extractPdf.ts <pdfPath> [existingMapId]
 */
if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    const [, , pdfPath, existingMapId] = process.argv;
    if (!pdfPath) {
      console.error("Usage: ts-node extractPdf.ts <pdfPath> [existingMapId]");
      process.exit(1);
    }

    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    try {
      const result = await extractPdf({ pdfPath, existingMapId });
      const filledCount = Object.values(result.fields).filter((v) => v !== "").length;
      console.log(`\n✅ Fields extracted from "${pdfPath}"`);
      console.log(`   Form        : ${result.formId}`);
      console.log(`   Total fields: ${Object.keys(result.fields).length}`);
      console.log(`   Filled      : ${filledCount}`);
      console.log(`   MongoDB _id : ${(result as any)._id}\n`);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      await disconnectDB();
      process.exit(1);
    }

    await disconnectDB();
    process.exit(0);
  })();
}
