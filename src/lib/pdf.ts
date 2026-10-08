import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import pdfParse from "pdf-parse";
import type { FieldMeta } from "../types";

export type PdfFieldInfo = {
  name: string;
  type: string;
  value: string;
  stateOptions: string[];
};

// ─── Tool availability ────────────────────────────────────────────────────────

export function isPdftkInstalled(): boolean {
  try {
    execSync("pdftk --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function isQpdfInstalled(): boolean {
  try {
    execSync("qpdf --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// ─── Field extraction via pdftk ───────────────────────────────────────────────

/**
 * Returns all field names from a PDF as a blank { fieldId: "" } map.
 * Used by buildFormMap.
 */
export function extractFieldMap(pdfPath: string): Record<string, string> {
  if (!isPdftkInstalled()) {
    throw new Error("pdftk is required for field extraction. Install: brew install pdftk-java");
  }

  const result = spawnSync("pdftk", [pdfPath, "dump_data_fields"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`pdftk dump_data_fields failed: ${result.stderr}`);
  }

  const fieldMap: Record<string, string> = {};
  const matches = result.stdout.matchAll(/FieldName: (.+)/g);
  for (const match of matches) {
    fieldMap[match[1].trim()] = "";
  }
  return fieldMap;
}

/**
 * Returns field names with current values + type info from a filled PDF.
 * Used by extractPdf service.
 */
export function extractFieldValues(pdfPath: string): Map<string, PdfFieldInfo> {
  if (!isPdftkInstalled()) {
    throw new Error("pdftk is required. Install: brew install pdftk-java");
  }

  const result = spawnSync("pdftk", [pdfPath, "dump_data_fields"], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`pdftk dump_data_fields failed: ${result.stderr}`);
  }

  const fields = new Map<string, PdfFieldInfo>();
  const blocks = result.stdout.split("---").filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let name = "";
    let type = "";
    let value = "";
    const stateOptions: string[] = [];

    for (const line of lines) {
      const nm = line.match(/^FieldName: (.+)$/);
      if (nm) name = nm[1].trim();
      const tm = line.match(/^FieldType: (.+)$/);
      if (tm) type = tm[1].trim();
      const vm = line.match(/^FieldValue: (.*)$/);
      if (vm) value = vm[1];
      const sm = line.match(/^FieldStateOption: (.*)$/);
      if (sm) stateOptions.push(sm[1]);
    }

    if (name) {
      fields.set(name, { name, type, value, stateOptions });
    }
  }

  return fields;
}

export type PdfFieldLabel = {
  /** The field's tooltip (/TU) — USCIS forms use it as the full printed question + answer option */
  tooltip: string;
  type: string;
  /** For checkboxes/radios: the value the box writes when checked (e.g. "Y", "N", "APT", "BLU") */
  onValue?: string;
};

/** Runs pdftk dump_data_fields_utf8 and returns one text block per field, or [] when pdftk is unavailable or fails. */
function dumpFieldBlocks(pdfPath: string): string[] {
  if (!isPdftkInstalled()) return [];
  const result = spawnSync("pdftk", [pdfPath, "dump_data_fields_utf8"], { encoding: "utf-8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/^---$/m);
}

const blockName = (block: string) => block.match(/^FieldName: (.+)$/m)?.[1]?.trim();
const blockType = (block: string) => block.match(/^FieldType: (.+)$/m)?.[1]?.trim() ?? "";
const blockOptions = (block: string) => [...block.matchAll(/^FieldStateOption: (.*)$/gm)].map((m) => m[1].trim());

/**
 * Returns the tooltip, type, and checked value of every field in a blank PDF.
 * Uses dump_data_fields_utf8 so tooltips keep their original punctuation.
 * Returns an empty map when pdftk is unavailable or fails — callers treat
 * labels as optional enrichment.
 */
export function readFieldLabels(pdfPath: string): Map<string, PdfFieldLabel> {
  const labels = new Map<string, PdfFieldLabel>();
  for (const block of dumpFieldBlocks(pdfPath)) {
    const name = blockName(block);
    if (!name) continue;
    const tooltip = (block.match(/^FieldNameAlt: (.+)$/m)?.[1] ?? "").replace(/\s+/g, " ").trim();
    const type = blockType(block);
    const onValue = type === "Button" ? blockOptions(block).find((s) => s !== "" && s !== "Off") : undefined;
    labels.set(name, { tooltip, type, ...(onValue ? { onValue } : {}) });
  }
  return labels;
}

/**
 * Returns the input constraints of every fillable field in a blank PDF —
 * only what decides whether a value can be written as-is: checkbox vs text vs
 * dropdown, a checkbox's checked value, a text field's max length (pdftk
 * truncates past it), and a dropdown's accepted values. Push buttons and
 * signature fields are omitted.
 */
export function readFieldMeta(pdfPath: string): Record<string, FieldMeta> {
  const meta: Record<string, FieldMeta> = {};
  for (const block of dumpFieldBlocks(pdfPath)) {
    const name = blockName(block);
    if (!name) continue;
    const type = blockType(block);
    if (type === "Button") {
      const onValue = blockOptions(block).find((s) => s !== "" && s !== "Off");
      if (onValue) meta[name] = { type: "checkbox", onValue };
    } else if (type === "Choice") {
      meta[name] = { type: "dropdown", options: blockOptions(block).filter((s) => s !== "") };
    } else if (type === "Text") {
      const maxLength = Number(block.match(/^FieldMaxLength: (\d+)$/m)?.[1]);
      meta[name] = maxLength > 0 ? { type: "text", maxLength } : { type: "text" };
    }
  }
  return meta;
}

// ─── PDF text extraction (for document parsing) ──────────────────────────────

/**
 * Extracts raw text from a PDF using pdf-parse. Used when ingesting user documents.
 */
export async function extractTextFromPdf(pdfPath: string): Promise<string> {
  const buffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(buffer);
  return data.text;
}

// ─── FDF generation & form filling ──────────────────────────────────────────

type CheckboxInfo = { onState: string; isCheckbox: boolean };

/**
 * Parses pdftk dump output to get checkbox "on" state values.
 * Only sees AcroForm-registered fields (may miss orphaned widgets).
 */
export function parseCheckboxStates(pdfPath: string): Map<string, CheckboxInfo> {
  const result = spawnSync("pdftk", [pdfPath, "dump_data_fields"], { encoding: "utf-8" });
  if (result.status !== 0) return new Map();

  const map = new Map<string, CheckboxInfo>();
  const lines = result.stdout.split("\n");
  let currentField = "";
  let stateOptions: string[] = [];

  const flush = () => {
    if (currentField && stateOptions.length > 0) {
      const onState = stateOptions.find((o) => o !== "Off" && o.trim() !== "");
      if (onState) {
        map.set(currentField, { onState: onState.trim(), isCheckbox: true });
      }
    }
  };

  for (const line of lines) {
    const fnm = line.match(/^FieldName: (.+)$/);
    if (fnm) {
      flush();
      currentField = fnm[1].trim();
      stateOptions = [];
      continue;
    }
    const som = line.match(/^FieldStateOption: (.*)$/);
    if (som) stateOptions.push(som[1]);
  }
  flush();

  return map;
}

// ─── FDF string encoding ─────────────────────────────────────────────────────

/**
 * Encodes a text value for embedding in an FDF file.
 *
 * FDF `()` literal strings use PDFDocEncoding (essentially Latin-1).  When a
 * UTF-8 string is written verbatim into such a literal, pdftk reads the raw
 * bytes one-at-a-time through the Latin-1 lens: the two-byte UTF-8 sequence
 * for "ã" (0xC3 0xA3) becomes the two Latin-1 characters "Ã£", producing the
 * classic mojibake (e.g. "São Paulo" → "SÃ£o Paulo").
 *
 * For pure ASCII values the `()` form is fine and produces the smallest FDF.
 * For any value that contains a non-ASCII codepoint we switch to a UTF-16 BE
 * hex string prefixed with the Unicode BOM (U+FEFF).  Per PDF spec §7.3.4,
 * a hex string whose first two bytes are FE FF is interpreted as UTF-16 BE,
 * which correctly represents every Unicode codepoint in the BMP — sufficient
 * for all name/address characters that appear on USCIS forms.
 */
function encodeFdfValue(value: string): string {
  if (!/[^\x00-\x7F]/.test(value)) {
    // Pure ASCII — use compact `()` literal, escaping PDF-special chars.
    return (
      "(" +
      value
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)") +
      ")"
    );
  }

  // Non-ASCII — encode as UTF-16 BE hex string with BOM so pdftk (and PDF
  // viewers) interpret the bytes as Unicode rather than PDFDocEncoding.
  let hex = "FEFF"; // UTF-16 BE BOM
  for (let i = 0; i < value.length; i++) {
    hex += value.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  }
  return `<${hex}>`;
}

// ─── Checkbox on-state inference ─────────────────────────────────────────────

/**
 * Infers the checkbox "on" state from the short field name.
 *
 * USCIS forms use consistent naming conventions:
 *  - _YN[0] / _YN[1]         → Y / N  (Yes / No)
 *  - _YesNo[0] / _YesNo[1]   → Y / N
 *  - _CB_Sex[0] / _CB_Sex[1] → M / F  (Male / Female)
 *  - _CB[N] / _Checkbox[N]   → 1 (generic toggle)
 *  - Numbered suffixes        → the index itself (1, 2, 3...)
 *
 * When the on-state can't be determined from naming, defaults to "1".
 */
function inferCheckboxOnState(shortFieldName: string): string {
  // Extract the array index [N]
  const idxMatch = shortFieldName.match(/\[(\d+)\]$/);
  const idx = idxMatch ? parseInt(idxMatch[1], 10) : 0;
  // Base name without [N]
  const base = shortFieldName.replace(/\[\d+\]$/, "");

  // Yes/No fields: [0] = Yes (Y), [1] = No (N)
  if (/_YN$/.test(base) || /_YesNo$/.test(base)) {
    return idx === 0 ? "Y" : "N";
  }

  // Sex fields: [0] = Male, [1] = Female
  if (/_CB_Sex$/.test(base)) {
    return idx === 0 ? "M" : "F";
  }

  // Generic checkbox/toggle fields
  if (/_CB$/.test(base) || /_Checkbox$/.test(base)) {
    return "1";
  }

  // Address unit type (Apt/Ste/Flr)
  if (/_Unit\[0\]$/.test(shortFieldName)) return "APT";
  if (/_Unit\[1\]$/.test(shortFieldName)) return "STE";
  if (/_Unit\[2\]$/.test(shortFieldName)) return "FLR";

  // Default: use "1" — works for most generic checkboxes
  return "1";
}

// ─── FDF template patching (handles XFA orphaned widgets) ────────────────────

/**
 * Fills a PDF using pdftk's FDF template approach.
 *
 * For XFA-style USCIS forms, many fields are "orphaned widgets" not registered
 * in the AcroForm /Fields hierarchy. pdftk's `dump_data_fields` only sees the
 * AcroForm fields (~13 for I-485), but `generate_fdf` produces a complete FDF
 * template with the correct nested /Kids structure covering ALL fields (~820).
 *
 * This function:
 *  1. Generates the FDF template via `pdftk generate_fdf`
 *  2. Identifies checkbox vs text fields from the template
 *  3. Patches values into the template using short field name matching
 *  4. Determines checkbox on-states from pdftk (AcroForm) + naming conventions
 *  5. Fills the PDF with the patched template via `pdftk fill_form`
 */
export function fillPdfWithPdftk(
  blankPdfPath: string,
  fieldData: Record<string, string>,
  outputPdfPath: string
): void {
  if (!isPdftkInstalled()) {
    throw new Error("pdftk is required. Install: brew install pdftk-java");
  }

  // ── 1. Get on-states for AcroForm-registered checkbox fields ──────────
  const pdftkStates = parseCheckboxStates(blankPdfPath);

  // ── 2. Generate FDF template ──────────────────────────────────────────
  const tempFdf = outputPdfPath + ".tmp.fdf";
  const templateResult = spawnSync(
    "pdftk",
    [blankPdfPath, "generate_fdf", "output", tempFdf],
    { encoding: "utf-8" }
  );
  if (templateResult.status !== 0) {
    throw new Error(`pdftk generate_fdf failed: ${templateResult.stderr}`);
  }

  let fdfContent = fs.readFileSync(tempFdf, "utf-8");

  // ── 3. Build short name → value lookup from our field data ────────────
  const shortNameToValue = new Map<string, { value: string; fullName: string }>();
  for (const [fullName, value] of Object.entries(fieldData)) {
    if (!value) continue;
    const parts = fullName.split(".");
    const shortName = parts[parts.length - 1];
    // If multiple full names map to the same short name, last one wins
    shortNameToValue.set(shortName, { value, fullName });
  }

  // ── 4. Parse the FDF template line-by-line and patch values ───────────
  //
  // The template contains blocks like:
  //   <<
  //   /T (Pt1Line3_YN[1])
  //   /V /Off
  //   >>
  // or:
  //   <<
  //   /T (Pt1Line2a_FamilyName[0])
  //   /V ()
  //   >>
  //
  // For checkbox fields (/V /...), we replace the value with the on-state.
  // For text fields (/V (...)), we replace with the encoded value.
  //
  const lines = fdfContent.split("\n");
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const tMatch = lines[i].match(/\/T \((.+?)\)/);
    if (!tMatch) {
      result.push(lines[i]);
      continue;
    }

    const shortName = tMatch[1];
    const entry = shortNameToValue.get(shortName);

    // No data for this field — pass through unchanged
    if (!entry) {
      result.push(lines[i]);
      continue;
    }

    const { value, fullName } = entry;

    // Look ahead for the /V line (within next 2 lines)
    let vLineIdx = -1;
    for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
      if (lines[j].trim().startsWith("/V ")) {
        vLineIdx = j;
        break;
      }
    }

    if (vLineIdx === -1) {
      // No /V line found nearby — pass through
      result.push(lines[i]);
      continue;
    }

    // Push the /T line as-is
    result.push(lines[i]);

    // Copy any lines between /T and /V
    for (let j = i + 1; j < vLineIdx; j++) {
      result.push(lines[j]);
    }

    const vLine = lines[vLineIdx].trim();
    const isCheckbox = vLine.startsWith("/V /");

    if (isCheckbox && (value === "1" || value === "0")) {
      if (value === "1") {
        // Determine the on-state:
        // 1. Check pdftk AcroForm states (authoritative for registered fields)
        // 2. Fall back to naming-convention inference
        const pdftkInfo = pdftkStates.get(fullName);
        const onState = pdftkInfo?.onState ?? inferCheckboxOnState(shortName);
        result.push(`/V /${onState}`);
      } else {
        // value === "0" → leave unchecked
        result.push("/V /Off");
      }
    } else if (!isCheckbox) {
      // Text field — replace /V () with encoded value
      result.push(`/V ${encodeFdfValue(value)}`);
    } else {
      // Checkbox with a non-0/1 value — treat as text (shouldn't happen normally)
      result.push(`/V ${encodeFdfValue(value)}`);
    }

    // Skip past the original /V line since we wrote a replacement
    i = vLineIdx;
  }

  fdfContent = result.join("\n");
  fs.writeFileSync(tempFdf, fdfContent);

  // ── 5. Fill the PDF with the patched template ─────────────────────────
  const fillResult = spawnSync(
    "pdftk",
    [blankPdfPath, "fill_form", tempFdf, "output", outputPdfPath],
    { encoding: "utf-8" }
  );

  fs.unlinkSync(tempFdf);

  if (fillResult.status !== 0) {
    throw new Error(`pdftk fill_form failed: ${fillResult.stderr}`);
  }
}
