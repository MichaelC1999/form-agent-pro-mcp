import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";
import { getAnthropicClient, CLAUDE_MODEL, REFUSAL_FALLBACK, throwIfRefused } from "../lib/anthropic";
import { FormMap } from "../models/FormMap";
import { FormContext } from "../models/FormContext";
import { logAnthropicResponse } from "../models/AnthropicLog";
import { listProcesses, getProcessReadme } from "../lib/processes";
import { readFieldLabels, type PdfFieldLabel } from "../lib/pdf";
import type {
  BuildFormContextInput,
  IFormContext,
  FormFieldContext,
  FormMetadata,
  FieldMap,
  FormScope,
} from "../types";

// ─── PDF text extraction ──────────────────────────────────────────────────────

async function extractPdfText(pdfPath: string): Promise<string> {
  const buffer = fs.readFileSync(pdfPath);
  const result = await pdfParse(buffer);
  return result.text.trim();
}

async function readContextFile(filePath: string): Promise<string> {
  return fs.readFileSync(filePath, "utf-8").trim();
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function renderCandidateProcesses(candidates: string[]): string {
  if (candidates.length === 0) {
    return "(No pre-configured processes are available. Use an empty applicableProcesses array unless you can confidently name a relevant identifier.)";
  }
  return candidates
    .map((id) => {
      const readme = getProcessReadme(id);
      return readme
        ? `- "${id}": ${readme.replace(/\n+/g, " ").trim()}`
        : `- "${id}"`;
    })
    .join("\n");
}

export function buildFormContextSystemPrompt(candidateProcessIds: string[]): string {
  const candidatesBlock = renderCandidateProcesses(candidateProcessIds);

  return `You are a senior paralegal and forms analyst with comprehensive knowledge of government form filing requirements across the US, EU, and other jurisdictions. You have deep familiarity with immigration forms (USCIS I-series, G-series, N-series, DOS forms, CBP forms), tax forms, social services forms, and similar government documents from other countries.

Your task is to produce a FormContext — a structured, detailed knowledge base for every field in a specific government form. A downstream AI agent will use this FormContext to automatically match real applicant data to the correct fields when filling the form. The quality and specificity of your output directly determines how accurately that agent can auto-fill the form without human review.

You will be given:
1. The raw PDF form file attached as a document — read it directly as a human would, taking in the visual layout, section headers, printed instructions, question labels, eligibility conditions, certification language, and all remarks.
2. The complete visible text extracted from that same PDF in plain text — a complementary reference that is easier to search but may be incomplete or mis-ordered due to PDF layout.
3. A list of every fillable field ID extracted from the PDF, each with the tooltip the PDF attaches to that field and, for checkboxes, the value the box writes when checked.
4. Optionally, supplemental reference files (official form instructions, policy documents, markdown guides).

─────────────────────────────────────────────────────────────────────────────
FIELD LABELS ARE AUTHORITATIVE
─────────────────────────────────────────────────────────────────────────────

A field's PDF tooltip states which question — and, for checkboxes, which answer option — that specific field represents. Use it to identify the field.

- Never infer a checkbox's answer option from its index ([0], [1], …) or from the order the options are printed on the page. Field indexes do not follow visual order.
- A checked value is an export code, not a label — a "No" box may write "Y", and Sex boxes may write "N"/"Y". Identify the option from the tooltip.
- Only when two boxes for the same question have identical tooltips, use the checked value to tell them apart ("Y" = Yes, "N" = No).

─────────────────────────────────────────────────────────────────────────────
KNOWLEDGE INSTRUCTIONS
─────────────────────────────────────────────────────────────────────────────

Use the attached raw PDF as your primary source — read it as a human would, taking in the visual layout, section groupings, printed labels, and instruction blocks. The extracted plain text is a complementary reference.

Beyond what is in the PDF, draw freely on your training knowledge of this form:
- Official form instructions published by the issuing agency
- Agency policy guidance, technical instructions, and field office memos
- Common filing practices and known problem areas for this specific form
- Legal definitions and regulatory citations relevant to the form's purpose
- How this form fits into the broader filing package and immigration process

When the PDF text is ambiguous or incomplete for a given field, use your knowledge of the form to fill the gap — but aim for the same specificity as if you had the full official instructions in front of you.

─────────────────────────────────────────────────────────────────────────────
PART A — FORM METADATA
─────────────────────────────────────────────────────────────────────────────

Output a "formMetadata" object with these keys:

"purpose"
  One precise sentence: what legal action does submitting this form initiate, and who files it?

"situations"
  The specific immigration scenarios, visa categories, legal statuses, and life circumstances that require this form. Reference INA sections, CFR citations, or policy categories where relevant.

"use-cases"
  Concrete applicant profiles and event sequences that result in this form being filed. Include common cases and meaningful edge cases.

"filing-context"
  How this form fits into the broader filing package: what other forms it is typically filed with, what supporting evidence accompanies it, which USCIS office or process receives it, and any filing deadlines or sequencing constraints.

"parties-involved"
  Every distinct party role that appears on this form, with a one-sentence description of that role specific to this form's context.

"scope"
  Exactly one of:
    "per-beneficiary" — this form is filed once per individual beneficiary (typical for applications and petitions specific to one person).
    "household"       — a single filing covers the whole sponsor unit or applicant household (typical for affidavits, sponsor declarations, family-wide applications).
  Use your knowledge of how this specific form is filed — do not guess.

─────────────────────────────────────────────────────────────────────────────
PART B — APPLICABLE PROCESSES
─────────────────────────────────────────────────────────────────────────────

Output an "applicableProcesses" array of process identifiers this form belongs to. A form may belong to more than one process.

Candidate processes (filesystem-discovered):

${candidatesBlock}

Rules:
- Include each candidate process identifier only if this form is genuinely used in that process.
- If the form belongs to a process not listed above, include a short kebab-case identifier you invented (e.g. "k1-fiance").
- If you cannot confidently associate the form with any process, return an empty array.

─────────────────────────────────────────────────────────────────────────────
PART C — FIELD ANNOTATIONS
─────────────────────────────────────────────────────────────────────────────

For every field ID in the input list, produce one entry. Do not skip or merge fields.

"field"
  Copy the field ID verbatim — no changes.

"description"
  The most specific, actionable description you can write for this field. Read the attached PDF to find the exact question label, section header, or instruction text that corresponds to this field — that is your starting point.

  - For text fields: state exactly what data goes here, in what format, from which source document, and the legal or practical meaning of the value.
  - For checkbox/button fields: include the COMPLETE question or label text as it is printed on the form — not a paraphrase — and state the specific answer option this box represents, taken from its tooltip and checked value. Then explain what selecting it means or triggers.
  - For signature/date-of-signature fields: include the full certification language the signature attests to, plus any timing instruction from the form (e.g. "Do not sign until instructed by the civil surgeon").
  - For barcode/system fields: note they are administrative and require no applicant input.

"party"
  Which party's data or action populates this field. Determine this from the section headers and part titles visible in the PDF. Use one of:
    "Applicant", "Petitioner", "Preparer", "Interpreter", "Civil Surgeon",
    "Sponsor", "Joint Sponsor", "Child", "N/A"

"notes"
  Specific edge cases and considerations for an automated filling agent:
  - Authoritative source document for this value
  - Formatting constraints (date format, character limits, all caps, etc.)
  - Blank vs. "None" behavior
  - Conditional requirements or eligibility gates
  - For checkboxes: downstream consequences of each selection
  - Common mistakes on this specific field

─────────────────────────────────────────────────────────────────────────────
REASONING
─────────────────────────────────────────────────────────────────────────────

Before writing each field entry, reason through:
1. Which part/section of the form is this field in, and what is that section collecting?
2. Which party owns this section?
3. What real-world data — from which document or life event — fills this field?
4. What could go wrong if this field is filled incorrectly or left blank?

Do not output the reasoning — let it drive the quality of descriptions and notes.

─────────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────────────────

Return a single valid JSON object. No markdown fences. No commentary outside the JSON.

{
  "formMetadata": {
    "purpose": "...",
    "situations": "...",
    "use-cases": "...",
    "filing-context": "...",
    "parties-involved": "...",
    "scope": "per-beneficiary" | "household"
  },
  "applicableProcesses": ["<processId>", "..."],
  "fields": [
    {
      "field": "<exact field ID>",
      "description": "...",
      "party": "...",
      "notes": "..."
    }
  ]
}`;
}

/**
 * Builds the text block of the user message.
 * The raw PDF is sent as a separate document block in the Anthropic content array.
 * Exported for debugging via getFormContextPromptText.
 */
export function buildFormContextUserMessage(params: {
  formId: string;
  formPdfText: string;
  fieldIds: string[];
  contextFileContents: Array<{ name: string; content: string }>;
  pdfAttached: boolean;
  /** Tooltip + checked value per field ID, read from the blank PDF. */
  fieldLabels?: Map<string, PdfFieldLabel>;
  /** Set when a large form is annotated in several calls. */
  batch?: { index: number; count: number; totalFields: number };
}): string {
  const { formId, formPdfText, fieldIds, contextFileContents, pdfAttached, fieldLabels, batch } = params;
  const parts: string[] = [];
  const hr = "─".repeat(72);

  parts.push(`FORM: ${formId}  |  ${fieldIds.length} fields to annotate`);
  parts.push(hr);

  // ── PDF attachment reference ───────────────────────────────────────────────
  if (pdfAttached) {
    parts.push(
      `The raw PDF is attached above. Read it as your primary source — use the visual layout,\n` +
      `section groupings, and printed text to understand what each field is asking for.`
    );
    parts.push(hr);
  }

  // ── Extracted plain text ───────────────────────────────────────────────────
  parts.push(`EXTRACTED FORM TEXT`);
  if (formPdfText.length > 0) {
    parts.push(`Plain-text complement to the attached PDF. May be incomplete or mis-ordered.`);
    parts.push(hr);
    parts.push(formPdfText);
  } else {
    parts.push(
      `[No text extracted — PDF may be scanned or image-only.]\n` +
      `Rely on the attached PDF and your training knowledge of form "${formId}".`
    );
  }

  // ── Supplemental context files ─────────────────────────────────────────────
  if (contextFileContents.length > 0) {
    parts.push(`\n${hr}`);
    parts.push(`SUPPLEMENTAL REFERENCE DOCUMENTS`);
    parts.push(hr);
    for (const ctx of contextFileContents) {
      parts.push(`\n[${ctx.name}]\n${ctx.content}`);
    }
  }

  // ── Field ID list ──────────────────────────────────────────────────────────
  parts.push(`\n${hr}`);
  parts.push(`FIELD IDs  (${fieldIds.length} total — annotate every one)`);
  if (batch) {
    parts.push(
      `This request is batch ${batch.index} of ${batch.count}. The form has ${batch.totalFields} fields in total;\n` +
      `annotate only the field IDs listed below. Still return formMetadata and applicableProcesses\n` +
      `describing the whole form.`
    );
  }
  if (fieldLabels && fieldLabels.size > 0) {
    parts.push(`Each field ID is followed by its PDF tooltip and, for checkboxes, the value the box writes when checked.`);
  }
  parts.push(hr);
  parts.push(
    fieldIds
      .map((id) => {
        const label = fieldLabels?.get(id);
        if (!label) return id;
        const lines = [id];
        if (label.tooltip) lines.push(`  tooltip: ${label.tooltip}`);
        if (label.onValue) lines.push(`  checked value: ${label.onValue}`);
        return lines.join("\n");
      })
      .join("\n")
  );

  // ── Final instruction ──────────────────────────────────────────────────────
  parts.push(`\n${hr}`);
  parts.push(
    `Produce the FormContext JSON now. For each field ID above, start from its PDF tooltip and\n` +
    `checked value, then locate its question in the attached PDF. For checkboxes and questions,\n` +
    `include the complete printed text — not a paraphrase. Use your knowledge of "${formId}" to\n` +
    `fill any gaps. Annotate every field.`
  );

  return parts.join("\n");
}

/**
 * Returns the exact system prompt + user message text without calling Anthropic.
 * Use for debugging (PRINT_PROMPT=1 CLI mode, /prompt API endpoint).
 * Note: in the real call the PDF is also sent as a document block.
 */
export async function getFormContextPromptText(input: BuildFormContextInput): Promise<{
  systemPrompt: string;
  userMessage: string;
}> {
  const { formId, formPdfPath, contextFilePaths = [], candidateProcessIds } = input;
  const resolvedCandidates =
    candidateProcessIds && candidateProcessIds.length > 0
      ? candidateProcessIds
      : listProcesses();

  const formMapDoc = await FormMap.findOne({ formId }).sort({ createdAt: -1 });
  if (!formMapDoc) {
    throw new Error(`No FormMap found for formId "${formId}". Run buildFormMap first.`);
  }

  const storedFieldIds = Object.keys(formMapDoc.fields as FieldMap);
  const pdfExists = fs.existsSync(formPdfPath);
  const formPdfText = pdfExists ? await extractPdfText(formPdfPath) : "";
  const fieldIds = storedFieldIds;

  const contextFileContents: Array<{ name: string; content: string }> = [];
  for (const filePath of contextFilePaths) {
    if (fs.existsSync(filePath)) {
      contextFileContents.push({
        name: path.basename(filePath),
        content: await readContextFile(filePath),
      });
    }
  }

  return {
    systemPrompt: buildFormContextSystemPrompt(resolvedCandidates),
    userMessage: buildFormContextUserMessage({
      formId,
      formPdfText,
      fieldIds,
      contextFileContents,
      pdfAttached: pdfExists,
      fieldLabels: pdfExists ? readFieldLabels(formPdfPath) : undefined,
    }),
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

/** Fields annotated per Anthropic call; larger forms are split into batches. */
const FIELDS_PER_BATCH = 250;

interface ParsedFormContext {
  formMetadata: FormMetadata;
  fields: FormFieldContext[];
  applicableProcesses?: string[];
}

export async function buildFormContext(input: BuildFormContextInput): Promise<IFormContext> {
  const { formId, formPdfPath, contextFilePaths = [], candidateProcessIds } = input;
  const resolvedCandidates =
    candidateProcessIds && candidateProcessIds.length > 0
      ? candidateProcessIds
      : listProcesses();

  // 1. Load FormMap — field IDs used as fallback if pdftk unavailable
  const formMapDoc = await FormMap.findOne({ formId }).sort({ createdAt: -1 });
  if (!formMapDoc) {
    throw new Error(`No FormMap found for formId "${formId}". Run buildFormMap first.`);
  }
  const storedFieldIds = Object.keys(formMapDoc.fields as FieldMap);
  if (storedFieldIds.length === 0) {
    throw new Error(`FormMap for "${formId}" has no fields. Ensure buildFormMap completed successfully.`);
  }

  // 2. Validate PDF path
  if (!fs.existsSync(formPdfPath)) {
    throw new Error(`Form PDF not found: ${formPdfPath}`);
  }

  // 3. Extract visible text
  const formPdfText = await extractPdfText(formPdfPath);
  console.log(`[buildFormContext] PDF text: ${formPdfText.length} chars`);

  // 4. Field IDs — always use the FormMap stored in MongoDB.
  //    buildFormMap uses a multi-strategy extraction (page-annotation walk +
  //    pdftk + pdf-lib merge) that captures orphaned widget fields missed by
  //    pdftk dump_data_fields alone. Re-running pdftk here would undo that work.
  const fieldIds = storedFieldIds;
  console.log(`[buildFormContext] Fields: ${fieldIds.length} (from FormMap in MongoDB)`);

  // 5. Read supplemental context files
  const contextFileContents: Array<{ name: string; content: string }> = [];
  for (const filePath of contextFilePaths) {
    if (fs.existsSync(filePath)) {
      contextFileContents.push({
        name: path.basename(filePath),
        content: await readContextFile(filePath),
      });
    } else {
      console.warn(`[buildFormContext] Skipping missing context file: ${filePath}`);
    }
  }

  // 6. Read each field's tooltip + checked value from the PDF. These identify
  //    which question and answer option a field is — without them the model
  //    guesses checkbox options from field index, which doesn't follow the
  //    printed order.
  const fieldLabels = readFieldLabels(formPdfPath);
  const labeledCount = fieldIds.filter((id) => fieldLabels.get(id)?.tooltip).length;
  console.log(`[buildFormContext] PDF tooltips: ${labeledCount}/${fieldIds.length} fields`);

  // 7. Split large forms into batches. Annotations run ~260 output tokens per
  //    field, so one call tops out around 450 fields under the 128k cap; a
  //    form above FIELDS_PER_BATCH is annotated in several calls and merged.
  const systemPrompt = buildFormContextSystemPrompt(resolvedCandidates);
  const pdfBase64 = fs.readFileSync(formPdfPath).toString("base64");
  const batches: string[][] = [];
  for (let i = 0; i < fieldIds.length; i += FIELDS_PER_BATCH) {
    batches.push(fieldIds.slice(i, i + FIELDS_PER_BATCH));
  }

  const client = getAnthropicClient();
  console.log(
    `[buildFormContext] Calling ${CLAUDE_MODEL} for "${formId}" — ` +
    `${fieldIds.length} fields${batches.length > 1 ? ` in ${batches.length} batches` : ""}, ` +
    `${formPdfText.length} chars extracted text, ` +
    `PDF attached (${(pdfBase64.length * 0.75 / 1024).toFixed(0)} KB), ` +
    `${contextFileContents.length} supplemental file(s). May take several minutes...`
  );

  const annotateBatch = async (batchFieldIds: string[], index: number): Promise<ParsedFormContext> => {
    const userTextBlock = buildFormContextUserMessage({
      formId,
      formPdfText,
      fieldIds: batchFieldIds,
      contextFileContents,
      pdfAttached: true,
      fieldLabels,
      ...(batches.length > 1
        ? { batch: { index: index + 1, count: batches.length, totalFields: fieldIds.length } }
        : {}),
    });

    // Streaming is required here — max_tokens (128000) exceeds the SDK's
    // non-streaming timeout threshold (~21333 tokens), and a non-streaming
    // call above that throws AnthropicError before any request is sent.
    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 128000,
      output_config: { effort: "high" },
      ...REFUSAL_FALLBACK,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdfBase64,
              },
              title: `Form ${formId}`,
              // The PDF is identical across batches; later batches read it from cache.
              ...(batches.length > 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
            },
            {
              type: "text",
              text: userTextBlock,
            },
          ],
        },
      ],
    });
    const response = await stream.finalMessage();

    // Log full response payload to MongoDB (non-blocking)
    logAnthropicResponse(response, { service: "buildFormContext", formId });
    throwIfRefused(response, "buildFormContext");

    const label = batches.length > 1 ? ` (batch ${index + 1}/${batches.length})` : "";
    if (response.stop_reason === "max_tokens") {
      throw new Error(
        `Form context response for "${formId}"${label} hit the output limit. Lower FIELDS_PER_BATCH.`
      );
    }

    const rawBlock = response.content.find((b) => b.type === "text");
    const rawJson = rawBlock?.type === "text" ? rawBlock.text.trim() : "";
    const cleaned = rawJson.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();
    try {
      return JSON.parse(cleaned) as ParsedFormContext;
    } catch {
      throw new Error(`Failed to parse form context response for "${formId}"${label}.`);
    }
  };

  // The first batch runs alone so it writes the PDF to the prompt cache; the
  // rest then run in parallel and read it.
  const results: ParsedFormContext[] = [await annotateBatch(batches[0], 0)];
  if (batches.length > 1) {
    results.push(...(await Promise.all(batches.slice(1).map((b, i) => annotateBatch(b, i + 1)))));
  }

  // 8. Merge: form-level fields come from the first batch; processes are unioned.
  const parsed: ParsedFormContext = {
    formMetadata: results[0].formMetadata,
    // Keep only the fields each batch was given, so a batch that strays can't duplicate another's.
    fields: results.flatMap((r, i) => {
      const own = new Set(batches[i]);
      return (Array.isArray(r.fields) ? r.fields : []).filter((f) => own.has(f.field));
    }),
    applicableProcesses: results.flatMap((r) =>
      Array.isArray(r.applicableProcesses) ? r.applicableProcesses : []
    ),
  };

  // Normalize applicableProcesses: trim, drop empties, dedupe
  const applicableProcesses = Array.isArray(parsed.applicableProcesses)
    ? Array.from(
        new Set(
          parsed.applicableProcesses
            .map((id) => (typeof id === "string" ? id.trim() : ""))
            .filter((id) => id.length > 0)
        )
      )
    : [];

  // Normalize scope to the typed union; leave undefined when missing
  const rawScope = (parsed.formMetadata as Record<string, unknown> | undefined)?.scope;
  const scope: FormScope | undefined =
    rawScope === "per-beneficiary" || rawScope === "household"
      ? (rawScope as FormScope)
      : undefined;
  if (scope) {
    (parsed.formMetadata as Record<string, unknown>).scope = scope;
  }

  // 9. Warn about any skipped field IDs
  const expectedIds = new Set(fieldIds);
  const returnedIds = new Set(parsed.fields.map((f) => f.field));
  const missing = [...expectedIds].filter((id) => !returnedIds.has(id));
  if (missing.length > 0) {
    console.warn(
      `[buildFormContext] LLM skipped ${missing.length}/${fieldIds.length} fields:`,
      missing.slice(0, 10).join(", "),
      missing.length > 10 ? `...and ${missing.length - 10} more` : ""
    );
  } else {
    console.log(`[buildFormContext] ✅ All ${fieldIds.length} fields annotated.`);
  }

  // 10. Persist
  const doc = await FormContext.create({
    formId,
    createdAt: new Date(),
    formMetadata: parsed.formMetadata ?? {},
    fields: parsed.fields ?? [],
    ...(applicableProcesses.length > 0 ? { applicableProcesses } : {}),
  });

  console.log(
    `[buildFormContext] applicableProcesses=[${applicableProcesses.join(", ")}]` +
    (scope ? `, scope=${scope}` : "")
  );

  return doc.toObject() as IFormContext;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI:
 *   npx ts-node src/services/buildFormContext.ts <formId> <pdfPath> [contextFile ...]
 *   PRINT_PROMPT=1 npx ts-node src/services/buildFormContext.ts <formId> <pdfPath>
 */
if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    const [, , formId, formPdfPath, ...contextFilePaths] = process.argv;
    if (!formId || !formPdfPath) {
      console.error("Usage: ts-node buildFormContext.ts <formId> <pdfPath> [contextFile ...]");
      console.error("       PRINT_PROMPT=1 ts-node buildFormContext.ts <formId> <pdfPath>");
      process.exit(1);
    }

    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    if (process.env.PRINT_PROMPT === "1") {
      try {
        const { systemPrompt, userMessage } = await getFormContextPromptText({
          formId, formPdfPath, contextFilePaths,
        });
        console.log("\n========== SYSTEM PROMPT ==========\n");
        console.log(systemPrompt);
        console.log("\n========== USER MESSAGE ==========\n");
        console.log(userMessage);
      } catch (err) {
        console.error("❌", err instanceof Error ? err.message : err);
        await disconnectDB();
        process.exit(1);
      }
      await disconnectDB();
      process.exit(0);
    }

    try {
      const result = await buildFormContext({ formId, formPdfPath, contextFilePaths });
      console.log(`\n✅ FormContext saved for "${result.formId}"`);
      console.log(`   Fields annotated : ${result.fields.length}`);
      console.log(`   Purpose          : ${result.formMetadata.purpose}`);
      console.log(`   MongoDB _id      : ${(result as any)._id}\n`);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      await disconnectDB();
      process.exit(1);
    }

    await disconnectDB();
    process.exit(0);
  })();
}
