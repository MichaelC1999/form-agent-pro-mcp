/**
 * validateRefactor — pipeline output capture + diff harness
 *
 * Provides a way to prove the process-aware refactor produces fills
 * comparable to the pre-refactor pipeline for the same SituationalContext.
 *
 * Two modes:
 *
 *   CAPTURE — runs fillFormMap for every required form in a SituationalContext
 *             and writes each resulting FilledFormMap's `fields` map to
 *             output/validate/<label>/<formId>__<beneficiaryKey-or-_>.json.
 *
 *     npx ts-node src/scripts/validateRefactor.ts capture \
 *       --contextId <situationalContextId> \
 *       --label <baseline | refactor | any-tag>
 *
 *   DIFF — reads two label directories and reports per-form, per-field
 *          identical/differing/added/removed counts.
 *
 *     npx ts-node src/scripts/validateRefactor.ts diff \
 *       --left baseline --right refactor
 *
 *   NOISE — runs CAPTURE twice with the same input and labels A/B, then diffs.
 *           Measures the intrinsic LLM noise floor so refactor diffs can be
 *           judged against it.
 *
 *     npx ts-node src/scripts/validateRefactor.ts noise \
 *       --contextId <situationalContextId>
 *
 * MONGODB_URI and ANTHROPIC_API_KEY must be set in .env. Capture writes new
 * FilledFormMap documents to MongoDB on every run — point at a scratch DB if
 * that matters.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { connectDB, disconnectDB } from "../lib/db";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { fillFormMap } from "../services/fillFormMap";
import { normalizeRequiredForms } from "../types";
import type { FieldMap } from "../types";

const OUTPUT_ROOT = path.resolve(__dirname, "../../output/validate");

interface CliArgs {
  command?: string;
  contextId?: string;
  label?: string;
  left?: string;
  right?: string;
  before?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: argv[0] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--contextId" && argv[i + 1]) args.contextId = argv[++i];
    else if (a === "--label" && argv[i + 1]) args.label = argv[++i];
    else if (a === "--left" && argv[i + 1]) args.left = argv[++i];
    else if (a === "--right" && argv[i + 1]) args.right = argv[++i];
    else if (a === "--before" && argv[i + 1]) args.before = argv[++i];
  }
  return args;
}

function safeKey(key: string | undefined): string {
  if (!key || key.trim() === "") return "_";
  return key.replace(/[^A-Za-z0-9._-]+/g, "_");
}

function fillFilePath(labelDir: string, formId: string, beneficiaryKey?: string): string {
  return path.join(labelDir, `${formId}__${safeKey(beneficiaryKey)}.json`);
}

async function snapshot(contextId: string, label: string, beforeIso?: string): Promise<void> {
  const ctx = await SituationalContext.findById(contextId).lean();
  if (!ctx) throw new Error(`SituationalContext not found: ${contextId}`);

  const userId = (ctx as any).userId as string;
  const entries = normalizeRequiredForms((ctx as any).requiredForms);

  const labelDir = path.join(OUTPUT_ROOT, label);
  fs.mkdirSync(labelDir, { recursive: true });

  const cutoff = beforeIso ? new Date(beforeIso) : null;
  console.log(
    `\n[validateRefactor] snapshot — ${entries.length} entries → ${labelDir}` +
    (cutoff ? ` (createdAt < ${cutoff.toISOString()})` : "") + "\n"
  );

  for (const entry of entries) {
    const { formId, beneficiaryKey } = entry;
    const tag = beneficiaryKey ? `${formId} (${beneficiaryKey})` : formId;

    const query: Record<string, unknown> = { userId, formId };
    if (beneficiaryKey) {
      query.beneficiaryKey = beneficiaryKey;
    } else {
      query.beneficiaryKey = { $in: [null, undefined, ""] };
    }
    if (cutoff) query.createdAt = { $lt: cutoff };

    const filled = await FilledFormMap.findOne(query).sort({ createdAt: -1 }).lean();
    if (!filled) {
      console.log(`  - ${tag} — no matching FilledFormMap`);
      continue;
    }
    const ff = filled as any;
    const outPath = fillFilePath(labelDir, formId, beneficiaryKey);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          formId,
          beneficiaryKey: beneficiaryKey ?? null,
          processId: ff.processId ?? null,
          assumptionLevel: ff.assumptionLevel,
          createdAt: ff.createdAt,
          _id: String(ff._id),
          fields: ff.fields,
          skipped: ff.skipped,
        },
        null,
        2
      )
    );
    const filledCount = Object.values(ff.fields as FieldMap).filter((v) => v !== "").length;
    console.log(`  ✓ ${tag} — ${filledCount}/${Object.keys(ff.fields).length} filled (createdAt ${new Date(ff.createdAt).toISOString()})`);
  }

  console.log(`\nSnapshot complete: ${labelDir}\n`);
}

async function capture(contextId: string, label: string): Promise<void> {
  const ctx = await SituationalContext.findById(contextId).lean();
  if (!ctx) throw new Error(`SituationalContext not found: ${contextId}`);

  const userId = (ctx as any).userId as string;
  const entries = normalizeRequiredForms((ctx as any).requiredForms);
  if (entries.length === 0) {
    throw new Error(`SituationalContext ${contextId} has no requiredForms.`);
  }

  const labelDir = path.join(OUTPUT_ROOT, label);
  fs.mkdirSync(labelDir, { recursive: true });

  console.log(`\n[validateRefactor] capture — ${entries.length} entries → ${labelDir}\n`);

  for (const entry of entries) {
    const { formId, beneficiaryKey } = entry;
    const tag = beneficiaryKey ? `${formId} (${beneficiaryKey})` : formId;
    try {
      const filled = await fillFormMap({
        formId,
        userId,
        situationalContextId: contextId,
        beneficiaryKey,
      });
      const outPath = fillFilePath(labelDir, formId, beneficiaryKey);
      fs.writeFileSync(
        outPath,
        JSON.stringify(
          {
            formId,
            beneficiaryKey: beneficiaryKey ?? null,
            processId: (filled as any).processId ?? null,
            assumptionLevel: filled.assumptionLevel,
            fields: filled.fields,
            skipped: filled.skipped,
          },
          null,
          2
        )
      );
      const fields = filled.fields as FieldMap;
      const filledCount = Object.values(fields).filter((v) => v !== "").length;
      console.log(`  ✓ ${tag} — ${filledCount}/${Object.keys(fields).length} filled → ${path.basename(outPath)}`);
    } catch (err) {
      console.error(`  ✗ ${tag} — ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`\nCapture complete: ${labelDir}\n`);
}

interface FormDiff {
  formId: string;
  beneficiaryKey: string | null;
  totalLeft: number;
  totalRight: number;
  intersecting: number;
  identical: number;
  differing: number;
  onlyLeft: number;
  onlyRight: number;
  sampleDiffs: Array<{ field: string; left: string; right: string }>;
}

function diffFile(left: any, right: any): FormDiff {
  const leftFields = (left.fields ?? {}) as Record<string, string>;
  const rightFields = (right.fields ?? {}) as Record<string, string>;
  const leftKeys = new Set(Object.keys(leftFields));
  const rightKeys = new Set(Object.keys(rightFields));
  const intersecting = [...leftKeys].filter((k) => rightKeys.has(k));
  const onlyLeft = [...leftKeys].filter((k) => !rightKeys.has(k));
  const onlyRight = [...rightKeys].filter((k) => !leftKeys.has(k));

  let identical = 0;
  let differing = 0;
  const sampleDiffs: FormDiff["sampleDiffs"] = [];
  for (const k of intersecting) {
    if (leftFields[k] === rightFields[k]) {
      identical++;
    } else {
      differing++;
      if (sampleDiffs.length < 10) {
        sampleDiffs.push({ field: k, left: leftFields[k], right: rightFields[k] });
      }
    }
  }

  return {
    formId: left.formId ?? right.formId ?? "?",
    beneficiaryKey: left.beneficiaryKey ?? right.beneficiaryKey ?? null,
    totalLeft: leftKeys.size,
    totalRight: rightKeys.size,
    intersecting: intersecting.length,
    identical,
    differing,
    onlyLeft: onlyLeft.length,
    onlyRight: onlyRight.length,
    sampleDiffs,
  };
}

function listFills(dir: string): Map<string, string> {
  const entries = new Map<string, string>();
  if (!fs.existsSync(dir)) return entries;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    entries.set(f, path.join(dir, f));
  }
  return entries;
}

function diff(leftLabel: string, rightLabel: string): void {
  const leftDir = path.join(OUTPUT_ROOT, leftLabel);
  const rightDir = path.join(OUTPUT_ROOT, rightLabel);

  const leftFiles = listFills(leftDir);
  const rightFiles = listFills(rightDir);

  const allNames = new Set<string>([...leftFiles.keys(), ...rightFiles.keys()]);

  console.log(`\n[validateRefactor] diff — ${leftLabel} (${leftFiles.size}) vs ${rightLabel} (${rightFiles.size})\n`);

  let totalIdentical = 0;
  let totalDiffering = 0;
  let totalIntersecting = 0;

  for (const name of [...allNames].sort()) {
    const lp = leftFiles.get(name);
    const rp = rightFiles.get(name);
    if (!lp) {
      console.log(`  ${name}: only in ${rightLabel}`);
      continue;
    }
    if (!rp) {
      console.log(`  ${name}: only in ${leftLabel}`);
      continue;
    }
    const lj = JSON.parse(fs.readFileSync(lp, "utf-8"));
    const rj = JSON.parse(fs.readFileSync(rp, "utf-8"));
    const d = diffFile(lj, rj);
    totalIdentical += d.identical;
    totalDiffering += d.differing;
    totalIntersecting += d.intersecting;

    const matchPct = d.intersecting > 0 ? ((d.identical / d.intersecting) * 100).toFixed(1) : "n/a";
    console.log(
      `  ${name}: identical=${d.identical}/${d.intersecting} (${matchPct}%), ` +
      `differing=${d.differing}, onlyLeft=${d.onlyLeft}, onlyRight=${d.onlyRight}`
    );
    if (d.sampleDiffs.length > 0) {
      for (const s of d.sampleDiffs.slice(0, 3)) {
        const l = s.left.length > 60 ? s.left.slice(0, 57) + "..." : s.left;
        const r = s.right.length > 60 ? s.right.slice(0, 57) + "..." : s.right;
        console.log(`    • ${s.field}\n      L: ${JSON.stringify(l)}\n      R: ${JSON.stringify(r)}`);
      }
    }
  }

  const overallPct = totalIntersecting > 0 ? ((totalIdentical / totalIntersecting) * 100).toFixed(2) : "n/a";
  console.log(
    `\nOverall: ${totalIdentical}/${totalIntersecting} fields identical (${overallPct}%), ` +
    `${totalDiffering} differing\n`
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || !["capture", "diff", "noise", "snapshot"].includes(args.command)) {
    console.error(
      "Usage:\n" +
      "  validateRefactor snapshot --contextId <id> --label <tag> [--before <ISO date>]\n" +
      "  validateRefactor capture  --contextId <id> --label <tag>\n" +
      "  validateRefactor diff     --left <tag> --right <tag>\n" +
      "  validateRefactor noise    --contextId <id>"
    );
    process.exit(1);
  }

  if (args.command === "diff") {
    if (!args.left || !args.right) {
      console.error("diff requires --left and --right");
      process.exit(1);
    }
    diff(args.left, args.right);
    process.exit(0);
  }

  await connectDB();

  try {
    if (args.command === "snapshot") {
      if (!args.contextId || !args.label) {
        console.error("snapshot requires --contextId and --label");
        process.exit(1);
      }
      await snapshot(args.contextId, args.label, args.before);
    } else if (args.command === "capture") {
      if (!args.contextId || !args.label) {
        console.error("capture requires --contextId and --label");
        process.exit(1);
      }
      await capture(args.contextId, args.label);
    } else if (args.command === "noise") {
      if (!args.contextId) {
        console.error("noise requires --contextId");
        process.exit(1);
      }
      await capture(args.contextId, "noise-a");
      await capture(args.contextId, "noise-b");
      diff("noise-a", "noise-b");
    }
  } finally {
    await disconnectDB();
  }

  process.exit(0);
}

main().catch(async (err) => {
  console.error("[validateRefactor] Fatal:", err instanceof Error ? err.message : err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
