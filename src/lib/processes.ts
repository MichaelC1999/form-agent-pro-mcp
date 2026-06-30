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

export interface ProcessSummary {
  processId: string;
  readme: string | null;
  formIds: string[];
}

export function summarizeProcesses(): ProcessSummary[] {
  return listProcesses().map((processId) => ({
    processId,
    readme: getProcessReadme(processId),
    formIds: listFormsInProcess(processId),
  }));
}

export function resolveProcessId(stored: string | undefined | null): string {
  if (typeof stored === "string" && stored.trim() !== "") return stored;
  return DEFAULT_PROCESS_ID;
}
