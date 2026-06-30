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

export interface ProcessSummary {
  processId: string;
  readme: string | null;
  formIds: string[];
  affidavitNames: string[];
}

export function summarizeProcesses(): ProcessSummary[] {
  return listProcesses().map((processId) => ({
    processId,
    readme: getProcessReadme(processId),
    formIds: listFormsInProcess(processId),
    affidavitNames: listAffidavits(processId),
  }));
}

export function resolveProcessId(stored: string | undefined | null): string {
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  return DEFAULT_PROCESS_ID;
}
