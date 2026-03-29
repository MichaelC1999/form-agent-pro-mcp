/**
 * setup-form — One-time per-form setup CLI
 *
 * Runs buildFormMap then buildFormContext for a given form ID and blank PDF.
 * Execute this once for each new form before running the pipeline.
 *
 * Usage:
 *   npx ts-node src/scripts/setup-form.ts <formId> <pdfPath> [version] [contextFiles...]
 *
 * Examples:
 *   npx ts-node src/scripts/setup-form.ts i-485 assets/forms/i-485/blank.pdf
 *   npx ts-node src/scripts/setup-form.ts i-693 assets/forms/i-693/blank.pdf 1.0 assets/context/i-693-instructions.md
 *
 * Environment: MONGODB_URI and ANTHROPIC_API_KEY must be set in .env
 */

import "dotenv/config";
import * as path from "path";
import { connectDB } from "../lib/db";
import { buildFormMap } from "../services/buildFormMap";
import { buildFormContext } from "../services/buildFormContext";

async function main(): Promise<void> {
  const [, , formId, pdfPathArg, ...rest] = process.argv;

  if (!formId || !pdfPathArg) {
    console.error(
      "Usage: npx ts-node src/scripts/setup-form.ts <formId> <pdfPath> [version] [contextFiles...]"
    );
    process.exit(1);
  }

  const formPdfPath = path.resolve(pdfPathArg);

  // Third positional arg is version if it doesn't look like a file path;
  // otherwise treat it as the first context file.
  let version = "1.0";
  let contextFileArgs = rest;
  if (rest.length > 0 && !rest[0].includes("/") && !rest[0].includes(".")) {
    version = rest[0];
    contextFileArgs = rest.slice(1);
  }

  const contextFilePaths = contextFileArgs.map((f) => path.resolve(f));

  await connectDB();

  // ── Step 1: Build Form Map ─────────────────────────────────────────────────
  console.log(`\n[setup-form] Step 1/2 — buildFormMap: ${formId} (version ${version})`);
  const formMap = await buildFormMap({ formId, formPdfPath, version });
  console.log(
    `[setup-form] ✓ FormMap saved — ${formMap.fieldCount} fields extracted (strategy: ${formMap.strategy})`
  );

  // ── Step 2: Build Form Context ─────────────────────────────────────────────
  console.log(`\n[setup-form] Step 2/2 — buildFormContext: ${formId}`);
  if (contextFilePaths.length > 0) {
    console.log(`[setup-form]   Supplemental files: ${contextFilePaths.join(", ")}`);
  }

  const formContext = await buildFormContext({
    formId,
    formPdfPath,
    ...(contextFilePaths.length > 0 ? { contextFilePaths } : {}),
  });

  console.log(
    `[setup-form] ✓ FormContext saved — ${formContext.fields.length} field annotations`
  );

  console.log(`\n[setup-form] Done. "${formId}" is ready for the pipeline.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[setup-form] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
