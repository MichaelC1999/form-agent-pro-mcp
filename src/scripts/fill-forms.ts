/**
 * fill-forms — CLI pipeline script
 *
 * For every form in a SituationalContext's requiredForms, finds the most
 * recently saved FilledFormMap and runs fillForm to produce a filled PDF.
 *
 * fillFormMap is NOT called — FilledFormMap records must already exist in
 * MongoDB for this situational context before running this script.
 *
 * Usage:
 *   npx ts-node src/scripts/fill-forms.ts <situationalContextId>
 *
 * Prerequisites:
 *   • MONGODB_URI set in .env
 *   • fillFormMap has been run for each form in requiredForms
 *   • Blank PDFs exist at assets/forms/<formId>/blank.pdf
 *
 * Output:
 *   Filled PDFs are written to output/<formId>/  (one file per form)
 */

import "dotenv/config";
import { connectDB, disconnectDB } from "../lib/db";
import { runPipeline } from "../services/runPipeline";

async function main(): Promise<void> {
  const situationalContextId = process.argv[2];

  if (!situationalContextId) {
    console.error("\nUsage:\n  npx ts-node src/scripts/fill-forms.ts <situationalContextId>\n");
    process.exit(1);
  }

  await connectDB();

  try {
    console.log(`\n[fill-forms] situationalContextId: ${situationalContextId}\n`);

    const result = await runPipeline(situationalContextId);

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log("\n" + "═".repeat(60));
    console.log("[fill-forms] Summary");
    console.log("═".repeat(60));

    let anyFailure = false;
    for (const r of result.forms) {
      const status = r.success ? "✅" : "❌";
      console.log(`\n  ${status} ${r.formId}`);
      if (r.filledFormMapId) console.log(`     FilledFormMap : ${r.filledFormMapId}`);
      if (r.outputPath)      console.log(`     Output        : ${r.outputPath}`);
      console.log(`     Fields filled : ${r.filledFields.length}`);
      console.log(`     Fields skipped: ${r.skippedFields.length}`);
      if (r.errors.length > 0) {
        anyFailure = true;
        r.errors.forEach((e) => console.error(`     Error         : ${e}`));
      }
    }

    console.log("");
    await disconnectDB();
    process.exit(anyFailure ? 1 : 0);
  } catch (err) {
    console.error("❌", err instanceof Error ? err.message : err);
    await disconnectDB();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[fill-forms] Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
