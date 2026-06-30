/**
 * backfillProcess — One-time migration script
 *
 * Stamps `processId` / `applicableProcesses` / `scope` onto records created
 * before the pipeline became process-aware. Idempotent — only writes when the
 * target field is missing.
 *
 *   SituationalContext.processId         → DEFAULT_PROCESS_ID
 *   FilledFormMap.processId              → DEFAULT_PROCESS_ID
 *   FormContext.applicableProcesses      → [DEFAULT_PROCESS_ID]
 *   FormContext.formMetadata.scope       → derived from the legacy
 *                                          per-beneficiary vs. household list
 *
 * Usage:
 *   npx ts-node src/scripts/backfillProcess.ts [--dry-run]
 *
 * Requires MONGODB_URI in the environment.
 */

import "dotenv/config";
import { connectDB, disconnectDB } from "../lib/db";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { FormContext } from "../models/FormContext";
import { DEFAULT_PROCESS_ID } from "../lib/processes";
import type { FormScope } from "../types";

// Frozen at refactor time — the legacy hardcoded classification from
// buildSituationContext.ts before processes were introduced. Used only to
// stamp the `scope` field onto FormContext docs created before the field
// existed. New FormContexts get their scope from the LLM directly.
const LEGACY_PER_BENEFICIARY_FORMS = new Set([
  "i-130",
  "i-130a",
  "i-485",
  "i-765",
  "i-131",
  "i-693",
  "i-751",
  "n-600",
  "i-90",
  "i-539",
  "i-140",
]);
const LEGACY_HOUSEHOLD_FORMS = new Set(["i-864", "i-864a", "n-400"]);

function legacyScopeFor(formId: string): FormScope | null {
  if (LEGACY_PER_BENEFICIARY_FORMS.has(formId)) return "per-beneficiary";
  if (LEGACY_HOUSEHOLD_FORMS.has(formId)) return "household";
  return null;
}

interface Counts {
  scanned: number;
  updated: number;
  skipped: number;
}

async function backfillSituationalContexts(dryRun: boolean): Promise<Counts> {
  const counts: Counts = { scanned: 0, updated: 0, skipped: 0 };
  const cursor = SituationalContext.find({
    $or: [{ processId: { $exists: false } }, { processId: "" }, { processId: null }],
  }).cursor();

  for await (const doc of cursor) {
    counts.scanned++;
    if (dryRun) {
      counts.updated++;
      continue;
    }
    await SituationalContext.updateOne(
      { _id: doc._id },
      { $set: { processId: DEFAULT_PROCESS_ID } }
    );
    counts.updated++;
  }
  return counts;
}

async function backfillFilledFormMaps(dryRun: boolean): Promise<Counts> {
  const counts: Counts = { scanned: 0, updated: 0, skipped: 0 };
  const cursor = FilledFormMap.find({
    $or: [{ processId: { $exists: false } }, { processId: "" }, { processId: null }],
  }).cursor();

  for await (const doc of cursor) {
    counts.scanned++;
    if (dryRun) {
      counts.updated++;
      continue;
    }
    await FilledFormMap.updateOne(
      { _id: doc._id },
      { $set: { processId: DEFAULT_PROCESS_ID } }
    );
    counts.updated++;
  }
  return counts;
}

async function backfillFormContexts(dryRun: boolean): Promise<Counts> {
  const counts: Counts = { scanned: 0, updated: 0, skipped: 0 };
  const cursor = FormContext.find({}).cursor();

  for await (const doc of cursor) {
    counts.scanned++;
    const update: Record<string, unknown> = {};

    const current = (doc as any).applicableProcesses as string[] | undefined;
    if (!current || current.length === 0) {
      update["applicableProcesses"] = [DEFAULT_PROCESS_ID];
    }

    const metadata = ((doc as any).formMetadata ?? {}) as Record<string, unknown>;
    if (!metadata.scope) {
      const scope = legacyScopeFor(String((doc as any).formId));
      if (scope) {
        update["formMetadata.scope"] = scope;
      }
    }

    if (Object.keys(update).length === 0) {
      counts.skipped++;
      continue;
    }

    if (dryRun) {
      counts.updated++;
      continue;
    }

    await FormContext.updateOne({ _id: doc._id }, { $set: update });
    counts.updated++;
  }
  return counts;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  await connectDB();

  console.log(`\n[backfillProcess] ${dryRun ? "DRY RUN — no writes" : "WRITING updates"}\n`);

  const sit = await backfillSituationalContexts(dryRun);
  console.log(
    `[backfillProcess] SituationalContext: scanned=${sit.scanned}, updated=${sit.updated}, skipped=${sit.skipped}`
  );

  const ffm = await backfillFilledFormMaps(dryRun);
  console.log(
    `[backfillProcess] FilledFormMap:      scanned=${ffm.scanned}, updated=${ffm.updated}, skipped=${ffm.skipped}`
  );

  const fc = await backfillFormContexts(dryRun);
  console.log(
    `[backfillProcess] FormContext:        scanned=${fc.scanned}, updated=${fc.updated}, skipped=${fc.skipped}`
  );

  console.log("\nDone.\n");
  await disconnectDB();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("[backfillProcess] Fatal:", err instanceof Error ? err.message : err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
