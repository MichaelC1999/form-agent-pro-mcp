import * as fs from "fs";
import * as path from "path";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";
import { getAnthropicClient } from "../lib/anthropic";
import { SituationalContext } from "../models/SituationalContext";
import { logAnthropicResponse } from "../models/AnthropicLog";
import type {
  BuildSituationContextInput,
  ISituationalContext,
  ParsedDocument,
  DocumentMimeCategory,
  PartyDataMap,
  UploadedFile,
} from "../types";

// ─── Document pre-processing ─────────────────────────────────────────────────

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff"]);

function getMimeCategory(file: UploadedFile): DocumentMimeCategory {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf" || file.mimetype === "application/pdf") return "pdf";
  if (IMAGE_EXTS.has(ext) || file.mimetype.startsWith("image/")) return "image";
  return "text";
}

async function extractRawText(file: UploadedFile, category: DocumentMimeCategory): Promise<string> {
  switch (category) {
    case "pdf": {
      const buffer = fs.readFileSync(file.path);
      const result = await pdfParse(buffer);
      return result.text.trim();
    }
    case "image": {
      const { data } = await Tesseract.recognize(file.path, "eng+por", {
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

function buildSystemPrompt(): string {
  return `You are an expert immigration document analyst with deep knowledge of US and international identity documents, employment records, and government forms.

You will receive:
1. Answers the user provided in a UI describing their situation and the immigration process they are pursuing.
2. Raw text extracted from uploaded documents via OCR and PDF parsing (passports, visas, I-94s, employment records, marriage certificates, tax returns, driver's licenses, etc.).
3. Attached images of those same documents for visual verification and supplementation of the extracted text.

Your job is to do three things:

PART A — Situational Summary
Write a 2-3 sentence summary in English describing: (a) who the parties are, (b) what immigration process they are trying to complete, and (c) what our service needs to do to help them.

PART B — Required Forms
Based on the situation, produce an ordered list of USCIS form IDs that will need to be completed. Use the lowercase hyphenated format matching these examples:
  i-485  (Application to Register Permanent Residence or Adjust Status)
  i-130  (Petition for Alien Relative)
  i-130a (Supplemental Information for Spouse Beneficiary)
  i-864  (Affidavit of Support)
  i-864a (Contract Between Sponsor and Household Member)
  i-765  (Application for Employment Authorization)
  i-131  (Application for Travel Document)
  i-693  (Report of Immigration Medical Examination)
  i-944  (Declaration of Self-Sufficiency)
  i-751  (Petition to Remove Conditions on Residence)
  n-400  (Application for Naturalization)
  n-600  (Application for Certificate of Citizenship)
  i-90   (Application to Replace Permanent Resident Card)
  i-539  (Application to Extend/Change Nonimmigrant Status)
  i-140  (Immigrant Petition for Alien Workers)
Include only forms genuinely required for this specific situation. Order them in the sequence they should be filed (primary petition first, supporting forms after).

PART C — Structured Party Data
Extract and organize every piece of information from the documents and UI answers into a structured JSON object.

TRANSLATION RULES — strictly follow these:
- ALL output must be in English. Translate every field label, value, and narrative string from any source language (Portuguese, Spanish, French, etc.) into English.
- Document labels and field names from foreign documents must be translated accurately. For example:
  - "Data de Nascimento" → "Date of Birth"
  - "Naturalidade" → "Place of Birth"
  - "Validade" → "Expiration Date"
  - "Filiação" → "Parents / Parentage"
  - "Data de Expedição" → "Date of Issue"
  - "Prazo Indeterminado" → "Indefinite Term"
  - "Certidão de Casamento" → "Marriage Certificate"
  - "Comunhão Parcial de Bens" → "Partial Community Property"
- Proper nouns (personal names, city names, employer names) should be preserved as written in the original document — do not translate names.
- When a foreign document uses an abbreviation or code (e.g. CBO occupation codes, CNPJ tax IDs), include both the original code and a translated label.

DATA SANITIZATION RULES — apply these when writing values:
- Strip incidental metadata or document-context artifacts from values. Store only the practical, usable piece of information the field label implies.
  Examples:
  - "Sarasota, FL USA (Open To Relocation)" → store as "Sarasota, FL, USA" under "Current Location"
  - "R$ 1.948,17/month" → store as "R$ 1,948.17 / month"
  - "19 MAI/MAY 1999" → store as "1999-05-19"
  - "DOE<<JANE<MARY" (MRZ format) → store as "Jane Mary Doe" under "Name (MRZ)"
- Normalize dates to ISO 8601 (YYYY-MM-DD) wherever the original value is unambiguous.
- Do not include parenthetical clarifications, source caveats, or document-type context inside a value. Those belong in the key name or a separate "Notes" field if truly needed.

STRUCTURE RULES:
- The top-level keys of the JSON are specific parties or situational subjects (e.g. "John Alexander Doe", "Jane Mary Doe", "Marriage (Brazil, 2024)", "US Immigration Context").
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
  "requiredForms": ["<form-id>", "<form-id>"],
  "partyData": {
    "<Party or Subject Name>": {
      "<Key in English>": "<sanitized value or narrative string in English>"
    }
  }
}`;
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

// ─── Service ──────────────────────────────────────────────────────────────────

export async function buildSituationContext(
  input: BuildSituationContextInput,
  existingContextId?: string
): Promise<ISituationalContext> {
  const { userId, uiAnswers, uploadedFiles } = input;

  // 1. Categorise and pre-process each uploaded file
  const categories = uploadedFiles.map(getMimeCategory);

  const parsedDocuments: ParsedDocument[] = [];
  for (let i = 0; i < uploadedFiles.length; i++) {
    const file = uploadedFiles[i];
    const category = categories[i];
    const rawText = await extractRawText(file, category);
    parsedDocuments.push({
      originalName: file.originalname,
      mimeCategory: category,
      rawText,
      uploadedAt: new Date(),
    });
  }

  // 2. Build the Anthropic message — text summary of all docs + optional image blocks
  const imageBlocks = buildImageBlocks(uploadedFiles, categories);
  const userText = buildUserMessage(
    uiAnswers,
    parsedDocuments.map((d) => ({ originalName: d.originalName, rawText: d.rawText }))
  );

  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 32000,
    system: buildSystemPrompt(),
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

  // 3. Log full response payload to MongoDB (non-blocking)
  logAnthropicResponse(response, { service: "buildSituationContext", userId });

  // 4. Parse LLM response
  const rawText = response.content.find((b) => b.type === "text");
  const rawJson = rawText?.type === "text" ? rawText.text.trim() : "";
  const cleaned = rawJson.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: { situationSummary: string; requiredForms: string[]; partyData: PartyDataMap };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse situation context response.`);
  }

  // 5. Persist to MongoDB
  const data = {
    userId,
    partyData: parsed.partyData ?? {},
    documents: parsedDocuments,
    situationSummary: parsed.situationSummary ?? "",
    requiredForms: Array.isArray(parsed.requiredForms) ? parsed.requiredForms : [],
    status: "ready" as const,
  };

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

      const systemPrompt = buildSystemPrompt();
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
      console.log(`   Required forms : ${result.requiredForms.join(", ") || "(none)"}`);
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
