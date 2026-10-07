/**
 * eval — end-to-end pipeline consistency + accuracy check on a fixed packet
 *
 * Runs the full pipeline on the hardcoded inputs in eval/packets/<packet>/:
 *   buildSituationContext → fillFormMap (per form) → fillForm (PDF)
 * then reads each filled PDF back and scores it against expected/<formId>.json.
 * Repeat runs on the same inputs show how consistent the pipeline is.
 *
 *   npm run eval -- --packet jones-aos --runs 3 --label baseline
 *
 * (--transpile-only, like `npm run dev`: plain ts-node type-checks per file and
 * misses the Express `req.auth` augmentation in middleware/requireAuth.ts.
 * `npx tsc --noEmit` covers type checking.)
 *
 * Options:
 *   --packet <id>        packet under eval/packets/ (required)
 *   --runs <n>           pipeline runs to add (default 1; 0 = re-score saved runs only)
 *   --label <name>       output folder name (default: timestamp). Re-using a label
 *                        appends runs to it, and the report covers every run in it.
 *   --context <id>       reuse an existing SituationalContext instead of building one
 *                        per run — isolates fill-step variance from extraction variance
 *   --forms <a,b>        subset of the packet's forms
 *   --level <level>      assumptionLevel for fillFormMap (default: the service default)
 *   --compare <label>    print metric deltas against another label of the same packet
 *
 * Output: output/eval/<packet>/<label>/
 *   run-N/context.json      situational context the run used
 *   run-N/<formId>.json     FilledFormMap values, skipped log, PDF read-back values
 *   run-N/<formId>.pdf      filled PDF
 *   summary.json, report.txt
 *
 * Writes SituationalContext / FilledFormMap / AnthropicLog documents to the
 * MONGODB_URI database under the packet's userId (e.g. "eval:jones-aos").
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { connectDB, disconnectDB } from "../lib/db";
import { extractFieldValues, readFieldLabels, type PdfFieldLabel } from "../lib/pdf";
import { getBlankPdfPath } from "../lib/processes";
import { SituationalContext } from "../models/SituationalContext";
import { buildSituationContext } from "../services/buildSituationContext";
import { fillFormMap } from "../services/fillFormMap";
import { fillForm } from "../services/fillForm";
import { normalizeRequiredForms } from "../types";
import type { AssumptionLevel, ISituationalContext, UIAnswers, UploadedFile } from "../types";

const PACKETS_ROOT = path.resolve(__dirname, "../../eval/packets");
const OUTPUT_ROOT = path.resolve(__dirname, "../../output/eval");
const CONSOLE_LIST_CAP = 12;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Packet {
  id: string;
  processId: string;
  userId: string;
  uiAnswers: UIAnswers;
  documents: Array<{ file: string }>;
  forms: string[];
  /** Substring of the beneficiary's party name, used when requiredForms omits a form */
  beneficiary: string;
}

type Expect = string | string[] | boolean;

interface ExpectedField {
  id: string;
  label: string;
  expect: Expect;
  /**
   * How text values compare (default: case/whitespace-insensitive equality):
   *   contains — the value contains an accepted string ("482 Placeholder" ⊂ "482 Placeholder Lane")
   *   digits   — digits only ("123-45-6789" = "123456789")
   *   number   — numeric value ("$84,500.00" = "84500")
   *   date     — calendar date ("1992-03-14" = "03/14/1992")
   * Scoring reads the filled PDF back, so a value the PDF truncated still fails.
   */
  match?: "contains" | "digits" | "number" | "date";
  /** The packet doesn't settle this value — excluded from scoring */
  unknown?: boolean;
}

type Outcome = "correct" | "wrong" | "missed" | "overfilled";
/** Per-run outcome in reports — "error" when the form produced no PDF that run */
type RunOutcome = Outcome | "error";

interface FormRunArtifact {
  formId: string;
  beneficiaryKey: string | null;
  inRequiredForms: boolean;
  error?: string;
  filledFormMapId?: string;
  assumptionLevel?: string;
  durationMs?: number;
  mapFields?: Record<string, string>;
  skipped?: Array<{ fieldId: string; reason: string }>;
  pdfValues?: Record<string, string>;
  pdfErrors?: string[];
}

interface ContextRunArtifact {
  situationalContextId?: string;
  reused: boolean;
  extractionMode: string;
  error?: string;
  durationMs?: number;
  processId?: string;
  situationSummary?: string;
  requiredForms?: Array<{ formId: string; beneficiaryKey?: string }>;
  partyData?: Record<string, Record<string, unknown>>;
}

interface FormRunScore {
  run: string;
  error?: string;
  beneficiaryKey: string | null;
  inRequiredForms: boolean;
  filled: number;
  /** Filled values whose field ID doesn't exist in the PDF — silently dropped */
  droppedValues: number;
  /** Checkboxes holding a value other than their own checked value (e.g. "N" in a "Y" box) — they print unchecked */
  invalidCheckboxValues: number;
  scored: number;
  correct: number;
  wrong: number;
  missed: number;
  overfilled: number;
}

interface FormSummary {
  perRun: FormRunScore[];
  mean: { filled: number; correct: number; wrong: number; missed: number; overfilled: number; scored: number };
  fieldsFilledInAnyRun: number;
  unstableFields: Array<{ id: string; label: string; values: string[] }>;
  expectedIssues: Array<{ id: string; label: string; expect: Expect; values: string[]; outcomes: RunOutcome[] }>;
}

interface Summary {
  packet: string;
  label: string;
  generatedAt: string;
  runs: string[];
  settings: { extractionModes: string[]; assumptionLevels: string[]; contextReused: boolean };
  context: {
    perRun: Array<{ run: string; contextId?: string; error?: string; processId?: string; parties: string[]; factCount: number; requiredForms: string[] }>;
    factKeysUnion: number;
    factKeysInAllRuns: number;
    sharedFactValuesDiffering: number;
    requiredFormsDiffer: boolean;
  };
  forms: Record<string, FormSummary>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && argv[i + 1] !== undefined) args[argv[i].slice(2)] = argv[++i];
  }
  return args;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
}

function writeJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

/** pdftk's dump_data_fields encodes non-ASCII as XML numeric entities */
function decodeEntities(v: string): string {
  return v.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Comparison form: case-insensitive, whitespace-collapsed (fillForm wraps long text with newlines) */
function norm(v: string | undefined): string {
  return (v ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Any value other than blank / pdftk's "Off" */
function hasValue(v: string | undefined): boolean {
  const n = norm(v);
  return n !== "" && n !== "off";
}

const isBarcode = (id: string) => /barcode/i.test(id);

/**
 * What a field actually shows on the printed form: a checkbox is "on" only when
 * its value equals its own checked value; anything else in it prints unchecked.
 */
function effectiveValue(v: string | undefined, label: PdfFieldLabel | undefined): string {
  if (label?.type === "Button") return label.onValue && norm(v) === norm(label.onValue) ? "on" : "";
  return hasValue(v) ? norm(v) : "";
}

function canonical(v: string, match: ExpectedField["match"]): string {
  const n = norm(v);
  switch (match) {
    case "digits":
      return n.replace(/\D/g, "");
    case "number": {
      const digits = n.replace(/[^0-9.]/g, "");
      return digits === "" ? "" : String(Number(digits));
    }
    case "date": {
      const us = n.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
      const iso = n.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      return iso ? `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}` : n;
    }
    default:
      return n;
  }
}

function score(e: ExpectedField, actual: string | undefined, label: PdfFieldLabel | undefined): Outcome {
  const shown = effectiveValue(actual, label);
  if (typeof e.expect === "boolean") {
    if ((shown === "on") === e.expect) return "correct";
    return e.expect ? "missed" : "overfilled";
  }
  const accepted = (Array.isArray(e.expect) ? e.expect : [e.expect]).map((a) => canonical(a, e.match));
  const got = canonical(shown, e.match);
  if (e.match === "contains" ? accepted.some((a) => (a === "" ? got === "" : got.includes(a))) : accepted.includes(got)) {
    return "correct";
  }
  if (got === "") return "missed";
  if (accepted.every((a) => a === "")) return "overfilled";
  return "wrong";
}

const shortId = (id: string) => id.replace(/^form1\[0\]\./, "");
const tail = (s: string, n = 70) => (s.length > n ? "…" + s.slice(-n) : s);
const show = (v: string | undefined) => JSON.stringify(decodeEntities((v ?? "").replace(/\s+/g, " ").trim()));
const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  return "text/plain";
}

/**
 * Picks the beneficiaryKey for a form: the context's own requiredForms entry
 * when present (household forms carry none), otherwise the party whose name
 * contains the packet's beneficiary hint.
 */
function resolveBeneficiary(
  ctx: ISituationalContext,
  formId: string,
  hint: string
): { key?: string; inRequiredForms: boolean } {
  const entries = normalizeRequiredForms(ctx.requiredForms).filter((e) => e.formId === formId);
  if (entries.length > 0) {
    const match = entries.find((e) => e.beneficiaryKey?.toLowerCase().includes(hint.toLowerCase())) ?? entries[0];
    return { key: match.beneficiaryKey, inRequiredForms: true };
  }
  const key = Object.keys(ctx.partyData ?? {}).find((k) => k.toLowerCase().includes(hint.toLowerCase()));
  return { key, inRequiredForms: false };
}

// ─── Run ──────────────────────────────────────────────────────────────────────

async function fillOne(
  packet: Packet,
  ctx: ISituationalContext,
  contextId: string,
  formId: string,
  runDir: string,
  level?: AssumptionLevel
): Promise<void> {
  const { key, inRequiredForms } = resolveBeneficiary(ctx, formId, packet.beneficiary);
  const base = { formId, beneficiaryKey: key ?? null, inRequiredForms };
  const started = Date.now();
  try {
    const filled = await fillFormMap({
      formId,
      userId: packet.userId,
      situationalContextId: contextId,
      beneficiaryKey: key,
      ...(level ? { assumptionLevel: level } : {}),
    });
    const filledFormMapId = String((filled as any)._id);

    const result = await fillForm({
      formId,
      userId: packet.userId,
      filledFormMapId,
      formPdfPath: getBlankPdfPath(packet.processId, formId),
      outputDir: runDir,
    });
    const pdfPath = path.join(runDir, `${formId}.pdf`);
    let pdfValues: Record<string, string> | undefined;
    if (fs.existsSync(result.outputPath)) {
      fs.renameSync(result.outputPath, pdfPath);
      pdfValues = {};
      for (const [id, info] of extractFieldValues(pdfPath)) pdfValues[id] = decodeEntities(info.value);
    }

    const artifact: FormRunArtifact = {
      ...base,
      filledFormMapId,
      assumptionLevel: filled.assumptionLevel,
      durationMs: Date.now() - started,
      mapFields: filled.fields,
      skipped: filled.skipped,
      pdfValues,
      pdfErrors: result.errors,
    };
    writeJson(path.join(runDir, `${formId}.json`), artifact);
    console.log(`[eval] ✓ ${formId} filled (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(path.join(runDir, `${formId}.json`), { ...base, error: message } satisfies FormRunArtifact);
    console.error(`[eval] ✗ ${formId}: ${message}`);
  }
}

async function runOnce(
  packet: Packet,
  packetDir: string,
  forms: string[],
  runDir: string,
  opts: { contextId?: string; level?: AssumptionLevel }
): Promise<void> {
  fs.mkdirSync(runDir, { recursive: true });
  const extractionMode = (process.env.EXTRACTION_MODE ?? "").trim() || "monolithic";
  const started = Date.now();

  let ctx: ISituationalContext & { _id: unknown };
  try {
    if (opts.contextId) {
      const found = await SituationalContext.findById(opts.contextId).lean();
      if (!found) throw new Error(`SituationalContext not found: ${opts.contextId}`);
      ctx = found as unknown as ISituationalContext & { _id: unknown };
    } else {
      const uploadedFiles: UploadedFile[] = packet.documents.map((d) => ({
        path: path.join(packetDir, d.file),
        originalname: path.basename(d.file),
        mimetype: mimeFor(d.file),
      }));
      ctx = (await buildSituationContext({
        userId: packet.userId,
        uiAnswers: packet.uiAnswers,
        uploadedFiles,
        processIdHint: packet.processId,
      })) as ISituationalContext & { _id: unknown };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(path.join(runDir, "context.json"), { reused: !!opts.contextId, extractionMode, error: message } satisfies ContextRunArtifact);
    console.error(`[eval] ✗ situational context: ${message}`);
    return;
  }

  const contextId = String(ctx._id);
  writeJson(path.join(runDir, "context.json"), {
    situationalContextId: contextId,
    reused: !!opts.contextId,
    extractionMode,
    durationMs: opts.contextId ? undefined : Date.now() - started,
    processId: ctx.processId,
    situationSummary: ctx.situationSummary,
    requiredForms: normalizeRequiredForms(ctx.requiredForms),
    partyData: ctx.partyData,
  } satisfies ContextRunArtifact);
  console.log(`[eval] situational context ${contextId}${opts.contextId ? " (reused)" : ""} — filling ${forms.join(", ")}`);

  // Forms are independent, so fill them concurrently within a run
  await Promise.all(forms.map((formId) => fillOne(packet, ctx, contextId, formId, runDir, opts.level)));
}

// ─── Report ───────────────────────────────────────────────────────────────────

function listRunDirs(labelDir: string): string[] {
  if (!fs.existsSync(labelDir)) return [];
  return fs
    .readdirSync(labelDir)
    .filter((d) => /^run-\d+$/.test(d))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
}

function summarize(packet: Packet, packetDir: string, label: string, labelDir: string, forms: string[]): Summary {
  const runs = listRunDirs(labelDir);
  const contexts = runs.map((r) => readJson<ContextRunArtifact>(path.join(labelDir, r, "context.json")));

  // ── Situational context drift ──
  const factPaths = contexts.map((c) => {
    const m = new Map<string, string>();
    for (const [party, facts] of Object.entries(c.partyData ?? {})) {
      for (const [k, v] of Object.entries(facts ?? {})) m.set(`${party} › ${k}`, norm(JSON.stringify(v)));
    }
    return m;
  });
  const okFacts = factPaths.filter((_, i) => !contexts[i].error);
  const union = new Set(okFacts.flatMap((m) => [...m.keys()]));
  const inAll = [...union].filter((k) => okFacts.every((m) => m.has(k)));
  const differing = inAll.filter((k) => new Set(okFacts.map((m) => m.get(k))).size > 1);
  const formsLabel = (c: ContextRunArtifact) =>
    (c.requiredForms ?? []).map((e) => (e.beneficiaryKey ? `${e.formId}(${e.beneficiaryKey})` : e.formId));
  const requiredFormsSets = contexts.filter((c) => !c.error).map((c) => formsLabel(c).sort().join("|"));

  const summary: Summary = {
    packet: packet.id,
    label,
    generatedAt: new Date().toISOString(),
    runs,
    settings: {
      extractionModes: [...new Set(contexts.map((c) => c.extractionMode))],
      assumptionLevels: [],
      contextReused: contexts.some((c) => c.reused),
    },
    context: {
      perRun: contexts.map((c, i) => ({
        run: runs[i],
        contextId: c.situationalContextId,
        error: c.error,
        processId: c.processId,
        parties: Object.keys(c.partyData ?? {}),
        factCount: factPaths[i].size,
        requiredForms: formsLabel(c),
      })),
      factKeysUnion: union.size,
      factKeysInAllRuns: inAll.length,
      sharedFactValuesDiffering: differing.length,
      requiredFormsDiffer: new Set(requiredFormsSets).size > 1,
    },
    forms: {},
  };

  const levels = new Set<string>();
  for (const formId of forms) {
    const expectedPath = path.join(packetDir, "expected", `${formId}.json`);
    const expected = fs.existsSync(expectedPath) ? readJson<{ fields: ExpectedField[] }>(expectedPath).fields : [];
    const labels = readFieldLabels(getBlankPdfPath(packet.processId, formId));
    const labelFor = (id: string) => expected.find((e) => e.id === id)?.label ?? labels.get(id)?.tooltip ?? "";

    const artifacts = runs.map((r) => {
      const p = path.join(labelDir, r, `${formId}.json`);
      return fs.existsSync(p) ? readJson<FormRunArtifact>(p) : null;
    });

    const perRun: FormRunScore[] = artifacts.map((a, i) => {
      const s: FormRunScore = {
        run: runs[i],
        beneficiaryKey: a?.beneficiaryKey ?? null,
        inRequiredForms: a?.inRequiredForms ?? false,
        filled: 0, droppedValues: 0, invalidCheckboxValues: 0, scored: 0, correct: 0, wrong: 0, missed: 0, overfilled: 0,
      };
      if (!a || a.error || !a.pdfValues) {
        s.error = a?.error ?? (a ? `PDF not written: ${(a.pdfErrors ?? []).join("; ")}` : contexts[i].error ? "no situational context" : "form not run");
        return s;
      }
      if (a.assumptionLevel) levels.add(a.assumptionLevel);
      const pdf = a.pdfValues;
      s.filled = Object.entries(pdf).filter(([id, v]) => !isBarcode(id) && effectiveValue(v, labels.get(id)) !== "").length;
      s.droppedValues = Object.entries(a.mapFields ?? {}).filter(([id, v]) => v !== "" && !(id in pdf)).length;
      s.invalidCheckboxValues = Object.entries(pdf).filter(
        ([id, v]) => labels.get(id)?.type === "Button" && hasValue(v) && effectiveValue(v, labels.get(id)) === ""
      ).length;
      for (const e of expected) {
        if (e.unknown) continue;
        s.scored++;
        s[score(e, pdf[e.id], labels.get(e.id))]++;
      }
      return s;
    });

    // Consistency across successful runs
    const ok = artifacts.filter((a): a is FormRunArtifact => !!a?.pdfValues);
    const fieldIds = new Set(ok.flatMap((a) => Object.keys(a.pdfValues!)).filter((id) => !isBarcode(id)));
    const filledAny = [...fieldIds].filter((id) => ok.some((a) => effectiveValue(a.pdfValues![id], labels.get(id)) !== ""));
    const unstableFields =
      ok.length < 2
        ? []
        : filledAny
            .filter((id) => new Set(ok.map((a) => effectiveValue(a.pdfValues![id], labels.get(id)))).size > 1)
            .map((id) => ({ id, label: labelFor(id), values: ok.map((a) => a.pdfValues![id] ?? "") }));

    const expectedIssues = expected
      .filter((e) => !e.unknown)
      .map((e) => {
        const values = artifacts.map((a) => a?.pdfValues?.[e.id] ?? "");
        const outcomes: RunOutcome[] = artifacts.map((a, i) => (a?.pdfValues ? score(e, values[i], labels.get(e.id)) : "error"));
        return { id: e.id, label: e.label, expect: e.expect, values, outcomes };
      })
      // Only runs that produced a PDF say anything about a field; all-error forms are reported once per run instead
      .filter((x) => x.outcomes.some((o) => o !== "correct") && x.outcomes.some((o) => o !== "error"));

    const okScores = perRun.filter((s) => !s.error);
    summary.forms[formId] = {
      perRun,
      mean: {
        filled: mean(okScores.map((s) => s.filled)),
        scored: okScores[0]?.scored ?? expected.filter((e) => !e.unknown).length,
        correct: mean(okScores.map((s) => s.correct)),
        wrong: mean(okScores.map((s) => s.wrong)),
        missed: mean(okScores.map((s) => s.missed)),
        overfilled: mean(okScores.map((s) => s.overfilled)),
      },
      fieldsFilledInAnyRun: filledAny.length,
      unstableFields,
      expectedIssues,
    };
  }
  summary.settings.assumptionLevels = [...levels];
  return summary;
}

function renderReport(s: Summary, cap: number | null): string {
  const out: string[] = [];
  const limit = <T>(xs: T[]) => (cap === null ? xs : xs.slice(0, cap));
  const more = (n: number) => (cap !== null && n > cap ? [`      … ${n - cap} more in report.txt`] : []);

  out.push(`\n════ ${s.packet} / ${s.label} — ${s.runs.length} run(s) ════`);
  out.push(
    `EXTRACTION_MODE=${s.settings.extractionModes.join(",") || "?"} · assumptionLevel=${s.settings.assumptionLevels.join(",") || "?"} · ` +
      (s.settings.contextReused ? "situational context reused" : "situational context built per run")
  );

  out.push(`\nSITUATIONAL CONTEXT`);
  for (const r of s.context.perRun) {
    if (r.error) {
      out.push(`  ${r.run}  ✗ ${r.error}`);
      continue;
    }
    out.push(`  ${r.run}  ${r.contextId}  process=${r.processId}  parties=${r.parties.length}  facts=${r.factCount}`);
    out.push(`         parties: ${r.parties.join(" | ")}`);
    out.push(`         forms:   ${r.requiredForms.join(", ")}`);
  }
  if (s.runs.length > 1) {
    const pct = s.context.factKeysUnion ? Math.round((100 * s.context.factKeysInAllRuns) / s.context.factKeysUnion) : 100;
    out.push(
      `  fact keys in every run: ${s.context.factKeysInAllRuns}/${s.context.factKeysUnion} (${pct}%) · ` +
        `shared keys with differing values: ${s.context.sharedFactValuesDiffering} · ` +
        `requiredForms ${s.context.requiredFormsDiffer ? "DIFFER" : "identical"} across runs`
    );
  }

  out.push(`\nFORMS  (scored = expected fields not marked unknown; unstable = filled fields whose value differs between runs)`);
  out.push(`  ${"form".padEnd(8)} ${"filled per run".padEnd(22)} ${"correct".padEnd(13)} ${"wrong".padEnd(6)} ${"missed".padEnd(7)} ${"over".padEnd(6)} unstable`);
  for (const [formId, f] of Object.entries(s.forms)) {
    const filled = f.perRun.map((r) => (r.error ? "✗" : String(r.filled))).join(" · ");
    out.push(
      `  ${formId.padEnd(8)} ${filled.padEnd(22)} ${`${f.mean.correct}/${f.mean.scored}`.padEnd(13)} ${String(f.mean.wrong).padEnd(6)} ` +
        `${String(f.mean.missed).padEnd(7)} ${String(f.mean.overfilled).padEnd(6)} ${s.runs.length > 1 ? `${f.unstableFields.length}/${f.fieldsFilledInAnyRun}` : "-"}`
    );
  }

  for (const [formId, f] of Object.entries(s.forms)) {
    out.push(`\n── ${formId}`);
    for (const r of f.perRun) {
      if (r.error) out.push(`  ${r.run} ✗ ${r.error}`);
      if (r.droppedValues > 0) out.push(`  ${r.run} ⚠ ${r.droppedValues} filled value(s) target field IDs not in the PDF`);
      if (r.invalidCheckboxValues > 0) {
        out.push(`  ${r.run} ⚠ ${r.invalidCheckboxValues} checkbox(es) hold a value other than their checked value — they print unchecked`);
      }
      if (!r.error && !r.inRequiredForms) out.push(`  ${r.run} ⚠ not in the context's requiredForms — filled for "${r.beneficiaryKey ?? "(household)"}"`);
    }
    if (f.expectedIssues.length > 0) {
      out.push(`  expected fields not correct in every run (${f.expectedIssues.length}):`);
      for (const x of limit(f.expectedIssues)) {
        const runs = x.values.map((v, i) => `${show(v)} ${x.outcomes[i] === "correct" ? "✓" : x.outcomes[i]}`).join(" · ");
        out.push(`    ✗ ${shortId(x.id)}  ${tail(x.label)}`);
        out.push(`        expect ${JSON.stringify(x.expect)} → ${runs}`);
      }
      out.push(...more(f.expectedIssues.length));
    }
    const expectedIds = new Set(f.expectedIssues.map((x) => x.id));
    const otherUnstable = f.unstableFields.filter((u) => !expectedIds.has(u.id));
    if (otherUnstable.length > 0) {
      out.push(`  other fields that differ between runs (${otherUnstable.length}):`);
      for (const u of limit(otherUnstable)) {
        out.push(`    ~ ${shortId(u.id)}  ${tail(u.label)}`);
        out.push(`        ${u.values.map(show).join(" · ")}`);
      }
      out.push(...more(otherUnstable.length));
    }
  }
  return out.join("\n");
}

function renderComparison(base: Summary, cur: Summary): string {
  const out: string[] = [];
  const d = (a: number, b: number) => {
    const delta = Math.round((b - a) * 10) / 10;
    return `${a}→${b}${delta === 0 ? "" : ` (${delta > 0 ? "+" : ""}${delta})`}`;
  };
  out.push(`\nCOMPARE  ${base.label} (${base.runs.length} runs) → ${cur.label} (${cur.runs.length} runs)   [means per run]`);
  out.push(`  ${"form".padEnd(8)} ${"filled".padEnd(20)} ${"correct".padEnd(20)} ${"wrong".padEnd(16)} ${"missed".padEnd(16)} ${"over".padEnd(16)} unstable`);
  for (const formId of Object.keys(cur.forms)) {
    const a = base.forms[formId];
    const b = cur.forms[formId];
    if (!a) {
      out.push(`  ${formId.padEnd(8)} (not in ${base.label})`);
      continue;
    }
    out.push(
      `  ${formId.padEnd(8)} ${d(a.mean.filled, b.mean.filled).padEnd(20)} ${d(a.mean.correct, b.mean.correct).padEnd(20)} ` +
        `${d(a.mean.wrong, b.mean.wrong).padEnd(16)} ${d(a.mean.missed, b.mean.missed).padEnd(16)} ` +
        `${d(a.mean.overfilled, b.mean.overfilled).padEnd(16)} ${d(a.unstableFields.length, b.unstableFields.length)}`
    );
  }
  out.push(
    `  context fact keys in every run: ${base.context.factKeysInAllRuns}/${base.context.factKeysUnion} → ` +
      `${cur.context.factKeysInAllRuns}/${cur.context.factKeysUnion}`
  );
  return out.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.packet) {
    console.error(
      "\nUsage:\n  npm run eval -- --packet <id> [--runs 3] [--label <name>] " +
        "[--context <situationalContextId>] [--forms i-130,i-485] [--level liberal] [--compare <label>]\n"
    );
    process.exit(1);
  }

  const packetDir = path.join(PACKETS_ROOT, args.packet);
  const packet = readJson<Packet>(path.join(packetDir, "packet.json"));
  const forms = args.forms ? args.forms.split(",").map((f) => f.trim()).filter(Boolean) : packet.forms;
  const unknownForms = forms.filter((f) => !packet.forms.includes(f));
  if (unknownForms.length > 0) throw new Error(`Not in packet "${packet.id}": ${unknownForms.join(", ")}`);
  const runs = args.runs !== undefined ? Number(args.runs) : 1;
  const level = args.level as AssumptionLevel | undefined;
  if (level && !["conservative", "moderate", "liberal"].includes(level)) throw new Error(`Invalid --level "${level}"`);

  const label = args.label ?? new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  const labelDir = path.join(OUTPUT_ROOT, packet.id, label);
  fs.mkdirSync(labelDir, { recursive: true });

  if (runs > 0) {
    await connectDB();
    try {
      const existing = listRunDirs(labelDir).length;
      for (let i = 1; i <= runs; i++) {
        const runName = `run-${existing + i}`;
        console.log(`\n[eval] ═══ ${packet.id} / ${label} / ${runName} (${i}/${runs}) ═══`);
        await runOnce(packet, packetDir, forms, path.join(labelDir, runName), { contextId: args.context, level });
      }
    } finally {
      await disconnectDB();
    }
  }

  const summary = summarize(packet, packetDir, label, labelDir, forms);
  writeJson(path.join(labelDir, "summary.json"), summary);
  fs.writeFileSync(path.join(labelDir, "report.txt"), renderReport(summary, null) + "\n");
  console.log(renderReport(summary, CONSOLE_LIST_CAP));

  if (args.compare) {
    const basePath = path.join(OUTPUT_ROOT, packet.id, args.compare, "summary.json");
    if (!fs.existsSync(basePath)) throw new Error(`No summary for label "${args.compare}" at ${basePath}`);
    console.log(renderComparison(readJson<Summary>(basePath), summary));
  }
  console.log(`\n[eval] Output: ${labelDir}\n`);
}

main().catch((err) => {
  console.error("❌", err instanceof Error ? err.message : err);
  process.exit(1);
});
