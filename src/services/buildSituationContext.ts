import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import { getAnthropicClient } from "../lib/anthropic";
import { SituationalContext } from "../models/SituationalContext";
import { logAnthropicResponse } from "../models/AnthropicLog";
import { ClaudeContentError, ClaudeParseError } from "../models/AppError";
import { summarizeProcesses, getProcessLanguagesTesseractString, type ProcessSummary } from "../lib/processes";
import type {
  BuildSituationContextInput,
  ISituationalContext,
  ParsedDocument,
  DocumentMimeCategory,
  PartyDataMap,
  RequiredFormsStored,
  UploadedFile,
} from "../types";

// ─── Document pre-processing ─────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"]);

/**
 * Tesseract default when no process-language file applies.
 *
 * Covers the common Latin-script source languages we see on immigration
 * material (US, Portuguese, Spanish, French, Italian, German). Processes that
 * need a different mix opt in via `languages.txt` — e.g. italy-student-visa
 * ships `eng+ita+spa`, and a future China process could ship `eng+chi_sim`.
 *
 * tesseract.js auto-downloads missing `<lang>.traineddata` from its CDN on
 * first use (cached to the working directory thereafter — see the checked-in
 * `eng.traineddata` / `por.traineddata` in the immi-server root). No manual
 * pre-provisioning is required for the languages listed here; the first OCR
 * call after deploy will pay a one-time fetch cost per new language.
 *
 * Non-Latin scripts (Chinese, Arabic, Cyrillic, Hindi, Thai, Japanese, etc.)
 * are NOT in the default because they degrade Latin-script recognition when
 * mixed in one Tesseract call. Add them via a per-process `languages.txt`
 * when the process is known to receive those documents.
 */
const DEFAULT_OCR_LANGS = "eng+por+spa+fra+ita+deu";

export function getMimeCategory(file: UploadedFile): DocumentMimeCategory {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf" || file.mimetype === "application/pdf") return "pdf";
  if (IMAGE_EXTS.has(ext) || file.mimetype.startsWith("image/")) return "image";
  return "text";
}

export async function extractRawText(
  file: UploadedFile,
  category: DocumentMimeCategory,
  ocrLangs?: string,
): Promise<string> {
  switch (category) {
    case "pdf": {
      // Copy into a standalone Uint8Array: pdf-parse's bundled pdf.js (v1.10)
      // reads the underlying ArrayBuffer from byte 0 and ignores byteOffset.
      // Newer Node versions return small files as a slice of a shared pool
      // (byteOffset ≠ 0), which shifts every object lookup → "bad XRef entry".
      const buffer = new Uint8Array(fs.readFileSync(file.path));
      const result = await pdfParse(buffer as Buffer);
      return result.text.trim();
    }
    case "image": {
      const { data } = await Tesseract.recognize(file.path, ocrLangs ?? DEFAULT_OCR_LANGS, {
        // logger: (m) => console.log(m), // uncomment for OCR progress
      });
      return data.text.trim();
    }
    case "text": {
      return fs.readFileSync(file.path, "utf-8").trim();
    }
  }
}

// ─── Anthropic prompt ────────────────────────────────────────────────────────

/**
 * Renders the catalogue of supported processes (discovered from the
 * filesystem) as a block the LLM can read to match the user's situation.
 * Each block lists the process identifier, its README (when present), and
 * the form IDs available for that process.
 */
function renderSupportedProcesses(processes: ProcessSummary[]): string {
  if (processes.length === 0) {
    return "(No pre-configured processes are available. You must invent a processId based on the user's situation.)";
  }

  const blocks = processes.map((p) => {
    const lines: string[] = [];
    lines.push(`- processId: "${p.processId}"`);
    if (p.readme) {
      lines.push(`  description: ${p.readme.replace(/\n+/g, " ").trim()}`);
    }
    if (p.languages && p.languages.length > 0) {
      lines.push(`  expected document languages: ${p.languages.join(", ")}`);
    }
    lines.push(`  available forms: ${p.formIds.length > 0 ? p.formIds.join(", ") : "(none configured)"}`);
    return lines.join("\n");
  });

  return blocks.join("\n\n");
}

function buildSystemPrompt(processes: ProcessSummary[]): string {
  const supportedBlock = renderSupportedProcesses(processes);

  return `You are an expert document analyst with deep knowledge of identity documents, employment records, and government forms across multiple jurisdictions.

You will receive:
1. Answers the user provided in a UI describing their situation and the form-filing process they are pursuing.
2. Raw text extracted from uploaded documents via OCR and PDF parsing.
3. Attached images of those same documents for visual verification and supplementation of the extracted text.

Your job is to do four things:

PART A — Situational Summary
Write a 2-3 sentence summary in English describing: (a) who the parties are, (b) what process they are trying to complete, and (c) what our service needs to do to help them.

PART B — Process Identification
Identify the form-filing process this situation belongs to. The system supports the following processes (read from the filesystem at runtime):

${supportedBlock}

Output a single "processId" string:
- If the user's situation clearly matches one of the supported processes above, set processId to that exact identifier.
- If NO supported process applies, invent a short, general kebab-case identifier that describes the matter (e.g. "k1-fiance", "student-opt", "uk-skilled-worker"). Do not force-fit to an existing process. The form list you emit in PART C is then unconstrained — use whichever forms genuinely apply.

PART C — Required Forms
Produce an ordered list of forms that will need to be completed.

When processId matches a supported process, draw form IDs from that process's "available forms" list above. When processId is one you invented, use whichever short lowercase-hyphenated form IDs are appropriate (e.g. "i-129f", "ds-160").

Each entry MUST be an object of the shape:
  { "formId": "<form-id>", "beneficiaryKey": "<party name from partyData>" }

The "beneficiaryKey" MUST match EXACTLY one of the top-level keys in your "partyData" object (e.g. "Maria Souza"). It identifies the beneficiary this form is being filed for.

PER-BENEFICIARY vs. ONCE-PER-HOUSEHOLD FORMS — important:
- A form is PER-BENEFICIARY when each beneficiary requires their own filing (typical for applications and petitions specific to one person). Emit one entry per (form × beneficiary) pair, each with a beneficiaryKey.
  Example: if a single petitioner is sponsoring two children, requiredForms must contain a separate entry for each child for every per-beneficiary form.
- A form is HOUSEHOLD-SCOPE when a single filing covers the whole sponsor unit or applicant household (typical for affidavits, sponsor declarations, family-wide applications). Emit a single entry and OMIT the beneficiaryKey field.

Use your knowledge of how each specific form is filed to decide its scope — do not guess. When there is only one beneficiary, still produce object entries with beneficiaryKey set to that beneficiary's party name for per-beneficiary forms.

Include only forms genuinely required for this specific situation. Order entries in the sequence they should be filed (primary petition first, supporting forms after).

PART D — Structured Party Data
Extract and organize every piece of information from the documents and UI answers into a structured JSON object.

TRANSLATION RULES — strictly follow these:
- ALL output must be in English. Translate every field label, value, and narrative string from any non-English source language into English. English is the only assumed language; treat all others equally.
- Document labels and field names from foreign documents must be translated accurately to their standard English equivalent (e.g. a date-of-birth label in any language becomes "Date of Birth", a place-of-birth label becomes "Place of Birth"). Use the conventional English form regardless of source language.
- Proper nouns (personal names, city names, employer names) should be preserved as written in the original document — do not translate names.
- When a foreign document uses an abbreviation or code (e.g. national tax IDs, occupation codes), include both the original code and a translated label.

DATA SANITIZATION RULES — apply these when writing values:
- Strip incidental metadata or document-context artifacts from values. Store only the practical, usable piece of information the field label implies.
  Examples:
  - "Springfield, IL USA (Open To Relocation)" → store as "Springfield, IL, USA" under "Current Location"
  - "R$ 1.000,00/month" → store as "R$ 1,000.00 / month"
  - "01 JAN/JAN 1990" → store as "1990-01-01"
  - "DOE<<JANE<MARY" (MRZ format) → store as "Jane Mary Doe" under "Name (MRZ)"
- Normalize dates to ISO 8601 (YYYY-MM-DD) wherever the original value is unambiguous.
- Do not include parenthetical clarifications, source caveats, or document-type context inside a value. Those belong in the key name or a separate "Notes" field if truly needed.

STRUCTURE RULES:
- The top-level keys of the JSON are specific parties or situational subjects (e.g. "John Alexander Doe", "Jane Mary Doe", "Marriage (2024)", "US Immigration Context").
  Keep subjects specific — avoid vague keys like "Documents" or "Information".
- Within each subject, use key-value pairs where:
  - Precise, discrete facts (a name, date, number, address) are stored with full precision: { "Passport Number": "AB1234567" }
  - Narrative or multi-entry information is stored as a labeled string or nested object: { "Employment History": "..." }
- Capture EVERY piece of information present. Redundancy across subjects is acceptable; omissions are not.
- Preserve exact proper nouns, numbers, ID numbers, and addresses — do not paraphrase them.
- Always decompose addresses into separate keys: Street Number, Street Name, Apt / Unit, City, State / Province, Zip / Postal Code, Country. Never store an address as a single string.
- Infer and include reasonable derived facts (e.g. if a marriage certificate shows two spouses, record the relationship and immigration relevance under a "US Immigration Context" subject).

PHYSICAL & BIOGRAPHIC ATTRIBUTES — this is critical for government form accuracy:
For every individual party, you MUST extract and record the following under that party's subject key whenever the information appears anywhere in the documents or images. Government forms require these fields and they must be exact:
  - "Height" — in feet and inches (e.g. "5 ft 7 in") and/or centimeters as shown on the document
  - "Weight" — in pounds and/or kilograms as shown on the document
  - "Eye Color" — exact value as printed on the document (e.g. "Brown", "Blue", "Green", "Hazel", "Gray", "Black")
  - "Hair Color" — exact value as printed (e.g. "Black", "Brown", "Blonde", "Gray", "Red", "White", "Bald")
  - "Race / Ethnicity" — as declared on the document or self-reported; use the exact US government categories where applicable:
      White, Black or African American, Asian, American Indian or Alaska Native,
      Native Hawaiian or Other Pacific Islander, Hispanic or Latino, Other
  - "Sex" — as printed on the document ("Male", "Female", or as stated)
  - "Complexion / Skin Tone" — if present on any document (common on older passports and visas)
  - "Place of Birth" — city and country
  - "Country of Birth"
  - "Country of Citizenship / Nationality"
If a value is not present anywhere in the provided materials, omit the key entirely — do not guess or leave a placeholder.

Return a single valid JSON object with this exact shape — no markdown fences, no explanation outside the JSON:
{
  "situationSummary": "<2-3 sentence summary in English>",
  "processId": "<exact processId from the supported list, OR a new kebab-case identifier you invented>",
  "requiredForms": [
    { "formId": "<form-id>", "beneficiaryKey": "<party name from partyData>" },
    { "formId": "<household-form-id>" }
  ],
  "partyData": {
    "<Party or Subject Name>": {
      "<Key in English>": "<sanitized value or narrative string in English>"
    }
  }
}

─────────────────────────────────────────────────────────────────────────────
ERROR PATH — MANDATORY
─────────────────────────────────────────────────────────────────────────────

If, AT ANY POINT, you determine that you CANNOT produce a valid, complete
situational context — for example because:
  • The UI answers are empty, contradictory, or do not describe an immigration
    matter at all.
  • The uploaded documents are unreadable, irrelevant to immigration, or
    contain no useful identity / process information.
  • You cannot confidently identify even one party or one required form.
  • The materials describe a process that is not a US immigration filing.
  • Any other ambiguity makes a high-quality response impossible.

YOU MUST NOT GUESS, FABRICATE, OR RETURN A PARTIAL CONTEXT.

Instead, return — and return ONLY — the following JSON object, with no
markdown fences and no explanation outside the JSON:

{
  "error": {
    "code": "<short_snake_case_code>",
    "message": "<one-sentence plain-English description of why you cannot proceed>",
    "details": "<optional second sentence describing what would be needed to succeed>"
  }
}

Valid examples of "code":
  insufficient_context, unreadable_documents, irrelevant_documents,
  conflicting_information, non_immigration_matter, missing_parties,
  cannot_determine_forms

This error shape is the ONLY acceptable response when you cannot produce the
full situational context. Do not mix the two shapes. Do not return an empty
situationSummary, an empty partyData object, or fabricated forms in lieu of
returning the error object.`;
}

/**
 * Renders the explicit multi-beneficiary signal from the UI as a single
 * authoritative paragraph for the model. Only emitted when count > 1.
 */
function buildBeneficiarySignal(
  uiAnswers: BuildSituationContextInput["uiAnswers"]
): string | null {
  const count = uiAnswers.beneficiaryCount;
  if (typeof count !== "number" || count <= 1) return null;

  const names = (uiAnswers.beneficiaryNames ?? [])
    .map((n) => (typeof n === "string" ? n.trim() : ""))
    .filter((n) => n.length > 0);

  const lines: string[] = [];
  lines.push(
    `IMPORTANT — MULTI-BENEFICIARY APPLICATION: The user has explicitly indicated that this application covers ${count} distinct beneficiaries.`
  );
  if (names.length > 0) {
    lines.push(
      `The beneficiary names provided by the user are: ${names.map((n) => `"${n}"`).join(", ")}.`
    );
    lines.push(
      `When emitting partyData, use these exact strings as the top-level keys for each beneficiary (matching the spelling and casing the user provided). Use the same strings as "beneficiaryKey" values inside requiredForms entries.`
    );
  } else {
    lines.push(
      `Beneficiary names were not provided. Identify each beneficiary from the documents and use a clear, specific party-name string as the top-level key in partyData and as the "beneficiaryKey" inside requiredForms entries.`
    );
  }
  lines.push(
    `Produce ${count} distinct top-level beneficiary entries in partyData (separate from any petitioner/sponsor entries). Emit one requiredForms entry per (per-beneficiary form × beneficiary) pair as described in the system prompt.`
  );
  return lines.join("\n");
}

function buildUserMessage(
  uiAnswers: BuildSituationContextInput["uiAnswers"],
  parsedDocuments: Array<{ originalName: string; rawText: string }>
): string {
  const parts: string[] = [];

  parts.push("--- UI ANSWERS ---");
  parts.push(`Situation Description:\n${uiAnswers.situationDescription}`);
  parts.push(`Immigration Goal / Process:\n${uiAnswers.processDescription}`);
  if (uiAnswers.additionalNotes) {
    parts.push(`Additional Notes:\n${uiAnswers.additionalNotes}`);
  }

  const beneficiarySignal = buildBeneficiarySignal(uiAnswers);
  if (beneficiarySignal) {
    parts.push(`\n${beneficiarySignal}`);
  }

  if (parsedDocuments.length > 0) {
    parts.push("\n--- EXTRACTED DOCUMENT TEXT ---");
    for (const doc of parsedDocuments) {
      parts.push(`\n[Document: ${doc.originalName}]\n${doc.rawText}`);
    }
  }

  parts.push(
    "\nUsing all of the above, produce the JSON object described in the system prompt. Do not omit any information."
  );

  return parts.join("\n");
}

// ─── Image content blocks for vision-capable documents ───────────────────────

type AnthropicMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

function buildImageBlocks(
  files: UploadedFile[],
  categories: DocumentMimeCategory[]
): Array<{ type: "image"; source: { type: "base64"; media_type: AnthropicMediaType; data: string } }> {
  const blocks: Array<{
    type: "image";
    source: { type: "base64"; media_type: AnthropicMediaType; data: string };
  }> = [];

  const SUPPORTED: Record<string, AnthropicMediaType> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };

  for (let i = 0; i < files.length; i++) {
    if (categories[i] !== "image") continue;
    const file = files[i];
    if (!fs.existsSync(file.path)) continue;

    const ext = path.extname(file.originalname).replace(".", "").toLowerCase();
    const mediaType = SUPPORTED[ext];
    if (!mediaType) {
      console.warn(`[buildSituationContext] Unsupported image type "${ext}", skipping ${file.originalname}`);
      continue;
    }
    const data = fs.readFileSync(file.path).toString("base64");

    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }

  return blocks;
}

// ─── Per-document extraction (EXTRACTION_MODE=per_document) ──────────────────
//
// In per_document mode we make one Claude call per uploaded document, each
// emitting a structured "facts" JSON, and then a single synthesis call that
// turns the array of facts + UI answers into the same {situationSummary,
// requiredForms, partyData} shape produced by the monolithic path.
//
// Tradeoffs vs. monolithic (single mega-call):
//   + Each document gets the model's full attention — better extraction
//     quality on messy OCR / multi-page docs.
//   + The extraction system prompt is identical across docs, so it can be
//     cached via cache_control; calls 2..N cost ~10% of the first.
//   + Synthesis sees clean structured JSON instead of raw OCR text, which
//     reduces token usage on a per-call basis and makes form-required logic
//     more reliable.
//   - More total Claude calls (N + 1 instead of 1). Without caching this
//     would balloon costs; with caching + structured synthesis input it is
//     roughly comparable to monolithic at typical doc counts.

function buildExtractionSystemPrompt(): string {
  return `You are an immigration document fact extractor. You will receive ONE document — either as OCR-extracted text, an image, or both — and your job is to extract every piece of useful information from it as structured JSON.

Be exhaustive. Capture every field, label, number, date, name, address, signature line, stamp, watermark, photo description, or annotation you can identify on this single document. Do not invent or guess data that is not visibly present.

TRANSLATION RULES:
- Output keys and values in English. Translate foreign labels accurately to their standard English equivalent regardless of source language (English is the only assumed language; treat all others equally).
- Preserve proper nouns exactly as written — never translate personal names, city names, employer names, or street names.
- For abbreviations or codes (national tax IDs, occupation codes, MRZ lines), include both the original code and its translated meaning.

DATA SANITIZATION RULES:
- Normalize dates to ISO 8601 (YYYY-MM-DD) when unambiguous.
- Strip incidental document-context artifacts. Examples:
  - "Springfield, IL USA (Open To Relocation)" → "Springfield, IL, USA"
  - "P<USADOE<<JANE<MARY<..." (MRZ) → "Jane Mary Doe"
  - "EUR 1.000,00/month" → "EUR 1,000.00 / month"
- Always decompose addresses into separate keys: Street Number, Street Name, Apt/Unit, City, State/Province, Zip/Postal Code, Country.

BIOGRAPHIC ATTRIBUTES — extract when visible on the document:
Height, Weight, Eye Color, Hair Color, Race/Ethnicity, Sex, Complexion/Skin Tone, Place of Birth, Country of Birth, Country of Citizenship.

Return a single valid JSON object with this shape — no markdown fences, no prose outside the JSON:

{
  "documentType": "<short label, e.g. \\"Passport\\", \\"Marriage Certificate\\", \\"I-797 Receipt Notice\\", \\"Driver's License\\", \\"Tax Return\\">",
  "primaryParty": "<full name of the person this document is primarily about, if applicable — else omit>",
  "issuingAuthority": "<who issued the document, if applicable — else omit>",
  "facts": {
    "<Subject or Party Name>": {
      "<Key in English>": "<sanitized value>"
    }
  },
  "notes": "<optional 1-sentence note about ambiguity, low-quality scan, or anything a synthesizer should be aware of — omit if nothing useful to say>"
}

ERROR PATH — MANDATORY
If you cannot extract anything useful from this document — e.g. it is unreadable, blank, totally irrelevant to immigration, or you cannot identify what kind of document it is — return ONLY this JSON object instead of the success shape:

{
  "error": {
    "code": "<short_snake_case_code>",
    "message": "<one-sentence plain-English description of why this document cannot be processed>"
  }
}

Valid examples of "code": unreadable_document, blank_document, irrelevant_document, unknown_document_type, corrupt_image.

Do not mix shapes. Do not return an empty "facts" object in lieu of the error shape.`;
}

function buildExtractionUserMessage(doc: { originalName: string; rawText: string }): string {
  return [
    `Document filename: ${doc.originalName}`,
    "",
    "OCR / PDF-parsed text:",
    doc.rawText ? doc.rawText : "(no text could be extracted from this file)",
    "",
    "Extract every fact present on this document as the JSON object described in the system prompt.",
  ].join("\n");
}

interface ExtractedDocumentResult {
  documentName: string;
  /** Present when extraction succeeded. */
  facts?: Record<string, unknown>;
  /** Present when Claude returned the error JSON shape. */
  error?: { code: string; message: string };
}

async function extractDocumentFacts(
  doc: ParsedDocument,
  imageBlock: { type: "image"; source: { type: "base64"; media_type: AnthropicMediaType; data: string } } | undefined,
  ctx: { userId: string }
): Promise<ExtractedDocumentResult> {
  const client = getAnthropicClient();
  const userText = buildExtractionUserMessage({ originalName: doc.originalName, rawText: doc.rawText });

  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 8000,
    // Use the array form so we can attach cache_control. After the first call
    // the cached prompt block is reused at ~10% cost.
    system: [
      {
        type: "text",
        text: buildExtractionSystemPrompt(),
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [
      {
        role: "user",
        content: [
          ...(imageBlock ? [imageBlock] : []),
          { type: "text", text: userText },
        ],
      },
    ],
  });

  logAnthropicResponse(response, {
    service: "buildSituationContext:extract",
    userId: ctx.userId,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock?.type === "text" ? textBlock.text.trim() : "";
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: {
    documentType?: string;
    primaryParty?: string;
    issuingAuthority?: string;
    facts?: Record<string, unknown>;
    notes?: string;
    error?: { code?: string; message?: string };
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClaudeParseError({
      service: "buildSituationContext:extract",
      message: `Per-document extraction returned invalid JSON for "${doc.originalName}".`,
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  // Soft-fail per-doc content errors so synthesis can still run on the docs
  // that did extract cleanly. Hard-failing here would mean one bad scan
  // taking down the entire pipeline.
  if (parsed.error && typeof parsed.error === "object") {
    return {
      documentName: doc.originalName,
      error: {
        code: parsed.error.code ?? "unspecified",
        message: parsed.error.message ?? "Document could not be extracted.",
      },
    };
  }

  return {
    documentName: doc.originalName,
    facts: {
      documentType: parsed.documentType,
      primaryParty: parsed.primaryParty,
      issuingAuthority: parsed.issuingAuthority,
      facts: parsed.facts ?? {},
      ...(parsed.notes ? { notes: parsed.notes } : {}),
    },
  };
}

/** Bounded-concurrency Promise.all so we don't fire 50 calls at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Synthesis (EXTRACTION_MODE=per_document) ────────────────────────────────

function buildSynthesisSystemPrompt(processes: ProcessSummary[]): string {
  const supportedBlock = renderSupportedProcesses(processes);

  return `You are an expert document analyst. You are receiving pre-extracted, structured facts from a set of uploaded documents (the OCR step and per-document fact extraction have already been performed). Your job is to synthesize those facts together with the user's self-reported answers into a complete situational context for the form-filing process they are pursuing.

You will be given:
1. The user's UI answers describing their situation and the process they want to pursue.
2. An array of per-document extraction results. Each entry has a documentName and either a "facts" object (successful extraction) or an "error" object (the document could not be extracted — note this and proceed without it).

Your output is a four-part artifact:

PART A — Situational Summary
2-3 sentences in English describing (a) who the parties are, (b) what process they are trying to complete, and (c) what our service needs to do to help them.

PART B — Process Identification
Identify the form-filing process this situation belongs to. The system supports the following processes (read from the filesystem at runtime):

${supportedBlock}

Output a single "processId" string:
- If the user's situation clearly matches one of the supported processes above, set processId to that exact identifier.
- If NO supported process applies, invent a short, general kebab-case identifier that describes the matter (e.g. "k1-fiance", "student-opt", "uk-skilled-worker"). Do not force-fit to an existing process.

PART C — Required Forms
An ordered list of forms required for this situation. When processId matches a supported process, draw form IDs from that process's "available forms" list above. When processId is one you invented, use whichever short lowercase-hyphenated form IDs are appropriate. Order them in the sequence they should be filed (primary petition first, supporting forms after). Include only forms genuinely required for this specific situation.

Each entry MUST be an object of the shape:
  { "formId": "<form-id>", "beneficiaryKey": "<party name from partyData>" }

The "beneficiaryKey" MUST match EXACTLY one of the top-level keys in your "partyData" object. It identifies the beneficiary this form is being filed for.

PER-BENEFICIARY vs. ONCE-PER-HOUSEHOLD FORMS — important:
- A form is PER-BENEFICIARY when each beneficiary requires their own filing. Emit one entry per (form × beneficiary) pair, each with a beneficiaryKey.
- A form is HOUSEHOLD-SCOPE when a single filing covers the whole sponsor unit or applicant household. Emit a single entry and OMIT the beneficiaryKey field.
Use your knowledge of how each specific form is filed to decide its scope — do not guess. When there is only one beneficiary, still produce object entries with beneficiaryKey set to that beneficiary's party name for per-beneficiary forms.

PART D — Structured Party Data
A top-level JSON object whose keys are specific parties or situational subjects (e.g. "John Alexander Doe", "Jane Mary Doe", "Marriage (2024)", "US Immigration Context"). Merge facts about the same person from multiple documents under a single party key. Values are key-value pairs of sanitized, English-translated facts. Capture EVERY fact present across the extracted documents — redundancy across subjects is acceptable; omissions are not. Decompose addresses into separate keys (Street Number, Street Name, Apt/Unit, City, State/Province, Zip/Postal Code, Country).

PHYSICAL & BIOGRAPHIC ATTRIBUTES — for every individual party, include the following when present in ANY extracted document:
Height, Weight, Eye Color, Hair Color, Race/Ethnicity, Sex, Complexion/Skin Tone, Place of Birth, Country of Birth, Country of Citizenship/Nationality.
Omit any key whose value is not present anywhere in the materials — never guess or fill in placeholders.

Return a single valid JSON object with this exact shape — no markdown fences, no prose outside the JSON:

{
  "situationSummary": "<2-3 sentence summary in English>",
  "processId": "<exact processId from the supported list, OR a new kebab-case identifier you invented>",
  "requiredForms": [
    { "formId": "<form-id>", "beneficiaryKey": "<party name from partyData>" },
    { "formId": "<household-form-id>" }
  ],
  "partyData": {
    "<Party or Subject Name>": {
      "<Key in English>": "<value or narrative string in English>"
    }
  }
}

─────────────────────────────────────────────────────────────────────────────
ERROR PATH — MANDATORY
─────────────────────────────────────────────────────────────────────────────

If you cannot synthesize a usable situational context — e.g. every extracted document is an error, the UI answers describe a non-immigration matter, you cannot confidently identify even one party or one required form, or the materials are fundamentally inconsistent — return ONLY this JSON object instead:

{
  "error": {
    "code": "<short_snake_case_code>",
    "message": "<one-sentence plain-English description of why you cannot proceed>",
    "details": "<optional second sentence describing what would be needed to succeed>"
  }
}

Valid codes: insufficient_context, all_documents_failed_extraction, irrelevant_documents, conflicting_information, non_immigration_matter, missing_parties, cannot_determine_forms.

Do not mix shapes. Do not return a partially-populated success object in lieu of the error shape.`;
}

function buildSynthesisUserMessage(
  uiAnswers: BuildSituationContextInput["uiAnswers"],
  extracted: ExtractedDocumentResult[]
): string {
  const parts: string[] = [];

  parts.push("--- UI ANSWERS ---");
  parts.push(`Situation Description:\n${uiAnswers.situationDescription}`);
  parts.push(`Immigration Goal / Process:\n${uiAnswers.processDescription}`);
  if (uiAnswers.additionalNotes) {
    parts.push(`Additional Notes:\n${uiAnswers.additionalNotes}`);
  }

  const beneficiarySignal = buildBeneficiarySignal(uiAnswers);
  if (beneficiarySignal) {
    parts.push(`\n${beneficiarySignal}`);
  }

  parts.push("\n--- PER-DOCUMENT EXTRACTION RESULTS ---");
  if (extracted.length === 0) {
    parts.push("(no documents were uploaded)");
  } else {
    parts.push(JSON.stringify(extracted, null, 2));
  }

  parts.push(
    "\nSynthesize the above into the JSON object described in the system prompt. Do not omit any fact present in the extracted documents."
  );

  return parts.join("\n");
}

interface SynthesisOutput {
  situationSummary: string;
  processId: string;
  requiredForms: RequiredFormsStored;
  partyData: PartyDataMap;
}

async function synthesizeContext(
  uiAnswers: BuildSituationContextInput["uiAnswers"],
  extracted: ExtractedDocumentResult[],
  ctx: { userId: string }
): Promise<SynthesisOutput> {
  const client = getAnthropicClient();
  const processes = summarizeProcesses();

  // Streaming is required here — max_tokens (128000) exceeds the SDK's
  // non-streaming timeout threshold (~21333 tokens), and a non-streaming
  // call above that throws AnthropicError before any request is sent.
  const stream = client.messages.stream({
    model: "claude-opus-4-7",
    max_tokens: 128000,
    system: buildSynthesisSystemPrompt(processes),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: buildSynthesisUserMessage(uiAnswers, extracted) }],
      },
    ],
  });
  const response = await stream.finalMessage();

  logAnthropicResponse(response, {
    service: "buildSituationContext:synthesize",
    userId: ctx.userId,
  });

  const textBlock = response.content.find((b) => b.type === "text");
  const raw = textBlock?.type === "text" ? textBlock.text.trim() : "";
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: {
    situationSummary?: string;
    processId?: string;
    requiredForms?: RequiredFormsStored;
    partyData?: PartyDataMap;
    error?: { code?: string; message?: string; details?: string };
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new ClaudeParseError({
      service: "buildSituationContext:synthesize",
      message: "Synthesis response was not valid JSON.",
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  if (parsed.error && typeof parsed.error === "object") {
    throw new ClaudeContentError({
      service: "buildSituationContext:synthesize",
      code: parsed.error.code ?? "unspecified",
      message: parsed.error.message ?? "Synthesis could not produce a situational context.",
      details: parsed.error.details,
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  if (!parsed.situationSummary || !parsed.partyData || !parsed.processId) {
    throw new ClaudeContentError({
      service: "buildSituationContext:synthesize",
      code: "incomplete_response",
      message: "Synthesis returned a context that is missing required fields (situationSummary, processId, or partyData).",
      rawResponse: cleaned.slice(0, 4000),
    });
  }

  return {
    situationSummary: parsed.situationSummary,
    processId: parsed.processId.trim(),
    requiredForms: Array.isArray(parsed.requiredForms) ? parsed.requiredForms : [],
    partyData: parsed.partyData,
  };
}

// ─── Service ──────────────────────────────────────────────────────────────────

type ExtractionMode = "monolithic" | "per_document";

function resolveExtractionMode(): ExtractionMode {
  const raw = (process.env.EXTRACTION_MODE ?? "").toLowerCase().trim();
  return raw === "per_document" ? "per_document" : "monolithic";
}

/**
 * Image block keyed by uploaded-file index, so the per-doc path can match
 * each ParsedDocument to its corresponding base64 image (if any).
 */
function buildImageBlocksByIndex(
  files: UploadedFile[],
  categories: DocumentMimeCategory[]
): Array<{ type: "image"; source: { type: "base64"; media_type: AnthropicMediaType; data: string } } | undefined> {
  const blocks: Array<{ type: "image"; source: { type: "base64"; media_type: AnthropicMediaType; data: string } } | undefined> = [];
  const SUPPORTED: Record<string, AnthropicMediaType> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };

  for (let i = 0; i < files.length; i++) {
    if (categories[i] !== "image") {
      blocks.push(undefined);
      continue;
    }
    const file = files[i];
    if (!fs.existsSync(file.path)) {
      blocks.push(undefined);
      continue;
    }
    const ext = path.extname(file.originalname).replace(".", "").toLowerCase();
    const mediaType = SUPPORTED[ext];
    if (!mediaType) {
      blocks.push(undefined);
      continue;
    }
    const data = fs.readFileSync(file.path).toString("base64");
    blocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data } });
  }

  return blocks;
}

export async function buildSituationContext(
  input: BuildSituationContextInput,
  existingContextId?: string
): Promise<ISituationalContext> {
  const { userId, uiAnswers, uploadedFiles, processIdHint } = input;
  const mode = resolveExtractionMode();
  // OCR language preference: if the caller hinted a processId AND that
  // process ships a languages.txt, bias Tesseract accordingly. Otherwise
  // fall back to the universal default ("eng"). English is the only
  // language assumed without explicit input — anything else is opt-in via
  // languages.txt or a manual override.
  const ocrLangs = processIdHint
    ? getProcessLanguagesTesseractString(processIdHint) ?? undefined
    : undefined;
  console.log(
    `[buildSituationContext] EXTRACTION_MODE=${mode} | ${uploadedFiles.length} document(s)` +
    (ocrLangs ? ` | OCR langs="${ocrLangs}" (from processIdHint="${processIdHint}")` : "")
  );

  // 1. Categorise and pre-process each uploaded file (shared between modes)
  const categories = uploadedFiles.map(getMimeCategory);

  const parsedDocuments: ParsedDocument[] = [];
  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    const category = categories[i];
    const rawText = await extractRawText(file, category, ocrLangs);
    parsedDocuments.push({
      originalName: file.originalname,
      mimeCategory: category,
      rawText,
      uploadedAt: new Date(),
    });
  }

  // 2. Branch on extraction mode to produce {situationSummary, requiredForms, partyData}
  let synthesized: SynthesisOutput;

  if (mode === "per_document") {
    // Run per-doc extraction in parallel (bounded). Each call uses an
    // ephemerally-cached system prompt so calls 2..N are cheap to send.
    const imageBlocksByIndex = buildImageBlocksByIndex(uploadedFiles, categories);
    const extracted = await mapWithConcurrency(parsedDocuments, 5, async (doc, i) =>
      extractDocumentFacts(doc, imageBlocksByIndex[i], { userId })
    );

    // Attach the extracted facts back onto the persisted parsed-doc records
    // so they are auditable / re-usable without another Claude call.
    for (let i = 0; i < parsedDocuments.length; i++) {
      const result = extracted[i];
      parsedDocuments[i].extractedFacts = result.error
        ? { error: result.error }
        : result.facts;
    }

    const okCount = extracted.filter((e) => !e.error).length;
    console.log(
      `[buildSituationContext] per_document extraction complete — ${okCount}/${extracted.length} succeeded`
    );

    synthesized = await synthesizeContext(uiAnswers, extracted, { userId });
  } else {
    // Monolithic — single Claude call with all OCR text + all images.
    const imageBlocks = buildImageBlocks(uploadedFiles, categories);
    const userText = buildUserMessage(
      uiAnswers,
      parsedDocuments.map((d) => ({ originalName: d.originalName, rawText: d.rawText }))
    );

    const processes = summarizeProcesses();
    const client = getAnthropicClient();
    // Streaming is required here — max_tokens (128000) exceeds the SDK's
    // non-streaming timeout threshold (~21333 tokens), and a non-streaming
    // call above that throws AnthropicError before any request is sent.
    const stream = client.messages.stream({
      model: "claude-opus-4-7",
      max_tokens: 128000,
      system: buildSystemPrompt(processes),
      messages: [
        {
          role: "user",
          content: [
            // Attach image files so the model can perform its own visual extraction
            // on top of the OCR text we already extracted
            ...imageBlocks,
            { type: "text", text: userText },
          ],
        },
      ],
    });
    const response = await stream.finalMessage();

    logAnthropicResponse(response, { service: "buildSituationContext", userId });

    const rawText = response.content.find((b) => b.type === "text");
    const rawJson = rawText?.type === "text" ? rawText.text.trim() : "";
    const cleaned = rawJson.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

    let parsed: {
      situationSummary?: string;
      processId?: string;
      requiredForms?: RequiredFormsStored;
      partyData?: PartyDataMap;
      error?: { code?: string; message?: string; details?: string };
    };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new ClaudeParseError({
        service: "buildSituationContext",
        message: "Claude response was not valid JSON.",
        rawResponse: cleaned.slice(0, 4000),
      });
    }

    if (parsed.error && typeof parsed.error === "object") {
      throw new ClaudeContentError({
        service: "buildSituationContext",
        code: parsed.error.code ?? "unspecified",
        message: parsed.error.message ?? "Claude could not produce a situational context.",
        details: parsed.error.details,
        rawResponse: cleaned.slice(0, 4000),
      });
    }

    if (!parsed.situationSummary || !parsed.partyData || !parsed.processId) {
      throw new ClaudeContentError({
        service: "buildSituationContext",
        code: "incomplete_response",
        message: "Claude returned a context that is missing required fields (situationSummary, processId, or partyData).",
        rawResponse: cleaned.slice(0, 4000),
      });
    }

    synthesized = {
      situationSummary: parsed.situationSummary,
      processId: parsed.processId.trim(),
      requiredForms: Array.isArray(parsed.requiredForms) ? parsed.requiredForms : [],
      partyData: parsed.partyData,
    };
  }

  // 3. Persist to MongoDB (same shape regardless of which path produced it)
  const data = {
    userId,
    partyData: synthesized.partyData,
    documents: parsedDocuments,
    situationSummary: synthesized.situationSummary,
    processId: synthesized.processId,
    requiredForms: synthesized.requiredForms,
    status: "ready" as const,
  };

  console.log(`[buildSituationContext] processId="${synthesized.processId}" (${synthesized.requiredForms.length} required forms)`);

  let doc;
  if (existingContextId) {
    doc = await SituationalContext.findByIdAndUpdate(existingContextId, data, { new: true });
    if (!doc) throw new Error(`SituationalContext not found: ${existingContextId}`);
  } else {
    doc = await SituationalContext.create({ ...data, createdAt: new Date() });
  }

  return doc.toObject() as ISituationalContext;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────
//
// Normal run:
//   npx ts-node src/services/buildSituationContext.ts \
//     --userId <userId> \
//     --situation "<description>" \
//     --process "<immigration goal>" \
//     [--notes "<extra notes>"] \
//     [file1.pdf file2.png ...]
//
// Prompt simulation (no Anthropic call):
//   PRINT_PROMPT=1 npx ts-node src/services/buildSituationContext.ts \
//     --situation "<description>" \
//     --process "<immigration goal>" \
//     [file1.pdf ...]

if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    // ── Argument parsing ───────────────────────────────────────────────────
    const args = process.argv.slice(2);
    let userId = "cli-user";
    let situationDescription = "";
    let processDescription = "";
    let additionalNotes: string | undefined;
    const filePaths: string[] = [];

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if ((arg === "--userId" || arg === "-u") && args[i + 1]) {
        userId = args[++i];
      } else if ((arg === "--situation" || arg === "-s") && args[i + 1]) {
        situationDescription = args[++i];
      } else if ((arg === "--process" || arg === "-p") && args[i + 1]) {
        processDescription = args[++i];
      } else if ((arg === "--notes" || arg === "-n") && args[i + 1]) {
        additionalNotes = args[++i];
      } else if (!arg.startsWith("-")) {
        filePaths.push(arg);
      }
    }

    if (!situationDescription || !processDescription) {
      console.error(
        "Usage:\n" +
        "  npx ts-node src/services/buildSituationContext.ts \\\n" +
        "    --userId <userId> \\\n" +
        "    --situation \"<description>\" \\\n" +
        "    --process \"<forms/process>\" \\\n" +
        "    [--notes \"<notes>\"] \\\n" +
        "    [file1.pdf file2.png ...]\n\n" +
        "  PRINT_PROMPT=1 ... (same flags, skips the Anthropic call)"
      );
      process.exit(1);
    }

    const isPrintMode = process.env.PRINT_PROMPT === "1";

    // Build UploadedFile stubs from the provided paths (bypasses multer)
    const uploadedFiles: UploadedFile[] = filePaths.map((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      let mimetype = "application/octet-stream";
      if (ext === ".pdf") mimetype = "application/pdf";
      else if ([".jpg", ".jpeg"].includes(ext)) mimetype = "image/jpeg";
      else if (ext === ".png") mimetype = "image/png";
      else if (ext === ".gif") mimetype = "image/gif";
      else if (ext === ".webp") mimetype = "image/webp";
      else if ([".txt", ".md"].includes(ext)) mimetype = "text/plain";
      return { path: filePath, originalname: path.basename(filePath), mimetype };
    });

    // ── PRINT_PROMPT mode ──────────────────────────────────────────────────
    if (isPrintMode) {
      // Pre-process documents (OCR / PDF parse) so the prompt shows real content
      const categories = uploadedFiles.map(getMimeCategory);
      const parsedDocs: Array<{ originalName: string; rawText: string }> = [];
      for (let i = 0; i < uploadedFiles.length; i++) {
        const rawText = await extractRawText(uploadedFiles[i], categories[i]);
        parsedDocs.push({ originalName: uploadedFiles[i].originalname, rawText });
        console.log(`[buildSituationContext] Processed document: ${uploadedFiles[i].originalname}`);
      }

      const systemPrompt = buildSystemPrompt(summarizeProcesses());
      const userMessage = buildUserMessage(
        { situationDescription, processDescription, additionalNotes },
        parsedDocs
      );

      console.log("\n========== SYSTEM PROMPT ==========\n");
      console.log(systemPrompt);
      console.log("\n========== USER MESSAGE ==========\n");
      console.log(userMessage);
      if (uploadedFiles.some((f, i) => categories[i] === "image")) {
        console.log("\n[Note: image files would also be attached as base64 vision blocks]");
      }
      process.exit(0);
    }

    // ── Normal run mode ────────────────────────────────────────────────────
    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    try {
      const result = await buildSituationContext({
        userId,
        uiAnswers: { situationDescription, processDescription, additionalNotes },
        uploadedFiles,
      });

      console.log(`\n✅ SituationalContext saved`);
      console.log(`   MongoDB _id    : ${(result as any)._id}`);
      console.log(`   userId         : ${result.userId}`);
      const normalized = (await import("../types")).normalizeRequiredForms(result.requiredForms);
      const formsLabel = normalized
        .map((e) => (e.beneficiaryKey ? `${e.formId} (${e.beneficiaryKey})` : e.formId))
        .join(", ");
      console.log(`   Required forms : ${formsLabel || "(none)"}`);
      console.log(`   Summary        : ${result.situationSummary}`);
      console.log(`   Parties        : ${Object.keys(result.partyData).join(", ")}\n`);
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      await disconnectDB();
      process.exit(1);
    }

    await disconnectDB();
    process.exit(0);
  })();
}
