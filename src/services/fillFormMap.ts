import { getAnthropicClient } from "../lib/anthropic";
import { FormMap } from "../models/FormMap";
import { FormContext } from "../models/FormContext";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import { logAnthropicResponse } from "../models/AnthropicLog";
import type {
  FillFormMapInput,
  IFilledFormMap,
  IFormMap,
  IFormContext,
  ISituationalContext,
  AssumptionLevel,
  FieldMap,
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
- Populate as many fields as possible, using explicit data, reasonable inference, and contextually supported derivation.
- Derive values when the source material strongly implies them — e.g. "No middle name" for an empty middle-name slot, a state derived from a city, or an alien number inferred from a receipt notice.
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
function buildSystemPrompt(assumptionLevel: AssumptionLevel): string {
  return `You are an expert immigration form-filling agent. Your job is to match real applicant and situational data to the correct fields on a government immigration form.

You will be given two inputs:
1. FORM CONTEXT — A structured knowledge base describing every field on the form. For each field you will see: its exact field ID, a precise description of what it asks for, which party it belongs to (Applicant, Petitioner, Preparer, etc.), and notes on formatting, edge cases, and sources.
2. SITUATIONAL CONTEXT — A structured JSON object containing all known information about the parties involved and the applicant's immigration situation, extracted from their documents and self-reported answers.

─────────────────────────────────────────────────────────────────────────────
CORE OBJECTIVE
─────────────────────────────────────────────────────────────────────────────

For every field ID present in the FORM CONTEXT, determine whether the situational context contains information that satisfies what that field is asking for. If it does, extract and format the value precisely. If it does not, the value must be an empty string ("").

Your output is a JSON object whose keys are every single field ID listed in the FORM CONTEXT — no more, no less. Every field ID must appear as a key. There are no optional keys.

RELEVANCY IS THE HIGHEST PRIORITY
- Always ask: "Does the situational context actually contain something that answers this field?"
- A field should only be filled if the data is relevant to BOTH the field's meaning AND this applicant's specific situation.
- Fields that belong to a party not present in this situation must be left blank (e.g. a "Petitioner" section when only an applicant is filing).
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
- Numbers and IDs: Reproduce exactly as they appear in the source — preserve leading zeros, dashes, and spacing.
- "N/A" vs blank: Use "N/A" only when the field's notes explicitly say to write N/A for inapplicable entries. Otherwise use "".
- Country names: Use the full English country name (e.g. "Brazil", not "BRA").
- State abbreviations: Use the standard two-letter postal abbreviation (e.g. "FL", "CA").
- All-caps fields: If the field's notes specify all caps, convert the value to uppercase.

─────────────────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────────────────

Return a single valid JSON object with this exact shape — no markdown fences, no text outside the JSON:

{
  "fields": {
    "<fieldId>": "<value or empty string>"
  },
  "skipped": [
    {
      "fieldId": "<fieldId>",
      "reason": "<brief explanation of why the field was left blank or flagged>"
    }
  ]
}

- "fields" must contain every field ID from the FORM CONTEXT — every single one, including those left blank.
- "skipped" should include any field where you were uncertain, found conflicting data, or applied an inference that may need human review. This is an audit log, not a penalty.`;
}

/**
 * Builds the user turn: serialises both inputs into a structured,
 * clearly delimited text block that the LLM can navigate without ambiguity.
 * The form map is not included here — the field IDs are already present
 * inside the annotated FORM CONTEXT section.
 */
function buildUserMessage(params: {
  formContext: IFormContext;
  situationalContext: ISituationalContext;
}): string {
  const { formContext, situationalContext } = params;
  const hr = "─".repeat(72);
  const parts: string[] = [];

  // ── 1. Situational context (first — it sets the stage) ────────────────────
  parts.push(hr);
  parts.push(`SITUATIONAL CONTEXT  |  userId: ${situationalContext.userId}`);
  parts.push(hr);
  parts.push(`Situation Summary:\n${situationalContext.situationSummary}`);
  parts.push(`\nParty & Situational Data:\n${JSON.stringify(situationalContext.partyData, null, 2)}`);

  // ── 2. Form metadata ──────────────────────────────────────────────────────
  parts.push(`\n${hr}`);
  parts.push(`FORM METADATA  |  formId: ${formContext.formId}`);
  parts.push(hr);
  parts.push(JSON.stringify(formContext.formMetadata, null, 2));

  // ── 3. Field-by-field context — every field ID the LLM must output ────────
  parts.push(`\n${hr}`);
  parts.push(`FORM CONTEXT  |  ${formContext.fields.length} fields  |  every field ID below must appear as a key in your output`);
  parts.push(hr);

  const contextLines: string[] = [];
  for (const fc of formContext.fields) {
    contextLines.push(
      `[${fc.field}]\n` +
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
    `Your output "fields" object must contain every one of the ${formContext.fields.length} field IDs above — no additions, no omissions.\n\n` +
    `Return the JSON object now.`
  );

  return parts.join("\n");
}

// ─── Data loading helpers ─────────────────────────────────────────────────────

async function loadFormMap(formId: string): Promise<IFormMap> {
  const doc = await FormMap.findOne({ formId }).sort({ createdAt: -1 }).lean();
  if (!doc) {
    throw new Error(`No FormMap found for formId "${formId}". Run buildFormMap first.`);
  }
  return doc as unknown as IFormMap;
}

async function loadFormContext(formId: string): Promise<IFormContext> {
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

function parseLLMResponse(raw: string, expectedFieldIds: string[]): LLMResponse {
  const cleaned = raw.replace(/^```(?:json)?\n?/i, "").replace(/\n?```$/i, "").trim();

  let parsed: LLMResponse;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse form map response for "${formId}".`);
  }

  if (!parsed.fields || typeof parsed.fields !== "object") {
    throw new Error(`fillFormMap response missing "fields" object.`);
  }

  // Ensure every expected field is present in the output — fill blanks for any
  // the LLM omitted so the FieldMap shape is always complete.
  const expectedSet = new Set(expectedFieldIds);
  const returnedSet = new Set(Object.keys(parsed.fields));

  const missing = [...expectedSet].filter((id) => !returnedSet.has(id));
  if (missing.length > 0) {
    console.warn(
      `[fillFormMap] LLM omitted ${missing.length} field(s) — backfilling with "":`,
      missing.slice(0, 10).join(", "),
      missing.length > 10 ? `...and ${missing.length - 10} more` : ""
    );
    for (const id of missing) {
      parsed.fields[id] = "";
    }
  }

  parsed.skipped = Array.isArray(parsed.skipped) ? parsed.skipped : [];

  return parsed;
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

// ─── Service ──────────────────────────────────────────────────────────────────

export async function fillFormMap(input: FillFormMapInput): Promise<IFilledFormMap> {
  const {
    formId,
    userId,
    situationalContextId,
    assumptionLevel = "conservative",
  } = input;

  // 1. Load form context + situational context for the prompt.
  //    Form map is loaded separately after the LLM call — it is not sent to
  //    the LLM. Its field IDs are already present inside the form context.
  console.log(`[fillFormMap] Loading prerequisites for "${formId}" / user "${userId}"...`);
  const [formContext, situationalContext] = await Promise.all([
    loadFormContext(formId),
    loadSituationalContext(situationalContextId),
  ]);

  // Field IDs are sourced from the context, not the map
  const fieldIds = formContext.fields.map((f) => f.field);
  if (fieldIds.length === 0) {
    throw new Error(`FormContext for "${formId}" has no fields. Ensure buildFormContext completed successfully.`);
  }

  console.log(
    `[fillFormMap] Prerequisites loaded — ` +
    `${fieldIds.length} fields from context, ` +
    `assumptionLevel: "${assumptionLevel}"`
  );

  // 2. Compress field keys for the prompt.
  //    Full XFA IDs (~22 tokens each) are replaced with short alphanumeric keys
  //    ("f0000"…"f9999", ~2 tokens each), saving ~14k tokens on a 736-field form.
  //    The keyMap is used after the response to expand short keys back to full IDs.
  const keyMap = buildKeyMap(fieldIds);
  const shortFieldIds = fieldIds.map((id) => keyMap.fullToShort[id]);
  const compressedFormContext = remapFormContextKeys(formContext, keyMap.fullToShort);

  // 3. Build prompts using the compressed FormContext
  const systemPrompt = buildSystemPrompt(assumptionLevel);
  const userMessage = buildUserMessage({ formContext: compressedFormContext, situationalContext });

  // 4. Anthropic call — claude-opus-4-5 for strong multi-document reasoning
  const client = getAnthropicClient();
  console.log(
    `[fillFormMap] Calling claude-opus-4-5 for "${formId}" — ` +
    `this may take a minute for large forms...`
  );

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 32000,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: userMessage }],
      },
    ],
  });

  // 5. Log full response payload to MongoDB (non-blocking)
  logAnthropicResponse(response, { service: "fillFormMap", formId, userId, situationalContextId });

  // 6. Parse and validate response (keys are still short at this point)
  const rawBlock = response.content.find((b) => b.type === "text");
  const rawText = rawBlock?.type === "text" ? rawBlock.text.trim() : "";
  const llmResultShort = parseLLMResponse(rawText, shortFieldIds);

  // 7. Expand short keys back to full XFA IDs before any downstream use
  const llmResult = expandLLMResult(llmResultShort, keyMap.shortToFull);

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

  // 9. Load the form map now — used only as the base for persisting the filled
  //    record so the FilledFormMap has the correct formId/version provenance.
  //    The LLM output already contains all the field values; we merge them in.
  const formMap = await loadFormMap(formId);
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
  const { formId, situationalContextId, assumptionLevel = "conservative" } = input;

  // Only the form context is needed to build the prompt — the form map is not
  // sent to the LLM, so it is not loaded here.
  const formContext = await loadFormContext(formId);

  // Apply the same key compression used by the live service so this output
  // exactly mirrors what Anthropic actually receives.
  const fieldIds = formContext.fields.map((f) => f.field);
  const keyMap = buildKeyMap(fieldIds);
  const compressedFormContext = remapFormContextKeys(formContext, keyMap.fullToShort);

  let situationalContext: ISituationalContext;

  if (situationalContextId) {
    situationalContext = await loadSituationalContext(situationalContextId);
  } else {
    // Template mode — emit placeholder so the caller can paste in real data
    situationalContext = {
      userId: "<<USER_ID>>",
      createdAt: new Date(),
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
    systemPrompt: buildSystemPrompt(assumptionLevel),
    userMessage: buildUserMessage({ formContext: compressedFormContext, situationalContext }),
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
    let assumptionLevel: AssumptionLevel = "conservative";

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

    // Resolve which forms to process
    let formIds: string[];
    if (formId) {
      formIds = [formId];
    } else {
      formIds = ((ctxDoc as any).requiredForms as string[] | undefined) ?? [];
      if (formIds.length === 0) {
        console.error("❌ No --formId given and SituationalContext has no requiredForms.");
        await disconnectDB();
        process.exit(1);
      }
      console.log(`[fillFormMap] No --formId given — using requiredForms: ${formIds.join(", ")}`);
    }
    let anyFailure = false;

    for (const fId of formIds) {
      try {
        const result = await fillFormMap({ formId: fId, userId, situationalContextId, assumptionLevel });
        const fields = result.fields as FieldMap;
        const filledCount = Object.values(fields).filter((v) => v !== "").length;
        const totalCount = Object.keys(fields).length;

        console.log(`\n✅ ${fId}`);
        console.log(`   Assumption    : ${result.assumptionLevel}`);
        console.log(`   Fields filled : ${filledCount} / ${totalCount}`);
        console.log(`   MongoDB _id   : ${(result as any)._id}`);
      } catch (err) {
        console.error(`\n❌ ${fId}: ${err instanceof Error ? err.message : err}`);
        anyFailure = true;
      }
    }

    console.log("");
    await disconnectDB();
    process.exit(anyFailure ? 1 : 0);
  })();
}
