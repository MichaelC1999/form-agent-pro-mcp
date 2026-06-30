/**
 * setup-form — One-time per-form setup CLI
 *
 * Runs buildFormMap then buildFormContext for a given (processId, formId)
 * pair. Execute once per (process, form) before running the pipeline.
 *
 * Usage:
 *   npx ts-node src/scripts/setup-form.ts <processId> <formId> [version] [contextFiles...]
 *
 * The blank PDF is read from assets/forms/<processId>/<formId>/blank.pdf —
 * this layout is fixed by src/lib/processes.ts.
 *
 * Examples:
 *   npx ts-node src/scripts/setup-form.ts aos i-485
 *   npx ts-node src/scripts/setup-form.ts aos i-693 1.0 assets/context/i-693-instructions.md
 *
 * Environment: MONGODB_URI and ANTHROPIC_API_KEY must be set in .env
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { connectDB } from "../lib/db";
import { buildFormMap } from "../services/buildFormMap";
import { buildFormContext } from "../services/buildFormContext";
import { getBlankPdfPath, listProcesses, processExists } from "../lib/processes";

async function main(): Promise<void> {
  const [, , processId, formId, ...rest] = process.argv;

  if (!processId || !formId) {
    console.error(
      "Usage: npx ts-node src/scripts/setup-form.ts <processId> <formId> [version] [contextFiles...]\n" +
      `Known processes: ${listProcesses().join(", ") || "(none)"}`
    );
    process.exit(1);
  }

  if (!processExists(processId)) {
    console.error(
      `Process "${processId}" not found under assets/forms/. ` +
      `Known processes: ${listProcesses().join(", ") || "(none)"}`
    );
    process.exit(1);
  }

  const formPdfPath = getBlankPdfPath(processId, formId);
  if (!fs.existsSync(formPdfPath)) {
    console.error(`Blank PDF not found at ${formPdfPath}.`);
    process.exit(1);
  }

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
  console.log(`\n[setup-form] Step 1/2 — buildFormMap: ${processId}/${formId} (version ${version})`);
  const formMap = await buildFormMap({ formId, formPdfPath, version });
  console.log(
    `[setup-form] ✓ FormMap saved — ${formMap.fieldCount} fields extracted (strategy: ${formMap.strategy})`
  );

  // ── Step 2: Build Form Context ─────────────────────────────────────────────
  console.log(`\n[setup-form] Step 2/2 — buildFormContext: ${processId}/${formId}`);
  if (contextFilePaths.length > 0) {
    console.log(`[setup-form]   Supplemental files: ${contextFilePaths.join(", ")}`);
  }

  const formContext = await buildFormContext({
    formId,
    formPdfPath,
    candidateProcessIds: [processId, ...listProcesses().filter((p) => p !== processId)],
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
