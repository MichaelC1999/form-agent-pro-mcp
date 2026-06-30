/**
 * fill-affidavits — per-context affidavit fill + PDF render CLI
 *
 * For a SituationalContext whose processId has an `affidavits/` directory,
 * runs fillAffidavit for every template and renders the filled markdown to
 * PDF. Templates that the LLM marks as not-applicable are skipped (their
 * FilledAffidavit record is still persisted with status="skipped" for audit).
 *
 * Usage:
 *   npx ts-node --transpile-only src/scripts/fill-affidavits.ts \
 *     --contextId <situationalContextId> \
 *     [--affidavit <name>] \
 *     [--beneficiaryKey <party-name>] \
 *     [--outputDir <dir>]
 *
 * Without --affidavit, every affidavit in the process's affidavits/ dir is
 * processed in turn.
 *
 * Environment: MONGODB_URI and ANTHROPIC_API_KEY must be set in .env.
 */

import "dotenv/config";
import * as path from "path";
import { connectDB, disconnectDB } from "../lib/db";
import { SituationalContext } from "../models/SituationalContext";
import { fillAffidavit, renderFilledAffidavitToPdf } from "../services/fillAffidavit";
import { listAffidavits, hasAffidavits, resolveProcessId } from "../lib/processes";

interface Args {
  contextId?: string;
  affidavit?: string;
  beneficiaryKey?: string;
  outputDir?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--contextId" && argv[i + 1]) a.contextId = argv[++i];
    else if (arg === "--affidavit" && argv[i + 1]) a.affidavit = argv[++i];
    else if (arg === "--beneficiaryKey" && argv[i + 1]) a.beneficiaryKey = argv[++i];
    else if (arg === "--outputDir" && argv[i + 1]) a.outputDir = argv[++i];
  }
  return a;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.contextId) {
    console.error(
      "Usage: fill-affidavits --contextId <id> [--affidavit <name>] [--beneficiaryKey <party>] [--outputDir <dir>]"
    );
    process.exit(1);
  }

  await connectDB();

  const ctx = await SituationalContext.findById(args.contextId).lean();
  if (!ctx) {
    console.error(`SituationalContext not found: ${args.contextId}`);
    await disconnectDB();
    process.exit(1);
  }

  const userId = (ctx as any).userId as string;
  const processId = resolveProcessId((ctx as any).processId);

  if (!hasAffidavits(processId)) {
    console.error(`Process "${processId}" has no affidavits/ directory — nothing to do.`);
    await disconnectDB();
    process.exit(0);
  }

  const names = args.affidavit ? [args.affidavit] : listAffidavits(processId);
  if (names.length === 0) {
    console.error(`No affidavits found for process "${processId}".`);
    await disconnectDB();
    process.exit(0);
  }

  const outputDir =
    args.outputDir ?? path.resolve(process.cwd(), "output", "affidavits", processId);

  console.log(`\n[fill-affidavits] processId="${processId}" — ${names.length} affidavit(s)\n`);

  let failures = 0;
  for (const name of names) {
    try {
      const filled = await fillAffidavit({
        userId,
        situationalContextId: args.contextId,
        affidavitName: name,
        beneficiaryKey: args.beneficiaryKey,
      });
      if (filled.status === "filled") {
        const { outputPath } = await renderFilledAffidavitToPdf(filled, outputDir);
        console.log(`  📄 ${name} → ${outputPath}`);
      } else {
        console.log(`  ⊘ ${name} skipped — ${filled.reason}`);
      }
    } catch (err) {
      failures++;
      console.error(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("");
  await disconnectDB();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("[fill-affidavits] Fatal:", err instanceof Error ? err.message : err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
