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

/**
 * Where in the filing a form is filed. Drives whether requiredForms entries
 * for this form need a beneficiaryKey or not.
 *   "per-beneficiary" — one filing per beneficiary (e.g. I-485, I-130)
 *   "household"       — one filing per sponsor unit (e.g. I-864, N-400)
 */
export type FormScope = "per-beneficiary" | "household";

export interface FormMetadata {
  purpose: string;
  situations: string;
  "use-cases": string;
  /** See FormScope. Absent on legacy FormContexts — treat as "per-beneficiary". */
  scope?: FormScope;
  [key: string]: string | FormScope | undefined;
}

export interface IFormContext {
  formId: string;
  createdAt: Date;
  formMetadata: FormMetadata;
  fields: FormFieldContext[];
  /**
   * Processes this form belongs to (e.g. ["aos"]). A form can apply to more
   * than one process. Absent on legacy FormContexts — readers fall back to
   * `[DEFAULT_PROCESS_ID]` when present is required.
   */
  applicableProcesses?: string[];
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
 * (e.g. an applicant's full name, "Marriage (2024)", "US Immigration Context").
 * Values are free-form key→value bags of extracted facts.
 * Mirrors the shape of context/party-situational.json.
 */
export type PartyDataMap = Record<string, Record<string, unknown>>;

export type SituationalContextStatus = "processing" | "ready" | "error";

/**
 * A single (form, beneficiary) pair the background pipeline tried and failed
 * to generate a FilledFormMap for. The report UI uses this list to render
 * "Not generated" instead of an indefinite "Pending" spinner.
 */
export interface FormGenerationFailure {
  formId: string;
  beneficiaryKey?: string;
  /** Short Claude error code (e.g. "missing_required_party") when available. */
  code?: string;
  /** Human-readable reason — surfaced to the UI. */
  reason: string;
  failedAt: Date;
}

/**
 * One round of user-provided clarification for a specific (form, beneficiary)
 * pair. Created when the user retries a "Not generated" row on the /report
 * page. fillFormMap reads matching entries on every subsequent call and
 * injects them as ADDITIONAL CONTEXT in the prompt so the model has the
 * extra information when re-attempting the fill.
 */
export interface AdditionalContext {
  /** Which form this clarification is scoped to. */
  formId: string;
  /** Which beneficiary it's scoped to. Absent for household-scope forms. */
  beneficiaryKey?: string;
  /** Free-text note typed by the user. May be empty if only files supplied. */
  userNote: string;
  /** Parsed text and metadata for each file the user attached on this retry. */
  documents: ParsedDocument[];
  createdAt: Date;
}

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
   * Identifier of the form-filling process this context belongs to (e.g.
   * "aos", "k1-fiance"). Set by buildSituationContext. Read by every later
   * stage to scope asset lookup and prompts. Legacy docs may not have this
   * field — resolveProcessId() falls back to DEFAULT_PROCESS_ID.
   */
  processId?: string;
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
  /**
   * Set by the background pipeline once it has finished iterating over every
   * required form (success OR fail). The frontend uses presence of this
   * timestamp to flip per-form rows from "Pending" to "Not generated" when no
   * FilledFormMap was produced.
   */
  pipelineCompletedAt?: Date;
  /**
   * (form, beneficiary) pairs the background pipeline tried and failed to
   * generate. Mirrors AppError but lives on the context so the report UI can
   * surface failures without a separate query.
   */
  failedForms?: FormGenerationFailure[];
  /**
   * User-provided clarifications attached to specific (form, beneficiary)
   * pairs via the retry flow on the report page. Each entry is appended on
   * retry; fillFormMap injects matching entries into the prompt so the model
   * sees the additional context on subsequent generations.
   */
  additionalContexts?: AdditionalContext[];
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
   * Identifier of the process this fill was generated for. Inherited from the
   * SituationalContext at fill time. Absent on legacy fills.
   */
  processId?: string;
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
  /**
   * Optional pre-flight hint at which process this submission belongs to —
   * typically supplied by the frontend's "what are you applying for?" step.
   * The Stage 1 LLM is still the authority on the final processId; the hint
   * is used only to pick OCR languages from the matching process's
   * `languages.txt` (when present). Without a hint, OCR uses its default.
   */
  processIdHint?: string;
}

export interface BuildFormContextInput {
  formId: string;
  formPdfPath: string;
  contextFilePaths?: string[]; // supplemental markdown / docs
  /**
   * Process(es) the caller wants this form annotated for. The LLM picks the
   * subset of these that genuinely apply. When omitted, the list of all known
   * processes (from `listProcesses()`) is shown to the LLM.
   */
  candidateProcessIds?: string[];
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
  /**
   * Optional override for the process this fill belongs to. When omitted, the
   * service reads it from the loaded SituationalContext.
   */
  processId?: string;
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
