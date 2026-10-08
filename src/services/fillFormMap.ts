import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, CLAUDE_MODEL, REFUSAL_FALLBACK, throwIfRefused } from "../lib/anthropic";
import { readFieldLabels } from "../lib/pdf";
import { FormMap } from "../models/FormMap";
import { FormContext } from "../models/FormContext";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { logAnthropicResponse } from "../models/AnthropicLog";
import { ClaudeContentError, ClaudeParseError } from "../models/AppError";
import { resolveProcessId, getProcessReadme, listProcessLanguages, getBlankPdfPath } from "../lib/processes";
import type {
  FillFormMapInput,
  IFilledFormMap,
  IFormMap,
  IFormContext,
  ISituationalContext,
  AssumptionLevel,
  FieldMap,
  FieldMeta,
  SkippedField,
} from "../types";

// ─── Prompt builders ──────────────────────────────────────────────────────────

/**
 * Describes to the LLM how liberally to reason about ambiguous or partially
 * applicable information, keyed by assumptionLevel.
 */
const ASSUMPTION_INSTRUCTIONS: Record<AssumptionLevel, string> = {
  conservative: `ASSUMPTION LEVEL: CONSERVATIVE
- Only populate a field when the situational context contains an explicit, direct match to that field's description.
- If the information is inferred, derived, or exists in an analogous but not exact form, leave the field blank ("").
- When in doubt, leave it blank. A blank field is safer than a wrong one.
- You may still apply light formatting — e.g. normalizing a date to MM/DD/YYYY if the value is clearly present.`,

  moderate: `ASSUMPTION LEVEL: MODERATE
- Populate a field when the situational context contains an explicit match OR a reasonably close inference.
- A "reasonably close inference" means the data is present in spirit, even if not phrased identically — e.g. a full legal name split across a first/last field, or a country-of-birth derived from a passport nationality.
- When genuinely uncertain whether a value applies, leave the field blank and log it in the "skipped" array.
- Avoid pure speculation. If multiple plausible values exist, choose the one that most directly satisfies the field's description and notes.`,

  liberal: `ASSUMPTION LEVEL: LIBERAL
- Populate as many fields as possible, using data, reasonable inference, and contextually supported derivation.
- Derive values when the source material implies them — e.g. "No middle name" for an empty middle-name slot, a state derived from a city, or an alien number inferred from a receipt notice.
- Cross-reference multiple parties and sources when a single source is insufficient.
- Only leave a field blank if absolutely no supporting information exists anywhere in the situational context.
- Prioritize completeness. Note any derived or inferred values in the "skipped" array with a brief reason.`,
};

/**
 * Produces the full system prompt for the fill-form-map Anthropic call.
 * The prompt is designed to be flexible to the user's actual situation while
 * staying anchored to relevancy — it will never hallucinate data that has no
 * basis in the situational context.
 */
function buildSystemPrompt(
  assumptionLevel: AssumptionLevel,
  beneficiaryKey?: string,
  processContext?: { processId: string; readme: string | null; languages: string[] | null }
): string {
  const beneficiaryScope = beneficiaryKey
    ? `

─────────────────────────────────────────────────────────────────────────────
BENEFICIARY SCOPE — CRITICAL
─────────────────────────────────────────────────────────────────────────────

This form is being filled for the beneficiary identified by the key "${beneficiaryKey}" in the SITUATIONAL CONTEXT's partyData object.

- For any field whose Party is the beneficiary/applicant, you MUST use ONLY the data under partyData["${beneficiaryKey}"].
- For fields whose Party is the petitioner/sponsor/preparer, use that party's data as found in the situational context (typically a single petitioner shared across all beneficiaries).
- Data belonging to OTHER beneficiaries (other top-level party keys that look like beneficiaries — children, siblings, other dependents of the same petitioner) MUST be ignored. Do NOT mix names, dates, document numbers, or biographic attributes between beneficiaries.
- If the situational context contains no data under partyData["${beneficiaryKey}"], or that party clearly does not match the form's intended beneficiary, follow the ERROR PATH below with code "missing_required_party".`
    : "";

  const processBlock = processContext
    ? `

─────────────────────────────────────────────────────────────────────────────
PROCESS CONTEXT
─────────────────────────────────────────────────────────────────────────────

This form is being filled as part of the "${processContext.processId}" process.${
        processContext.readme ? `\n${processContext.readme.replace(/\n+/g, " ").trim()}` : ""
      }${
        processContext.languages && processContext.languages.length > 0
          ? `\nDocuments in this filing are expected to be in: ${processContext.languages.join(", ")}. Names and proper nouns from the source documents may appear in any of these languages — preserve original spelling unless a field's notes explicitly require translation.`
          : ""
      }`
    : "";

  return `You are an expert form-filling agent. Your job is to match real applicant and situational data to the correct fields on a government form.${processBlock}${beneficiaryScope}

You will be given two inputs:
1. FORM CONTEXT — A structured knowledge base describing every field on the form. For each field you will see: its exact field ID, a precise description of what it asks for, which party it belongs to (Applicant, Petitioner, Preparer, etc.), and notes on formatting, edge cases, and sources.
2. SITUATIONAL CONTEXT — A structured JSON object containing all known information about the parties involved and the applicant's immigration situation, extracted from their documents and self-reported answers.

─────────────────────────────────────────────────────────────────────────────
CORE OBJECTIVE
─────────────────────────────────────────────────────────────────────────────

For every field ID present in the FORM CONTEXT, determine whether the situational context contains information that satisfies what that field is asking for. If it does, extract and format the value precisely. If it does not, the value must be an empty string ("").

Your output "fields" array must contain one entry for every single field ID listed in the FORM CONTEXT — no more, no less. Every field ID must appear exactly once. There are no optional entries.

RELEVANCY IS THE HIGHEST PRIORITY
- Always ask: "Does the situational context contain something that answers this field?"
- A field should be filled if the data is relevant to BOTH the field's meaning AND this applicant's specific situation.
- Fields that belong to a party not present in this situation must be left blank
- Do not invent, hallucinate, or guess data that is not represented anywhere in the situational context.

FLEXIBILITY WITHIN RELEVANCY
- The situational context may use different phrasing, structure, or language than the form field. Use your knowledge of immigration forms and the field's description + notes to bridge these gaps.
- A value does not need to be a character-for-character match. It must be a factually supported, contextually appropriate answer to what the field is asking.
- Cross-reference related fields. A field asking for "Family Name" and one asking for "Last Name" should both draw from the same name data.

${ASSUMPTION_INSTRUCTIONS[assumptionLevel]}

─────────────────────────────────────────────────────────────────────────────
FORMATTING RULES
─────────────────────────────────────────────────────────────────────────────

- Dates: Match the format specified in the field's notes. Default to MM/DD/YYYY unless instructed otherwise.
- Names: Use the exact spelling from the source document. Do not translate or alter proper nouns.
- Checkboxes: Use exactly "1" for checked/yes and "0" for unchecked/no. Determine the correct value from the field's description and the applicant's situation.
  A Yes/No question has one checkbox per answer — put "1" in the box whose description matches the true answer. Never write "Y", "N", "Yes", "No", or other text into a checkbox.
- Field tags: some field IDs are followed by a tag in parentheses giving the PDF's input constraint.
  (checkbox) — only "1" or "0".
  (max N chars) — the PDF cuts off anything longer. Enter phone numbers, SSNs, A-Numbers, receipt numbers, and I-94 numbers as digits only — no dashes, spaces, or parentheses.
  (dropdown: …) — only one of the listed values or codes, written exactly as listed (e.g. "OH", "B2").
- Numbers and IDs: Reproduce exactly as they appear in the source — preserve leading zeros, dashes, and spacing.
- "N/A" vs blank: Use "N/A" only when the field's notes explicitly say to write N/A for inapplicable entries. Otherwise use "".
- Country names: Use the full English country name (e.g. "Germany", not "DEU"; "Philippines", not "PHL").
- State abbreviations: Use the standard two-letter postal abbreviation (e.g. "FL", "CA").
- All-caps fields: If the field's notes specify all caps, convert the value to uppercase.

─────────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────────────────

Return a single valid JSON object with this exact shape — no markdown fences, no text outside the JSON:

{
  "fields": [
    { "fieldId": "<fieldId>", "value": "<value or empty string>" }
  ],
  "skipped": [
    {
      "fieldId": "<fieldId>",
      "reason": "<brief explanation of why the field was left blank or flagged>"
    }
  ]
}

- "fields" must contain one entry for every field ID from the FORM CONTEXT — every single one, including those left blank.
- "skipped" should include any field where you were uncertain, found conflicting data, or applied an inference that may need human review. This is an audit log, not a penalty.

─────────────────────────────────────────────────────────────────────────────
ERROR PATH — MANDATORY
─────────────────────────────────────────────────────────────────────────────

If, AT ANY POINT, you determine that you CANNOT produce a usable filled form
map — for example because:
  • The FORM CONTEXT is empty, malformed, or appears to describe a different
    form than the SITUATIONAL CONTEXT references.
  • The SITUATIONAL CONTEXT contains no information about any party that this
    form applies to (e.g. you are filling an I-130 but no petitioner exists).
  • The two contexts are fundamentally incompatible (e.g. asked to fill a
    naturalization form when the situational context describes a marriage
    petition with no green-card holder).
  • Both inputs are present but produce zero defensible fills — i.e. literally
    every field would have to be blank, making the output meaningless.
  • Any other ambiguity makes a high-quality response impossible.

YOU MUST NOT GUESS, FABRICATE FIELDS, OR RETURN AN ALL-BLANK FIELD MAP.

Instead, return — and return ONLY — the following JSON object, with no
markdown fences and no explanation outside the JSON:

{
  "error": {
    "code": "<short_snake_case_code>",
    "message": "<one-sentence plain-English description of why you cannot fill this form>",
    "details": "<optional second sentence describing what would be needed to succeed>"
  }
}

Valid examples of "code":
  insufficient_context, missing_required_party, form_context_mismatch,
  empty_form_context, incompatible_form, conflicting_data

This error shape is the ONLY acceptable response when you cannot produce a
meaningful fill. Do not return the "fields" shape with every value blank in
place of this error object — that is a forbidden output.`;
}

/**
 * Builds the part of the user turn shared by every batch of a form: the
 * situational context, any matching user clarifications, and the form
 * metadata. Sent as its own cached block when a form is filled in batches.
 */
function buildSharedContext(params: {
  formContext: IFormContext;
  situationalContext: ISituationalContext;
  beneficiaryKey?: string;
}): string {
  const { formContext, situationalContext, beneficiaryKey } = params;
  const hr = "─".repeat(72);
  const parts: string[] = [];

  // ── 1. Situational context (first — it sets the stage) ────────────────────
  parts.push(hr);
  parts.push(`SITUATIONAL CONTEXT  |  userId: ${situationalContext.userId}`);
  parts.push(hr);
  parts.push(`Situation Summary:\n${situationalContext.situationSummary}`);
  parts.push(`\nParty & Situational Data:\n${JSON.stringify(situationalContext.partyData, null, 2)}`);

  // ── 1b. Additional user-provided context (from retry-form attempts) ───────
  // The retry-form flow on the report page lets the user supply more text and
  // documents when a fill failed. Each saved entry is scoped to a specific
  // (formId, beneficiaryKey) pair — we only inject the entries that match the
  // current fill so we don't bleed unrelated clarifications into the prompt.
  const matchingAdditional = (situationalContext.additionalContexts ?? []).filter((ac) => {
    if (ac.formId !== formContext.formId) return false;
    const acKey = ac.beneficiaryKey ?? undefined;
    return acKey === beneficiaryKey;
  });
  if (matchingAdditional.length > 0) {
    parts.push(`\n${hr}`);
    parts.push(
      `ADDITIONAL USER-PROVIDED CONTEXT  |  ${matchingAdditional.length} clarification(s) the user attached AFTER an earlier fill attempt for this form`
    );
    parts.push(hr);
    parts.push(
      "Treat these clarifications as authoritative — they were provided specifically to resolve gaps or errors in a prior generation of this form. If they conflict with the situational context above, the additional context wins for THIS form only."
    );
    matchingAdditional.forEach((ac, i) => {
      parts.push(`\n--- Clarification #${i + 1} (submitted ${new Date(ac.createdAt).toISOString()}) ---`);
      if (ac.userNote && ac.userNote.trim() !== "") {
        parts.push(`User note:\n${ac.userNote.trim()}`);
      }
      if (ac.documents && ac.documents.length > 0) {
        for (const doc of ac.documents) {
          parts.push(`\n[Attached document: ${doc.originalName}]\n${doc.rawText || "(no text extracted)"}`);
        }
      }
    });
  }

  // ── 2. Form metadata ──────────────────────────────────────────────────────
  parts.push(`\n${hr}`);
  parts.push(`FORM METADATA  |  formId: ${formContext.formId}`);
  parts.push(hr);
  parts.push(JSON.stringify(formContext.formMetadata, null, 2));

  return parts.join("\n");
}

/**
 * Builds the field-by-field part of the user turn for one batch (or the whole
 * form): every field ID the LLM must output, then the final instruction.
 */
function buildFieldSection(params: {
  fields: IFormContext["fields"];
  /** Input-constraint tag per field ID as it appears in `fields` (see buildFieldTags) */
  fieldTags?: Record<string, string>;
  /** Set when the form is split: which Parts this batch covers, and the form's total field count */
  batch?: { partsLabel: string; formFieldCount: number };
}): string {
  const { fields, fieldTags = {}, batch } = params;
  const hr = "─".repeat(72);
  const parts: string[] = [];

  // ── 3. Field-by-field context — every field ID the LLM must output ────────
  parts.push(hr);
  parts.push(
    batch
      ? `FORM CONTEXT  |  ${batch.partsLabel}  |  ${fields.length} of the form's ${batch.formFieldCount} fields  |  every field ID below must appear as a key in your output`
      : `FORM CONTEXT  |  ${fields.length} fields  |  every field ID below must appear as a key in your output`
  );
  parts.push(hr);

  const contextLines: string[] = [];
  for (const fc of fields) {
    const tag = fieldTags[fc.field];
    contextLines.push(
      `[${fc.field}]${tag ? `  (${tag})` : ""}\n` +
      `  Description : ${fc.description}\n` +
      `  Party       : ${fc.party}\n` +
      `  Notes       : ${fc.notes}`
    );
  }
  parts.push(contextLines.join("\n\n"));

  // ── 4. Final instruction ──────────────────────────────────────────────────
  parts.push(`\n${hr}`);
  parts.push(
    `For each field ID listed in the FORM CONTEXT above:\n` +
    `  1. Read its description, party, and notes.\n` +
    `  2. Determine whether the SITUATIONAL CONTEXT contains a relevant value.\n` +
    `  3. If yes — extract, format, and insert it. If no — set it to "".\n` +
    `  4. Record any uncertain or inferred fills in the "skipped" audit log.\n\n` +
    (batch
      ? `This request covers ${batch.partsLabel} of the form; the other Parts are filled in separate requests. ` +
        `Use the whole situational context, but output only the field IDs listed here.\n\n`
      : "") +
    `Your output "fields" array must contain one entry for every one of the ${fields.length} field IDs above — no additions, no omissions.\n\n` +
    `Return the JSON object now.`
  );

  return parts.join("\n");
}

/**
 * Builds the whole-form user turn (shared context + every field) — what a
 * single-batch fill sends, and what PRINT_PROMPT shows.
 */
function buildUserMessage(params: {
  formContext: IFormContext;
  situationalContext: ISituationalContext;
  beneficiaryKey?: string;
  fieldTags?: Record<string, string>;
}): string {
  return `${buildSharedContext(params)}\n\n${buildFieldSection({ fields: params.formContext.fields, fieldTags: params.fieldTags })}`;
}

// ─── Batching by form Part ────────────────────────────────────────────────────
//
// Large forms are filled in several smaller calls, each covering whole Parts
// of the form (from the PDF tooltips, "Part 2. Information About You…").
// Every call gets the same system prompt and shared context — cached after
// the first call — and only its own fields, so the model attends to tens of
// fields at a time instead of hundreds. Forms up to SINGLE_CALL_MAX_FIELDS
// stay a single call.

const SINGLE_CALL_MAX_FIELDS = 250;
/** A batch closes before a Part that would take it past this size… */
const BATCH_MAX_FIELDS = 150;
/** …unless it holds fewer than this many fields. Parts are never split. */
const BATCH_MIN_FIELDS = 40;

interface FieldBatch {
  fields: IFormContext["fields"];
  parts: number[];
}

/**
 * Groups the form's fields into batches of whole Parts, in Part order. A field
 * whose tooltip names no Part takes the Part of the field before it in form
 * order; the header block before Part 1 is Part 0.
 */
export function planBatches(fields: IFormContext["fields"], tooltips: Map<string, string>): FieldBatch[] {
  if (fields.length <= SINGLE_CALL_MAX_FIELDS) return [{ fields, parts: [] }];

  // All fields of each Part, in form order within the Part. The context's
  // field order doesn't follow Parts strictly, so group by number, not by run.
  const byPart = new Map<number, IFormContext["fields"]>();
  let part = 0;
  for (const fc of fields) {
    const match = (tooltips.get(fc.field) ?? "").match(/^\s*Part\s+(\d+)/i);
    if (match) part = Number(match[1]);
    if (!byPart.has(part)) byPart.set(part, []);
    byPart.get(part)!.push(fc);
  }
  const groups: FieldBatch[] = [...byPart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([p, partFields]) => ({ fields: partFields, parts: [p] }));

  const batches: FieldBatch[] = [];
  let current: FieldBatch = { fields: [], parts: [] };
  for (const group of groups) {
    if (current.fields.length >= BATCH_MIN_FIELDS && current.fields.length + group.fields.length > BATCH_MAX_FIELDS) {
      batches.push(current);
      current = { fields: [], parts: [] };
    }
    current.fields.push(...group.fields);
    if (!current.parts.includes(group.parts[0])) current.parts.push(group.parts[0]);
  }
  if (current.fields.length > 0) batches.push(current);
  return batches;
}

/** "Part 9", "Parts 2–5", or "the form header and Part 1" for a batch's Parts. */
export function describeParts(parts: number[]): string {
  const numbered = parts.filter((p) => p > 0);
  const header = parts.includes(0) ? "the form header and " : "";
  if (numbered.length === 0) return parts.length > 0 ? "the form header" : "the whole form";
  const lo = Math.min(...numbered);
  const hi = Math.max(...numbered);
  return `${header}${lo === hi ? `Part ${lo}` : `Parts ${lo}–${hi}`}`;
}

// ─── Field constraints ────────────────────────────────────────────────────────
//
// FormMap.fieldMeta records each PDF field's input constraint. Only the ones
// that change how a value must be written are shown to the model, as a short
// tag on the field ID: checkboxes, short text fields (where a formatted phone
// or SSN overflows), and dropdowns. Long text fields (names, streets — 30+
// chars) are untagged; every constraint is still enforced after the call.

/** Text fields at or under this length get a "(max N chars)" tag in the prompt. */
const MAX_LENGTH_TAG_LIMIT = 15;
/** Dropdowns with at most this many options list them in the tag. */
const DROPDOWN_LIST_LIMIT = 15;

function isUsStateList(options: string[]): boolean {
  return options.length >= 50 && options.every((o) => /^[A-Z]{2}$/.test(o)) && ["CA", "NY", "OH", "TX"].every((c) => options.includes(c));
}

/** Prompt tag per full field ID — only for fields whose constraint matters. */
function buildFieldTags(fieldMeta: Record<string, FieldMeta> | undefined): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const [id, meta] of Object.entries(fieldMeta ?? {})) {
    if (meta.type === "checkbox") {
      tags[id] = "checkbox";
    } else if (meta.type === "dropdown" && meta.options && meta.options.length > 0) {
      tags[id] = isUsStateList(meta.options)
        ? "dropdown: 2-letter US state code"
        : meta.options.length <= DROPDOWN_LIST_LIMIT
          ? `dropdown: ${meta.options.join(" | ")}`
          : "dropdown: a code from the form's list";
    } else if (meta.type === "text" && meta.maxLength && meta.maxLength <= MAX_LENGTH_TAG_LIMIT) {
      tags[id] = `max ${meta.maxLength} chars`;
    }
  }
  return tags;
}

/** Comparison key for dropdown values: "B-2" and "b2" both match the option "B2". */
const optionKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Makes every value writable as the PDF expects, using FormMap.fieldMeta:
 *  - checkbox values other than "1", "0", or the box's own checked value are cleared
 *    ("N" in a box that checks as "Y" prints unchecked; "Y" in that box prints checked)
 *  - dropdown values are snapped to the matching option ("B-2" → "B2"), or cleared
 *  - over-long numeric values ("(614) 555-0177" in a 10-char field) are reduced to digits;
 *    other over-long values are kept but flagged, since the PDF will cut them off
 * Every change or remaining problem is returned as a skipped-log entry for review.
 */
export function enforceFieldConstraints(
  fields: Record<string, string>,
  fieldMeta: Record<string, FieldMeta> | undefined
): { fields: Record<string, string>; flagged: SkippedField[] } {
  const out = { ...fields };
  const flagged: SkippedField[] = [];
  if (!fieldMeta) return { fields: out, flagged };

  for (const [id, value] of Object.entries(out)) {
    const meta = fieldMeta[id];
    if (!meta || value === "") continue;

    if (meta.type === "checkbox") {
      if (value !== "1" && value !== "0" && value !== meta.onValue) {
        out[id] = "";
        flagged.push({
          fieldId: id,
          reason: `Cleared: "${value}" is not a value this checkbox accepts ("1", "0"${meta.onValue ? `, or "${meta.onValue}"` : ""}).`,
        });
      }
    } else if (meta.type === "dropdown" && meta.options && meta.options.length > 0) {
      if (!meta.options.includes(value)) {
        const match = meta.options.find((o) => optionKey(o) !== "" && optionKey(o) === optionKey(value));
        if (match) {
          out[id] = match;
        } else {
          out[id] = "";
          flagged.push({ fieldId: id, reason: `Cleared: "${value}" is not one of this dropdown's values.` });
        }
      }
    } else if (meta.type === "text" && meta.maxLength && value.length > meta.maxLength) {
      const digits = value.replace(/\D/g, "");
      if (/^[\d\s()+\-./]+$/.test(value) && digits.length > 0 && digits.length <= meta.maxLength) {
        out[id] = digits;
      } else {
        flagged.push({
          fieldId: id,
          reason: `Value is ${value.length} characters; the PDF field holds ${meta.maxLength} and will cut off the rest.`,
        });
      }
    }
  }
  return { fields: out, flagged };
}

// ─── Data loading helpers ─────────────────────────────────────────────────────

async function loadFormMap(formId: string): Promise<IFormMap> {
  const doc = await FormMap.findOne({ formId }).sort({ createdAt: -1 }).lean();
  if (!doc) {
    throw new Error(`No FormMap found for formId "${formId}". Run buildFormMap first.`);
  }
  return doc as unknown as IFormMap;
}

async function loadFormContext(formId: string, processId?: string): Promise<IFormContext> {
  // Prefer a FormContext that explicitly applies to this process. Fall back to
  // the most recent FormContext for the form when no process-tagged version
  // exists (covers legacy docs created before applicableProcesses was added).
  if (processId) {
    const tagged = await FormContext.findOne({
      formId,
      applicableProcesses: processId,
    })
      .sort({ createdAt: -1 })
      .lean();
    if (tagged) return tagged as unknown as IFormContext;
  }

  const doc = await FormContext.findOne({ formId }).sort({ createdAt: -1 }).lean();
  if (!doc) {
    throw new Error(`No FormContext found for formId "${formId}". Run buildFormContext first.`);
  }
  return doc as unknown as IFormContext;
}

async function loadSituationalContext(situationalContextId: string): Promise<ISituationalContext> {
  const doc = await SituationalContext.findById(situationalContextId).lean();
  if (!doc) {
    throw new Error(`No SituationalContext found for id "${situationalContextId}".`);
  }
  return doc as unknown as ISituationalContext;
}

// ─── Response parsing ─────────────────────────────────────────────────────────

interface LLMResponse {
  fields: Record<string, string>;
  skipped: Array<{ fieldId: string; reason: string }>;
}

interface LLMRawResponse {
  fields?: Array<{ fieldId: string; value: string }>;
  skipped?: Array<{ fieldId: string; reason: string }>;
  error?: { code?: string; message?: string; details?: string };
}

function parseLLMResponse(raw: string, expectedFieldIds: string[]): LLMResponse {
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: LLMRawResponse;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClaudeParseError({
      service: "fillFormMap",
      message: "Claude response was not valid JSON.",
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  // Honour the explicit error shape from the prompt — surface it as a typed
  // error so the route layer can persist the AppError and reject the call.
  if (parsed.error && typeof parsed.error === "object") {
    throw new ClaudeContentError({
      service: "fillFormMap",
      code: parsed.error.code ?? "unspecified",
      message: parsed.error.message ?? "Claude could not fill the form.",
      details: parsed.error.details,
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  if (!Array.isArray(parsed.fields)) {
    throw new ClaudeContentError({
      service: "fillFormMap",
      code: "missing_fields_object",
      message: 'Claude response is missing the "fields" array and did not return an error.',
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  // Fold the {fieldId, value} pairs into the Record<string,string> shape the
  // rest of the service expects. Duplicate fieldIds (shouldn't happen) — last
  // one wins.
  const fields: Record<string, string> = {};
  for (const entry of parsed.fields) {
    if (entry && typeof entry.fieldId === "string") {
      fields[entry.fieldId] = entry.value ?? "";
    }
  }

  // Ensure every expected field is present in the output — fill blanks for any
  // the LLM omitted so the FieldMap shape is always complete.
  const expectedSet = new Set(expectedFieldIds);
  const returnedSet = new Set(Object.keys(fields));

  const missing = [...expectedSet].filter((id) => !returnedSet.has(id));
  if (missing.length > 0) {
    console.warn(
      `[fillFormMap] LLM omitted ${missing.length} field(s) — backfilling with "":`,
      missing.slice(0, 10).join(", "),
      missing.length > 10 ? `...and ${missing.length - 10} more` : ""
    );
    for (const id of missing) {
      fields[id] = "";
    }
  }

  const skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];

  return { fields, skipped };
}

// ─── Key compression ──────────────────────────────────────────────────────────
//
// XFA field IDs like `form1[0].#subform[0].Pt1Line1_FamilyName[0]` tokenise
// very expensively (~20–25 tokens each) because of the repeated prefix, dots,
// brackets, and hash characters.  For a 736-field form like i-485 this adds
// ~14,000 tokens to every response — roughly half the old 16k budget.
//
// The compression layer replaces every full ID with a short opaque key
// (`f0000`…`f9999`) before the prompt is sent, and expands the short keys back
// to full XFA IDs after the response arrives.  The LLM never sees the full
// paths; the PDF layer never sees the short keys.  The mapping lives only in
// memory for the duration of the call.

interface KeyMap {
  /** short key  →  full XFA field ID */
  shortToFull: Record<string, string>;
  /** full XFA field ID  →  short key */
  fullToShort: Record<string, string>;
}

/**
 * Builds a bijective short-key ↔ full-ID mapping for all field IDs in order.
 * Short keys are zero-padded 4-digit indices prefixed with "f" (e.g. "f0000"),
 * guaranteeing uniqueness and reducing each key to ~2 tokens.
 */
function buildKeyMap(fieldIds: string[]): KeyMap {
  const shortToFull: Record<string, string> = {};
  const fullToShort: Record<string, string> = {};
  for (let i = 0; i < fieldIds.length; i++) {
    const shortKey = `f${String(i).padStart(4, "0")}`;
    shortToFull[shortKey] = fieldIds[i];
    fullToShort[fieldIds[i]] = shortKey;
  }
  return { shortToFull, fullToShort };
}

/**
 * Returns a shallow copy of formContext with every field's `field` ID replaced
 * by its short key.  The original formContext is not mutated.
 */
function remapFormContextKeys(
  formContext: IFormContext,
  fullToShort: Record<string, string>
): IFormContext {
  return {
    ...formContext,
    fields: formContext.fields.map((fc) => ({
      ...fc,
      field: fullToShort[fc.field] ?? fc.field,
    })),
  };
}

/**
 * Translates an LLMResponse whose keys are short keys back to full XFA IDs.
 * Any key not found in shortToFull is passed through unchanged (safety net).
 */
function expandLLMResult(
  llmResult: LLMResponse,
  shortToFull: Record<string, string>
): LLMResponse {
  const expandedFields: Record<string, string> = {};
  for (const [shortKey, value] of Object.entries(llmResult.fields)) {
    expandedFields[shortToFull[shortKey] ?? shortKey] = value;
  }
  const expandedSkipped = llmResult.skipped.map((s) => ({
    ...s,
    fieldId: shortToFull[s.fieldId] ?? s.fieldId,
  }));
  return { fields: expandedFields, skipped: expandedSkipped };
}

// ─── Structured output schema ─────────────────────────────────────────────────
//
// Constrains the response to exactly the two shapes the prompt describes —
// the normal fill ({fields, skipped}) or the mandatory error path ({error}) —
// via output_config.format. This removes the free-text-JSON failure mode
// (markdown fences, truncated/malformed JSON) entirely.
//
// "fields" is an array of {fieldId, value} pairs rather than an object keyed
// by field ID. output_config.format.schema requires every object to be
// closed (additionalProperties: false — a literal false, not a schema), so
// there is no way to express "an object with arbitrary keys" at all: an
// object must always fully enumerate its properties. Enumerating one
// property per field is what produced "The compiled grammar is too large"
// on big forms (700+ fields) — the schema's size scaled with field count.
// An array's `items` schema is defined once and stays constant-size
// regardless of how many fields exist, while still satisfying the
// closed-object requirement (a fixed 2-property {fieldId, value} shape).
// The every-key-present guarantee this used to buy via `required` is cheap
// to re-derive downstream — parseLLMResponse backfills any field the model
// omits, so nothing relies on the schema enforcing it.

function buildResponseSchema(): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fieldId: { type: "string" },
                value: { type: "string" },
              },
              required: ["fieldId", "value"],
              additionalProperties: false,
            },
          },
          skipped: {
            type: "array",
            items: {
              type: "object",
              properties: {
                fieldId: { type: "string" },
                reason: { type: "string" },
              },
              required: ["fieldId", "reason"],
              additionalProperties: false,
            },
          },
        },
        required: ["fields", "skipped"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
              details: { type: "string" },
            },
            required: ["code", "message"],
            additionalProperties: false,
          },
        },
        required: ["error"],
        additionalProperties: false,
      },
    ],
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

export async function fillFormMap(input: FillFormMapInput): Promise<IFilledFormMap> {
  const {
    formId,
    userId,
    situationalContextId,
    assumptionLevel = "liberal",
    beneficiaryKey,
    processId: processIdOverride,
  } = input;

  // 1. Load situational context first so we can resolve the processId.
  console.log(`[fillFormMap] Loading prerequisites for "${formId}" / user "${userId}"...`);
  const situationalContext = await loadSituationalContext(situationalContextId);
  const processId = resolveProcessId(processIdOverride ?? situationalContext.processId);

  // FormContext lookup is scoped to (formId, processId). Form map is loaded
  // separately after the LLM call — it is not sent to the LLM. Its field IDs
  // are already present inside the form context.
  const formContext = await loadFormContext(formId, processId);
  // The form map supplies each field's input constraints (fieldMeta) for the
  // prompt tags and post-fill checks, and the blank base the fill is merged over.
  const formMap = await loadFormMap(formId);

  // Field IDs are sourced from the context, not the map
  const fieldIds = formContext.fields.map((f) => f.field);
  if (fieldIds.length === 0) {
    throw new Error(`FormContext for "${formId}" has no fields. Ensure buildFormContext completed successfully.`);
  }

  console.log(
    `[fillFormMap] Prerequisites loaded — ` +
    `${fieldIds.length} fields from context, ` +
    `processId: "${processId}", ` +
    `assumptionLevel: "${assumptionLevel}"` +
    (beneficiaryKey ? `, beneficiaryKey: "${beneficiaryKey}"` : "")
  );

  // Validate the beneficiary key (if provided) exists in partyData. Catching
  // this here surfaces a clearer error than letting the LLM hit "no data".
  if (beneficiaryKey) {
    const partyKeys = Object.keys(situationalContext.partyData ?? {});
    if (!partyKeys.includes(beneficiaryKey)) {
      throw new ClaudeContentError({
        service: "fillFormMap",
        code: "missing_required_party",
        message: `beneficiaryKey "${beneficiaryKey}" is not present in the situational context's partyData.`,
        details: `Available party keys: ${partyKeys.join(", ") || "(none)"}`,
      });
    }
  }

  // 2. Compress field keys for the prompt.
  //    Full XFA IDs (~22 tokens each) are replaced with short alphanumeric keys
  //    ("f0000"…"f9999", ~2 tokens each), saving ~14k tokens on a 736-field form.
  //    The keyMap is used after the response to expand short keys back to full IDs.
  const keyMap = buildKeyMap(fieldIds);
  const compressedFormContext = remapFormContextKeys(formContext, keyMap.fullToShort);

  // 3. Build prompts using the compressed FormContext. Large forms are split
  //    into batches of whole Parts (see planBatches); each batch shares the
  //    system prompt and the shared-context block.
  const systemPrompt = buildSystemPrompt(assumptionLevel, beneficiaryKey, {
    processId,
    readme: getProcessReadme(processId),
    languages: listProcessLanguages(processId),
  });
  const fieldTags: Record<string, string> = {};
  for (const [id, tag] of Object.entries(buildFieldTags(formMap.fieldMeta))) {
    if (keyMap.fullToShort[id]) fieldTags[keyMap.fullToShort[id]] = tag;
  }
  const tooltips = new Map<string, string>();
  for (const [id, label] of readFieldLabels(getBlankPdfPath(processId, formId))) {
    if (keyMap.fullToShort[id]) tooltips.set(keyMap.fullToShort[id], label.tooltip);
  }
  const batches = planBatches(compressedFormContext.fields, tooltips);
  const sharedContext = buildSharedContext({ formContext: compressedFormContext, situationalContext, beneficiaryKey });

  // 4. Anthropic calls — adaptive thinking for the cross-referential reasoning
  //    this task requires (each field reconciled against one situational-
  //    context blob), structured outputs to guarantee a schema-conformant
  //    response, and streaming since max_tokens exceeds the ~16k
  //    non-streaming timeout-risk threshold. With several batches the first
  //    runs alone so the cached prefix (system prompt + shared context) is
  //    written once; the rest then run in parallel and read it.
  const client = getAnthropicClient();
  const responseSchema = buildResponseSchema();
  console.log(
    `[fillFormMap] Calling ${CLAUDE_MODEL} (adaptive thinking, effort: high) for "${formId}" — ` +
    (batches.length > 1
      ? `${batches.length} batches by Part: ${batches.map((b) => `${describeParts(b.parts)} (${b.fields.length})`).join(", ")}`
      : `this may take a minute for large forms...`)
  );

  const runBatch = async (batch: FieldBatch, index: number): Promise<LLMResponse> => {
    const fieldSection = buildFieldSection({
      fields: batch.fields,
      fieldTags,
      ...(batches.length > 1 ? { batch: { partsLabel: describeParts(batch.parts), formFieldCount: fieldIds.length } } : {}),
    });
    const content: Anthropic.Beta.BetaTextBlockParam[] =
      batches.length > 1
        ? [
            { type: "text", text: sharedContext, cache_control: { type: "ephemeral" } },
            { type: "text", text: fieldSection },
          ]
        : [{ type: "text", text: `${sharedContext}\n\n${fieldSection}` }];

    const stream = client.beta.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 128000,
      ...REFUSAL_FALLBACK,
      thinking: { type: "adaptive", display: "summarized" },
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: responseSchema },
      },
      system: systemPrompt,
      messages: [{ role: "user", content }],
    });
    const response = await stream.finalMessage();

    // 5. Log full response payload to MongoDB (non-blocking)
    logAnthropicResponse(response, { service: "fillFormMap", formId, userId, situationalContextId });
    throwIfRefused(response, "fillFormMap");
    if (batches.length > 1) {
      console.log(
        `[fillFormMap] Batch ${index + 1}/${batches.length} (${describeParts(batch.parts)}) done — ` +
        `cache read ${response.usage.cache_read_input_tokens ?? 0} / written ${response.usage.cache_creation_input_tokens ?? 0} tokens`
      );
    }

    // 6. Parse and validate the batch (keys are still short at this point)
    const rawBlock = response.content.find((b) => b.type === "text");
    const rawText = rawBlock?.type === "text" ? rawBlock.text.trim() : "";
    return parseLLMResponse(rawText, batch.fields.map((f) => f.field));
  };

  const first = await runBatch(batches[0], 0);
  const rest = await Promise.all(batches.slice(1).map((batch, i) => runBatch(batch, i + 1)));
  const llmResultShort: LLMResponse = {
    fields: Object.assign({}, first.fields, ...rest.map((r) => r.fields)),
    skipped: [first, ...rest].flatMap((r) => r.skipped),
  };

  // 7. Expand short keys back to full XFA IDs before any downstream use, then
  //    make every value writable as the PDF expects (checkbox / dropdown / length)
  const expanded = expandLLMResult(llmResultShort, keyMap.shortToFull);
  const enforced = enforceFieldConstraints(expanded.fields, formMap.fieldMeta);
  const llmResult = { fields: enforced.fields, skipped: [...expanded.skipped, ...enforced.flagged] };
  if (enforced.flagged.length > 0) {
    console.log(`[fillFormMap] Field constraints: ${enforced.flagged.length} value(s) cleared or flagged`);
  }

  // 8. Log fill stats
  const filled = Object.values(llmResult.fields).filter((v) => v !== "").length;
  const skippedCount = llmResult.skipped.length;
  console.log(
    `[fillFormMap] ✅ ${filled}/${fieldIds.length} fields filled, ` +
    `${skippedCount} flagged in audit log`
  );

  if (skippedCount > 0) {
    console.log(
      `[fillFormMap] Audit log (first 5):`,
      llmResult.skipped.slice(0, 5).map((s) => `${s.fieldId}: ${s.reason}`)
    );
  }

  // 9. The form map is the base for persisting the filled record so the
  //    FilledFormMap has the correct formId/version provenance. The LLM output
  //    already contains all the field values; we merge them in.
  const baseFields = formMap.fields as FieldMap;

  // Merge LLM values over the blank map — ensures any field the LLM returned
  // that wasn't in the stored map is still preserved.
  const mergedFields: FieldMap = { ...baseFields, ...llmResult.fields };

  // 10. Persist FilledFormMap to MongoDB — including the skipped audit log
  const doc = await FilledFormMap.create({
    formId,
    userId,
    createdAt: new Date(),
    assumptionLevel,
    processId,
    ...(beneficiaryKey ? { beneficiaryKey } : {}),
    fields: mergedFields,
    skipped: llmResult.skipped,
  });

  console.log(`[fillFormMap] 💾 Saved FilledFormMap ${doc._id}`);
  return doc.toObject() as IFilledFormMap;
}

// ─── Prompt inspection helper ─────────────────────────────────────────────────

/**
 * Returns the exact system prompt + user message without calling Anthropic.
 * Useful for debugging (PRINT_PROMPT=1 CLI flag).
 *
 * When situationalContextId is omitted, a placeholder situational context is
 * injected so you can inspect the full prompt template and manually paste in
 * real party data for testing.
 */
export async function getFillFormMapPromptText(
  input: Omit<FillFormMapInput, "userId" | "situationalContextId"> & {
    situationalContextId?: string;
  },
): Promise<{ systemPrompt: string; userMessage: string }> {
  const { formId, situationalContextId, assumptionLevel = "liberal", beneficiaryKey, processId: processIdOverride } = input;

  // Only the form context is needed to build the prompt — the form map is not
  // sent to the LLM, so it is not loaded here.
  let resolvedProcessId = processIdOverride ? resolveProcessId(processIdOverride) : undefined;
  if (!resolvedProcessId && situationalContextId) {
    const ctx = await loadSituationalContext(situationalContextId).catch(() => null);
    resolvedProcessId = resolveProcessId(ctx?.processId);
  }
  if (!resolvedProcessId) {
    resolvedProcessId = resolveProcessId(undefined);
  }
  const formContext = await loadFormContext(formId, resolvedProcessId);

  // Apply the same key compression used by the live service so this output
  // exactly mirrors what Anthropic actually receives.
  const fieldIds = formContext.fields.map((f) => f.field);
  const keyMap = buildKeyMap(fieldIds);
  const compressedFormContext = remapFormContextKeys(formContext, keyMap.fullToShort);
  const formMap = await loadFormMap(formId).catch(() => null);
  const fieldTags: Record<string, string> = {};
  for (const [id, tag] of Object.entries(buildFieldTags(formMap?.fieldMeta))) {
    if (keyMap.fullToShort[id]) fieldTags[keyMap.fullToShort[id]] = tag;
  }

  let situationalContext: ISituationalContext;

  if (situationalContextId) {
    situationalContext = await loadSituationalContext(situationalContextId);
  } else {
    // Template mode — emit placeholder so the caller can paste in real data
    situationalContext = {
      userId: "<<USER_ID>>",
      createdAt: new Date(),
      status: "ready" as const,
      situationSummary:
        "<<PASTE situationSummary HERE — 2-3 sentence description of who the parties are, " +
        "what immigration process they are pursuing, and what needs to be done.>>",
      partyData: {
        "<<Party Name e.g. Applicant Full Name>>": {
          "<<Key e.g. Date of Birth>>": "<<Value e.g. 1990-04-15>>",
          "<<Key e.g. Passport Number>>": "<<Value>>",
        },
        "<<US Immigration Context>>": {
          "<<Key e.g. Visa Category>>": "<<Value>>",
        },
      },
      documents: [],
      requiredForms: [],
    };
  }

  return {
    systemPrompt: buildSystemPrompt(assumptionLevel, beneficiaryKey, {
      processId: resolvedProcessId,
      readme: getProcessReadme(resolvedProcessId),
      languages: listProcessLanguages(resolvedProcessId),
    }),
    userMessage: buildUserMessage({
      formContext: compressedFormContext,
      situationalContext,
      beneficiaryKey,
      fieldTags,
    }),
  };
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
//
// Normal run (single form):
//   npx ts-node src/services/fillFormMap.ts <situationalContextId> --formId <formId> [level]
//
// Normal run (all requiredForms from context):
//   npx ts-node src/services/fillFormMap.ts <situationalContextId> [level]
//
// Print prompt (real context):
//   PRINT_PROMPT=1 npx ts-node src/services/fillFormMap.ts --formId <formId> <situationalContextId>
//
// Print prompt template (no context — paste in your own data):
//   PRINT_PROMPT=1 npx ts-node src/services/fillFormMap.ts --formId <formId>

if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    const validLevels: AssumptionLevel[] = ["conservative", "moderate", "liberal"];
    const args = process.argv.slice(2);

    let formId: string | undefined;
    let situationalContextId: string | undefined;
    let assumptionLevel: AssumptionLevel = "liberal";

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--formId" || arg === "-f") && args[i + 1]) {
        formId = args[++i];
      } else if ((arg === "--level" || arg === "-l") && args[i + 1]) {
        const next = args[++i];
        if (validLevels.includes(next as AssumptionLevel)) assumptionLevel = next as AssumptionLevel;
      } else if (!arg.startsWith("-")) {
        if (validLevels.includes(arg as AssumptionLevel)) {
          assumptionLevel = arg as AssumptionLevel;
        } else if (!situationalContextId) {
          situationalContextId = arg;
        }
      }
    }

    const isPrintMode = process.env.PRINT_PROMPT === "1";

    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    // ── PRINT_PROMPT mode ────────────────────────────────────────────────────
    if (isPrintMode) {
      if (!formId) {
        console.error("PRINT_PROMPT=1 requires --formId <formId>");
        await disconnectDB();
        process.exit(1);
      }

      if (!situationalContextId) {
        console.log(
          `\n[fillFormMap] No situationalContextId provided — printing prompt TEMPLATE.\n` +
          `Replace the <<PLACEHOLDER>> blocks in the SITUATIONAL CONTEXT section with real data.\n`
        );
      }

      try {
        const { systemPrompt, userMessage } = await getFillFormMapPromptText({
          formId,
          situationalContextId,
          assumptionLevel,
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

    // ── Normal run mode ──────────────────────────────────────────────────────
    if (!situationalContextId) {
      console.error(
        "Usage:\n" +
        "  npx ts-node src/services/fillFormMap.ts <situationalContextId> [--formId <formId>] [level]\n" +
        "  PRINT_PROMPT=1 npx ts-node src/services/fillFormMap.ts --formId <formId> [<situationalContextId>]"
      );
      await disconnectDB();
      process.exit(1);
    }

    // Always load the context to get the real userId
    const ctxDoc = await SituationalContext.findById(situationalContextId).lean();
    if (!ctxDoc) {
      console.error(`❌ SituationalContext not found: ${situationalContextId}`);
      await disconnectDB();
      process.exit(1);
    }

    const userId = (ctxDoc as any).userId as string;
    const { normalizeRequiredForms } = await import("../types");

    // Resolve which forms to process — list of {formId, beneficiaryKey?}
    let entries: Array<{ formId: string; beneficiaryKey?: string }>;
    if (formId) {
      entries = [{ formId }];
    } else {
      entries = normalizeRequiredForms((ctxDoc as any).requiredForms);
      if (entries.length === 0) {
        console.error("❌ No --formId given and SituationalContext has no requiredForms.");
        await disconnectDB();
        process.exit(1);
      }
      const label = entries
        .map((e) => (e.beneficiaryKey ? `${e.formId} (${e.beneficiaryKey})` : e.formId))
        .join(", ");
      console.log(`[fillFormMap] No --formId given — using requiredForms: ${label}`);
    }
    let anyFailure = false;

    for (const entry of entries) {
      const labelId = entry.beneficiaryKey ? `${entry.formId} (${entry.beneficiaryKey})` : entry.formId;
      try {
        const result = await fillFormMap({
          formId: entry.formId,
          userId,
          situationalContextId,
          assumptionLevel,
          beneficiaryKey: entry.beneficiaryKey,
        });
        const fields = result.fields as FieldMap;
        const filledCount = Object.values(fields).filter((v) => v !== "").length;
        const totalCount = Object.keys(fields).length;

        console.log(`\n✅ ${labelId}`);
        console.log(`   Assumption    : ${result.assumptionLevel}`);
        console.log(`   Fields filled : ${filledCount} / ${totalCount}`);
        console.log(`   MongoDB _id   : ${(result as any)._id}`);
      } catch (err) {
        console.error(`\n❌ ${labelId}: ${err instanceof Error ? err.message : err}`);
        anyFailure = true;
      }
    }

    console.log("");
    await disconnectDB();
    process.exit(anyFailure ? 1 : 0);
  })();
}
