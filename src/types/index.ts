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
   * Ordered list of USCIS form IDs the LLM determined are required for this
   * situation (e.g. ["i-485", "i-130", "i-864"]).  Used by downstream
   * pipeline steps to know which forms to fill.
   */
  requiredForms: string[];
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
