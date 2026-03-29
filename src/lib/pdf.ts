import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import pdfParse from "pdf-parse";

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

/**
 * Fills a PDF using pdftk FDF template approach.
 * Returns the path to the filled output PDF.
 */
export function fillPdfWithPdftk(
  blankPdfPath: string,
  fieldData: Record<string, string>,
  outputPdfPath: string
): void {
  if (!isPdftkInstalled()) {
    throw new Error("pdftk is required. Install: brew install pdftk-java");
  }

  const checkboxStates = parseCheckboxStates(blankPdfPath);

  // Generate FDF template from the blank form
  const tempFdf = outputPdfPath + ".tmp.fdf";
  const templateResult = spawnSync("pdftk", [blankPdfPath, "generate_fdf", "output", tempFdf], {
    encoding: "utf-8",
  });
  if (templateResult.status !== 0) {
    throw new Error(`pdftk generate_fdf failed: ${templateResult.stderr}`);
  }

  let fdfContent = fs.readFileSync(tempFdf, "utf-8");

  // Patch values into the FDF
  for (const [fullFieldName, value] of Object.entries(fieldData)) {
    if (!value) continue;

    const parts = fullFieldName.split(".");
    const shortFieldName = parts[parts.length - 1];
    const escapedShort = shortFieldName.replace(/[[\]()]/g, "\\$&");
    const fieldOption = checkboxStates.get(fullFieldName);
    const isCheckbox = fieldOption?.isCheckbox && (value === "1" || value === "0");

    if (isCheckbox && value === "1") {
      const onState = fieldOption!.onState;
      const pattern = new RegExp(`(/T \\(${escapedShort}\\)\\s*\\n/V )/(?:Off|)`, "g");
      fdfContent = fdfContent.replace(pattern, `$1/${onState}`);
    } else if (!isCheckbox) {
      const encodedValue = encodeFdfValue(value);
      const pattern = new RegExp(`(/T \\(${escapedShort}\\)\\s*\\n/V )\\([^)]*\\)`, "g");
      fdfContent = fdfContent.replace(pattern, `$1${encodedValue}`);
    }
  }

  fs.writeFileSync(tempFdf, fdfContent);

  const fillResult = spawnSync("pdftk", [blankPdfPath, "fill_form", tempFdf, "output", outputPdfPath], {
    encoding: "utf-8",
  });

  fs.unlinkSync(tempFdf);

  if (fillResult.status !== 0) {
    throw new Error(`pdftk fill_form failed: ${fillResult.stderr}`);
  }
}
