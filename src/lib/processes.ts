import * as fs from "fs";
import * as path from "path";

const ASSETS_FORMS_DIR = path.resolve(__dirname, "../../assets/forms");

export const DEFAULT_PROCESS_ID = "aos";

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function getProcessDir(processId: string): string {
  return path.join(ASSETS_FORMS_DIR, processId);
}

export function getProcessFormsDir(processId: string): string {
  return getProcessDir(processId);
}

export function getBlankPdfPath(processId: string, formId: string): string {
  return path.join(ASSETS_FORMS_DIR, processId, formId, "blank.pdf");
}

export function getProcessReadmePath(processId: string): string {
  return path.join(ASSETS_FORMS_DIR, processId, "README.md");
}

export function getProcessReadme(processId: string): string | null {
  const p = getProcessReadmePath(processId);
  if (!isFile(p)) return null;
  try {
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}

export function listProcesses(): string[] {
  if (!isDirectory(ASSETS_FORMS_DIR)) return [];
  return fs
    .readdirSync(ASSETS_FORMS_DIR)
    .filter((name) => !name.startsWith("."))
    .filter((name) => isDirectory(path.join(ASSETS_FORMS_DIR, name)))
    .filter((name) => listFormsInProcess(name).length > 0)
    .sort();
}

export function processExists(processId: string): boolean {
  return isDirectory(getProcessDir(processId));
}

export function listFormsInProcess(processId: string): string[] {
  const dir = getProcessDir(processId);
  if (!isDirectory(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => isFile(path.join(dir, name, "blank.pdf")))
    .sort();
}

// ─── Affidavits ─────────────────────────────────────────────────────────────
//
// Affidavits are markdown templates with bracketed placeholders (e.g.
// `[STUDENT_FULL_LEGAL_NAME]`). They live under
// `assets/forms/<processId>/affidavits/<name>.md` and a process opts into
// them simply by creating the directory + dropping templates in. Code that
// consumes them gates on directory presence, not on processId.

export function getAffidavitsDir(processId: string): string {
  return path.join(getProcessDir(processId), "affidavits");
}

export function hasAffidavits(processId: string): boolean {
  return isDirectory(getAffidavitsDir(processId));
}

export function listAffidavits(processId: string): string[] {
  const dir = getAffidavitsDir(processId);
  if (!isDirectory(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => name.toLowerCase().endsWith(".md"))
    .filter((name) => isFile(path.join(dir, name)))
    .map((name) => name.replace(/\.md$/i, ""))
    .sort();
}

export function getAffidavitPath(processId: string, affidavitName: string): string {
  return path.join(getAffidavitsDir(processId), `${affidavitName}.md`);
}

export function readAffidavitTemplate(processId: string, affidavitName: string): string {
  return fs.readFileSync(getAffidavitPath(processId, affidavitName), "utf-8");
}

// ─── Language bias (optional) ────────────────────────────────────────────────
//
// A process MAY ship a `languages.txt` listing Tesseract language codes the
// user is expected to provide documents in (e.g. "eng", "ita", "spa"). When
// present, OCR uses those languages and the fill prompts include a light hint
// about expected document languages. When absent, the pipeline falls back to
// its default behavior — appropriate for processes (like AoS) where the user
// may upload anything.

export function getProcessLanguagesPath(processId: string): string {
  return path.join(getProcessDir(processId), "languages.txt");
}

export function hasProcessLanguages(processId: string): boolean {
  return isFile(getProcessLanguagesPath(processId));
}

/**
 * Returns the parsed Tesseract language codes for a process, or `null` when
 * the process has no `languages.txt`. Format: one code per line, blank lines
 * and `#` comments ignored, whitespace trimmed.
 */
export function listProcessLanguages(processId: string): string[] | null {
  const p = getProcessLanguagesPath(processId);
  if (!isFile(p)) return null;
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const codes = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    return codes;
  } catch {
    return null;
  }
}

/**
 * Returns the Tesseract-formatted language string for a process
 * (e.g. "eng+ita+spa"), or `null` when the process has no `languages.txt`.
 * Pass this directly to `Tesseract.recognize`.
 */
export function getProcessLanguagesTesseractString(processId: string): string | null {
  const codes = listProcessLanguages(processId);
  if (!codes || codes.length === 0) return null;
  return codes.join("+");
}

export interface ProcessSummary {
  processId: string;
  readme: string | null;
  formIds: string[];
  affidavitNames: string[];
  /** Tesseract language codes the process expects. `null` when not opted in. */
  languages: string[] | null;
}

export function summarizeProcesses(): ProcessSummary[] {
  return listProcesses().map((processId) => ({
    processId,
    readme: getProcessReadme(processId),
    formIds: listFormsInProcess(processId),
    affidavitNames: listAffidavits(processId),
    languages: listProcessLanguages(processId),
  }));
}

export function resolveProcessId(stored: string | undefined | null): string {
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  return DEFAULT_PROCESS_ID;
}
