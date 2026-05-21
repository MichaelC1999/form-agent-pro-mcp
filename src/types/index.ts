// ─── Shared domain types ───────────────────────────────────────────────────

export type AssumptionLevel = "conservative" | "moderate" | "liberal";

// Raw field map as stored in MongoDB – keys are PDF field IDs, values are strings
export type FieldMap = Record<string, string>;

// ─── FormMap ────────────────────────────────────────────────────────────────

export interface IFormMap {
  formId: string;
  version: string;
  createdAt: Date;
  fields: FieldMap; // { "<fieldId>": "" }
}

// ─── FormContext ─────────────────────────────────────────────────────────────

export interface FormFieldContext {
  field: string;
  description: string;
  party: string;
  notes: string;
}

export interface FormMetadata {
  purpose: string;
  situations: string;
  "use-cases": string;
  [key: string]: string;
}

export interface IFormContext {
  formId: string;
  createdAt: Date;
  formMetadata: FormMetadata;
  fields: FormFieldContext[];
}

// ─── SituationalContext ──────────────────────────────────────────────────────

export type DocumentMimeCategory = "pdf" | "image" | "text";

export interface ParsedDocument {
  /** Original filename as uploaded */
  originalName: string;
  /** Broad file category used to select the parsing strategy */
  mimeCategory: DocumentMimeCategory;
  /** Raw text extracted by OCR / pdf-parse before the LLM sees it */
  rawText: string;
  /**
   * Structured facts extracted from this single document by the per-document
   * Claude extraction call. Present only when EXTRACTION_MODE=per_document.
   * Shape is open — mirrors what the extraction prompt emits per doc.
   */
  extractedFacts?: Record<string, unknown>;
  uploadedAt: Date;
}

/**
 * Open-ended party/subject map returned by the Anthropic call.
 * Top-level keys are party names or situational subjects
 * (e.g. "Jane Mary Doe", "Marriage (Brazil, 2024)").
 * Values are free-form key→value bags of extracted facts.
 * Mirrors the shape of context/party-situational.json.
 */
export type PartyDataMap = Record<string, Record<string, unknown>>;

export type SituationalContextStatus = "processing" | "ready" | "error";

/**
 * A single form the situation requires. The beneficiaryKey is the name of
 * the party in partyData this form should be filled for (e.g. "Maria Souza"
 * when a parent is petitioning for two children, each needing their own
 * I-130). Forms filed once per household (I-864 from the petitioner, N-400,
 * etc.) omit beneficiaryKey.
 *
 * On read the value may also be a bare string (legacy single-beneficiary
 * records pre-dating multi-beneficiary support). Use
 * `normalizeRequiredForms` at every read site to convert.
 */
export interface RequiredFormEntry {
  formId: string;
  beneficiaryKey?: string;
}

export type RequiredFormsStored = Array<RequiredFormEntry | string>;

export interface ISituationalContext {
  userId: string;
  createdAt: Date;
  /** Pipeline processing status */
  status: SituationalContextStatus;
  /**
   * Structured party/subject data extracted by the LLM from all documents
   * and UI inputs combined.
   */
  partyData: PartyDataMap;
  /** Raw parsed documents kept for audit / re-processing */
  documents: ParsedDocument[];
  /** 2-3 sentence summary of the process the user is trying to accomplish */
  situationSummary: string;
  /**
   * Ordered list of USCIS forms the LLM determined are required for this
   * situation. Stored as a mixed array — entries are either bare form ID
   * strings (legacy) or `{ formId, beneficiaryKey? }` objects (current).
   * Always read through `normalizeRequiredForms` to handle both shapes.
   */
  requiredForms: RequiredFormsStored;
}

/**
 * Normalises the mixed-shape `requiredForms` array into the rich
 * RequiredFormEntry shape. Legacy string entries become entries with no
 * beneficiaryKey (single-beneficiary semantics).
 */
export function normalizeRequiredForms(
  raw: RequiredFormsStored | undefined | null
): RequiredFormEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (typeof entry === "string") return { formId: entry };
      if (entry && typeof entry === "object" && typeof entry.formId === "string") {
        const out: RequiredFormEntry = { formId: entry.formId };
        if (typeof entry.beneficiaryKey === "string" && entry.beneficiaryKey.trim() !== "") {
          out.beneficiaryKey = entry.beneficiaryKey;
        }
        return out;
      }
      return null;
    })
    .filter((e): e is RequiredFormEntry => e !== null);
}

// ─── FilledFormMap ───────────────────────────────────────────────────────────

export interface SkippedField {
  fieldId: string;
  reason: string;
}

export interface IFilledFormMap {
  formId: string;
  userId: string;
  createdAt: Date;
  assumptionLevel: AssumptionLevel;
  /**
   * Which beneficiary in the situational context this fill belongs to.
   * Absent for forms filed once per household (I-864, N-400, etc.) and for
   * legacy single-beneficiary records.
   */
  beneficiaryKey?: string;
  fields: FieldMap; // { "<fieldId>": "filled value" }
  skipped: SkippedField[]; // fields the LLM could not confidently fill
}

// ─── Service request/response shapes ────────────────────────────────────────

export interface UIAnswers {
  /** Free-text description of the user's immigration situation */
  situationDescription: string;
  /** The immigration goal or process the user wants to pursue (e.g. "apply for green card through marriage to a US citizen") */
  processDescription: string;
  /** Any additional open-ended notes from the UI */
  additionalNotes?: string;
  /**
   * Explicit beneficiary count from the UI. Optional; when omitted the model
   * infers the structure from documents + descriptions (single-beneficiary
   * default). Sent only when the user picked >1 in the workflow.
   */
  beneficiaryCount?: number;
  /**
   * Optional beneficiary names from the UI, in the order shown in the form.
   * Strings here become hints for what the model's `beneficiaryKey` values
   * should look like in partyData.
   */
  beneficiaryNames?: string[];
}

export interface UploadedFile {
  /** Temp path on disk after multer writes it */
  path: string;
  /** Original filename from the client */
  originalname: string;
  /** MIME type reported by the client */
  mimetype: string;
}

export interface BuildSituationContextInput {
  userId: string;
  uiAnswers: UIAnswers;
  uploadedFiles: UploadedFile[];
}

export interface BuildFormContextInput {
  formId: string;
  formPdfPath: string;
  contextFilePaths?: string[]; // supplemental markdown / docs
}

export interface BuildFormMapInput {
  formId: string;
  formPdfPath: string;
  version?: string;
}

export interface FillFormMapInput {
  formId: string;
  userId: string;
  situationalContextId: string;
  assumptionLevel?: AssumptionLevel;
  /**
   * Optional party key inside the situational context that this fill is for.
   * When set, the LLM is told to use only that beneficiary's data (plus the
   * petitioner's where required) and ignore other beneficiaries.
   */
  beneficiaryKey?: string;
}

/**
 * Discriminator for the form medium being filled.
 * Only "pdf" is implemented today; extend this union as new form types
 * (e.g. "web") are added and handled in fillForm.ts.
 */
export type FormType = "pdf"; // | "web" | ...

export interface FillFormInput {
  formId: string;
  userId: string;
  /** MongoDB _id of the FilledFormMap document to read values from */
  filledFormMapId: string;
  /** Absolute or project-relative path to the blank PDF template for this form */
  formPdfPath: string;
  /** Directory to write the filled output file into. Defaults to output/<formId>/ */
  outputDir?: string;
  /** Form medium to fill. Defaults to "pdf" */
  formType?: FormType;
}

export interface FillFormOutput {
  success: boolean;
  outputPath: string;
  filledFields: string[];
  skippedFields: string[];
  errors: string[];
}

export interface ExtractPdfInput {
  pdfPath: string;
  existingMapId?: string; // if provided, update that map; else create new
}

// ─── AppError ─────────────────────────────────────────────────────────────────

/**
 * Categorises every error we persist so we can filter quickly in MongoDB.
 *
 *  anthropic_content        — Claude returned a structured `{ error: ... }`
 *                              JSON object (insufficient context, etc.)
 *  anthropic_parse          — Claude response could not be parsed as JSON
 *  anthropic_api            — Anthropic SDK threw (rate limit, network, etc.)
 *  validation               — Request failed input validation
 *  not_found                — Required resource was missing
 *  auth                     — Auth/permission failure
 *  payment                  — Stripe / payment gate failure
 *  pdf                      — pdftk / pdf-lib / file-system failure
 *  server                   — Catch-all unexpected exception
 */
export type AppErrorType =
  | "anthropic_content"
  | "anthropic_parse"
  | "anthropic_api"
  | "validation"
  | "not_found"
  | "auth"
  | "payment"
  | "pdf"
  | "server";

export interface IAppError {
  /** What kind of failure this is (see AppErrorType above) */
  errorType: AppErrorType;
  /** Service or module that detected the failure (e.g. "fillFormMap") */
  service: string;
  /** HTTP route that handled the request (e.g. "POST /api/pipeline/run") */
  route?: string;
  /** Human-readable summary */
  message: string;
  /** Optional stack trace for server-side errors */
  stack?: string;
  /** Optional short code surfaced by Claude or thrown by a service */
  code?: string;
  /** Client IP of the request that triggered this error */
  ipAddress?: string;
  /** Authenticated user's email (from Google sign-in payload) */
  userEmail?: string;
  /** Authenticated user's sub id */
  userId?: string;
  /** Optional form ID context */
  formId?: string;
  /** Optional SituationalContext ID context */
  situationalContextId?: string;
  /** Free-form payload for service-specific detail (LLM error JSON, etc.) */
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

// ─── AnthropicLog ─────────────────────────────────────────────────────────────

export interface IAnthropicLog {
  /** Service that triggered the LLM call (e.g. "fillFormMap", "buildFormContext") */
  service: string;
  /** Model ID returned by the Anthropic response (e.g. "claude-opus-4-5") */
  anthropicModel: string;
  /** Optional — form ID for form-scoped calls */
  formId?: string;
  /** Optional — user ID for user-scoped calls */
  userId?: string;
  /** Optional — SituationalContext ID for fillFormMap calls */
  situationalContextId?: string;
  /** response.stop_reason from the Anthropic API */
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** The complete raw Anthropic response object */
  payload: Record<string, unknown>;
  createdAt: Date;
}
