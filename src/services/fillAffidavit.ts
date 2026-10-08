import * as fs from "fs";
import * as path from "path";
import { getAnthropicClient, CLAUDE_MODEL, REFUSAL_FALLBACK, throwIfRefused } from "../lib/anthropic";
import { SituationalContext } from "../models/SituationalContext";
import { FilledAffidavit, type IFilledAffidavit } from "../models/FilledAffidavit";
import { logAnthropicResponse } from "../models/AnthropicLog";
import { ClaudeContentError, ClaudeParseError } from "../models/AppError";
import {
  resolveProcessId,
  getProcessReadme,
  readAffidavitTemplate,
  hasAffidavits,
  listAffidavits,
  listProcessLanguages,
} from "../lib/processes";
import { markdownToPdf } from "../lib/markdownToPdf";
import type { ISituationalContext } from "../types";

// ─── Prompt ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(processId: string): string {
  const processReadme = getProcessReadme(processId);
  const languages = listProcessLanguages(processId);
  const langLine =
    languages && languages.length > 0
      ? `\n\nDocuments in this filing are expected to be in: ${languages.join(", ")}. Preserve names and proper nouns from the source language unless the affidavit clearly calls for an English-language rendering.`
      : "";
  return `You are an expert paralegal filling out a supporting-document template (an "affidavit") that accompanies a government application package.

You will be given:
1. A markdown TEMPLATE with bracketed placeholders (e.g. [STUDENT_FULL_LEGAL_NAME], [DATE], [SPONSOR_CITY]). Placeholders are descriptive — the bracket text names what should go there.
2. A SITUATIONAL CONTEXT describing the parties, documents, and circumstances of the user's situation as a structured JSON object.
3. The PROCESS this affidavit is filed under.${processReadme ? `\n\nProcess context:\n${processReadme.replace(/\n+/g, " ").trim()}` : ""}${langLine}

Your job:
- For every [PLACEHOLDER] in the template, substitute the appropriate value from the situational context.
- Preserve all surrounding markdown formatting exactly — headings, blockquotes, bullets, tables, bold/italic emphasis, signature lines, notary blocks.
- Do NOT add commentary, do NOT remove sections, do NOT add fields the template did not have.
- Keep blanks intentionally blank when the template clearly expects the user to sign or hand-write something later (e.g. signature lines like "Signature: ___").

RELEVANCY GATE:
Some affidavits do not apply to every applicant — e.g. parental-travel authorization for an adult applicant, or a bank-sponsorship affidavit when the applicant is self-funded. If the affidavit clearly does not apply to this specific situation, output the SKIP error JSON shape instead of filled markdown (see below).

FORMATTING RULES:
- Dates: use the format the template already shows (e.g. "January 12, 2026" or "12 January 2026"). When the template only shows [DATE] with no format hint, prefer "Month DD, YYYY" in English.
- Names: use the exact spelling from the situational context. Use title case unless the template clearly shows ALL CAPS in the surrounding text.
- Addresses: keep on multiple lines when the template shows a blockquote-style address. Comma-separate when the template shows inline.
- Currency: include the unit (USD, EUR) and use comma thousands-separators.
- Phone numbers: keep the format from the situational context.
- Unknown placeholders: if a placeholder has no clear match in the situational context, leave it as the literal [PLACEHOLDER] string so the user notices and can hand-fill before signing.

OUTPUT FORMAT — success:
Return ONLY the filled markdown. No JSON wrapper, no markdown fences around the document, no commentary before or after.

OUTPUT FORMAT — skip / not-applicable:
Return ONLY the following JSON object (no markdown fences):
{
  "skip": true,
  "reason": "<one sentence explaining why this affidavit doesn't apply to this situation>"
}

You must produce exactly one of: a filled markdown document, or the skip JSON. Never both, never an empty response.`;
}

function buildUserMessage(params: {
  affidavitName: string;
  template: string;
  situationalContext: ISituationalContext;
  beneficiaryKey?: string;
}): string {
  const { affidavitName, template, situationalContext, beneficiaryKey } = params;
  const hr = "─".repeat(72);
  const parts: string[] = [];

  parts.push(hr);
  parts.push(`SITUATIONAL CONTEXT  |  userId: ${situationalContext.userId}`);
  parts.push(hr);
  parts.push(`Situation Summary:\n${situationalContext.situationSummary}`);
  parts.push(`\nParty & Situational Data:\n${JSON.stringify(situationalContext.partyData, null, 2)}`);

  if (beneficiaryKey) {
    parts.push(`\nThis affidavit is being filled for the beneficiary keyed as "${beneficiaryKey}".`);
  }

  parts.push(`\n${hr}`);
  parts.push(`AFFIDAVIT TEMPLATE  |  ${affidavitName}`);
  parts.push(hr);
  parts.push(template);

  parts.push(`\n${hr}`);
  parts.push("Produce the filled markdown now (or the skip JSON if not applicable).");
  return parts.join("\n");
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface FillAffidavitInput {
  userId: string;
  situationalContextId: string;
  affidavitName: string;
  beneficiaryKey?: string;
  processId?: string;
}

export async function fillAffidavit(input: FillAffidavitInput): Promise<IFilledAffidavit> {
  const { userId, situationalContextId, affidavitName, beneficiaryKey, processId: processIdOverride } = input;

  const ctx = await SituationalContext.findById(situationalContextId).lean();
  if (!ctx) {
    throw new Error(`SituationalContext not found: ${situationalContextId}`);
  }
  const situationalContext = ctx as unknown as ISituationalContext;
  const processId = resolveProcessId(processIdOverride ?? situationalContext.processId);

  if (!hasAffidavits(processId)) {
    throw new Error(`Process "${processId}" has no affidavits directory.`);
  }
  const known = listAffidavits(processId);
  if (!known.includes(affidavitName)) {
    throw new Error(
      `Affidavit "${affidavitName}" not found in process "${processId}". Known: ${known.join(", ") || "(none)"}`
    );
  }

  const template = readAffidavitTemplate(processId, affidavitName);
  console.log(
    `[fillAffidavit] ${processId}/${affidavitName} — ${template.length} chars template, ` +
    `beneficiaryKey=${beneficiaryKey ?? "(none)"}`
  );

  const client = getAnthropicClient();
  // Streamed: thinking is always on for CLAUDE_MODEL, so max_tokens covers it
  // plus the affidavit text — above the SDK's non-streaming limit
  const stream = client.beta.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 64000,
    output_config: { effort: "high" },
    ...REFUSAL_FALLBACK,
    system: buildSystemPrompt(processId),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: buildUserMessage({ affidavitName, template, situationalContext, beneficiaryKey }),
          },
        ],
      },
    ],
  });
  const response = await stream.finalMessage();

  logAnthropicResponse(response, {
    service: "fillAffidavit",
    userId,
    situationalContextId,
  });
  throwIfRefused(response, "fillAffidavit");

  const rawBlock = response.content.find((b) => b.type === "text");
  const rawText = rawBlock?.type === "text" ? rawBlock.text : "";
  const trimmed = rawText.trim();

  // Detect the skip JSON shape. It must be the whole response — partial JSON
  // (e.g. a JSON code-fence embedded inside filled markdown) is treated as
  // filled output.
  let status: "filled" | "skipped" = "filled";
  let reason: string | undefined;
  let filledMarkdown = rawText;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.skip === true) {
        status = "skipped";
        reason = typeof parsed.reason === "string" ? parsed.reason : "Not applicable.";
        filledMarkdown = "";
      }
    } catch {
      // Not valid JSON — treat as filled markdown (the affidavit may legitimately
      // begin and end with braces, though unlikely).
    }
  }

  // Persist
  const doc = await FilledAffidavit.create({
    processId,
    affidavitName,
    userId,
    situationalContextId,
    ...(beneficiaryKey ? { beneficiaryKey } : {}),
    status,
    filledMarkdown,
    ...(reason ? { reason } : {}),
    createdAt: new Date(),
  });

  console.log(
    status === "skipped"
      ? `[fillAffidavit] ⊘ ${affidavitName} — skipped: ${reason}`
      : `[fillAffidavit] ✅ ${affidavitName} — ${filledMarkdown.length} chars filled (saved ${doc._id})`
  );

  return doc.toObject() as IFilledAffidavit;
}

// ─── PDF rendering ────────────────────────────────────────────────────────────

export interface AffidavitPdfResult {
  affidavitName: string;
  outputPath: string;
}

export async function renderFilledAffidavitToPdf(
  filledAffidavit: IFilledAffidavit,
  outputDir: string
): Promise<AffidavitPdfResult> {
  if (filledAffidavit.status === "skipped") {
    throw new Error(`Affidavit "${filledAffidavit.affidavitName}" was skipped — no markdown to render.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeName = filledAffidavit.affidavitName.replace(/[^A-Za-z0-9._-]+/g, "_");
  const outputPath = path.join(outputDir, `${safeName}.pdf`);

  await markdownToPdf(filledAffidavit.filledMarkdown, outputPath);
  return { affidavitName: filledAffidavit.affidavitName, outputPath };
}
