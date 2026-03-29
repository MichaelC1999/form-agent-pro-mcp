# Skill: buildFormContext

## Purpose

Annotates every fillable field in a form with rich, specific metadata (description, party, notes) using an Anthropic LLM call. The LLM is given the form's full narrative PDF text, a structured JSON field catalog (with USCIS-authored alt-text per field), and optional supplemental reference documents. The result is saved to MongoDB as a `FormContext` document and is a required prerequisite for `fillFormMap`.

**Run once per supported form. Thoroughness over speed — heavy model, high token budget.**

---

## Pre-requisites

- A `FormMap` document must already exist in MongoDB for the given `formId` (produced by `buildFormMap`).
- The blank PDF form must be accessible at a server-side file path.
- `pdftk` installed (strongly recommended — enables rich field alt-text extraction).

---

## Input

| Parameter          | Type       | Required | Description |
|--------------------|------------|----------|-------------|
| `formId`           | `string`   | ✅       | Matches an existing `FormMap` in MongoDB |
| `formPdfPath`      | `string`   | ✅       | Absolute path to the blank PDF form |
| `contextFilePaths` | `string[]` | ❌       | Paths to supplemental reference files (markdown, official form instructions PDFs, policy notes) |

---

## Processing Flow

1. **Load FormMap** — Queries MongoDB for the most recent `FormMap` for `formId`. Field IDs used as fallback if pdftk is unavailable.
2. **Extract PDF narrative text** — `pdf-parse` reads the full text of the PDF: section headers, instructions, eligibility notes, certification language, remarks. This is the primary context source for the LLM, not just field labels.
3. **Extract rich field descriptors** — `pdftk dump_data_fields` parses each field block into a `RichField` object with:
   - `id` — exact PDF field ID (verbatim)
   - `type` — widget type (`Text`, `Button`, `Choice`, `Signature`)
   - `altText` — USCIS-authored human-readable description of the field (often includes the full Part label, instruction text, and format notes)
   - `stateOptions` — valid values for checkbox/radio/dropdown fields
   - Falls back to bare field IDs if pdftk is unavailable.
4. **Read context files** — Any supplemental files read as UTF-8 text.
5. **Build prompts** — Calls `buildFormContextSystemPrompt()` and `buildFormContextUserMessage()`.
6. **Anthropic call** — `claude-opus-4-5`, `max_tokens: 32000`. One-time operation; cost and latency are acceptable.
7. **Parse + validate** — Strips markdown fences, parses JSON. Warns to console if any field IDs were skipped by the LLM.
8. **Persist** — Saves to the `FormContext` MongoDB collection.

---

## Data Sources Used in the Prompt

| Source | Role in prompt |
|--------|----------------|
| **PDF narrative text** (`pdf-parse`) | Full form text including all instructions, section headers, certification language, eligibility notes, remarks. Primary source for understanding what each section means and what each field requires. |
| **Field catalog JSON** (`pdftk altText`) | Per-field structured descriptor: ID, widget type, USCIS's own alt-text description, valid state options. Sent as JSON (not a flat list) so the LLM can reference type + altText + stateOptions together. |
| **Supplemental files** | Official USCIS form instructions, policy memos, or markdown guides. Appended to the user message when provided. |

---

## Prompt Design

### System Prompt (`buildFormContextSystemPrompt`)

Instructs the LLM to act as a senior immigration paralegal. Two output parts:

**Part A — Form Metadata**
- `purpose` — one precise sentence: what legal action does the form initiate and who submits it?
- `situations` — specific immigration scenarios, statuses, INA sections that require this form
- `use-cases` — concrete applicant profiles and event sequences (common + edge cases)
- `filing-context` — what other forms/evidence accompany this one, which USCIS office receives it
- `parties-involved` — every party role on the form with form-specific descriptions

**Part B — Field Annotations** (one entry per field in the catalog)

Each field must have `field`, `description`, `party`, `notes`:

- **`description`** rules by field type:
  - **Text** — exact data, format, source document, legal meaning
  - **Checkbox/Button** — complete question text from the form (not a paraphrase) + what checking the box legally triggers
  - **Choice/Dropdown** — what the dropdown controls, meaningful options, when each is appropriate
  - **Signature** — full certification language the signature attests to + USCIS instructions on when to sign
  - **Read-only/pre-filled** — explicitly noted as read-only with source field identified
  - **Barcode/system** — labeled as administrative/system-generated, no applicant input

- **`party`** — one of: `Applicant`, `Petitioner`, `Preparer`, `Interpreter`, `Civil Surgeon`, `Sponsor`, `Joint Sponsor`, `Child`, `N/A`

- **`notes`** — authoritative source document, formatting constraints, blank vs. "None" behavior, conditional gating, checkbox consequences, common mistakes, USCIS policy nuances

**Reasoning requirement in prompt:**
Before writing each field entry, the LLM must reason through: (1) what section is this in and what does it accomplish, (2) which party owns this section, (3) what real-world data populates this field, (4) what goes wrong if it's filled incorrectly. Output of reasoning is not required, but it must drive quality.

### User Message (`buildFormContextUserMessage`)

```
=== FORM: <formId> | <N> fields to annotate ===

══════════════════════════════════════════════════════════════════════
FORM NARRATIVE TEXT
(Complete text extracted from the PDF — all instructions, section
 headers, eligibility notes, certification language, and remarks.)
══════════════════════════════════════════════════════════════════════
<full pdf-parse output>

══════════════════════════════════════════════════════════════════════
SUPPLEMENTAL REFERENCE DOCUMENTS
══════════════════════════════════════════════════════════════════════
--- [filename.md] ---
<file contents>

══════════════════════════════════════════════════════════════════════
FIELD CATALOG (JSON)
("id" = PDF field ID, "type" = widget type, "altText" = USCIS description,
 "stateOptions" = valid selections for Button/Choice fields)
══════════════════════════════════════════════════════════════════════
[
  {
    "id": "form1[0].#subform[0].Pt1Line1a_FamilyName[0]",
    "type": "Text",
    "altText": "Part 1. Information About You. 1. Your Full Legal Name. Do not provide nickname. Enter Family Name (Last Name).",
    "stateOptions": []
  },
  ...
]

══════════════════════════════════════════════════════════════════════
<final instruction to produce output for all field IDs>
```

Why JSON for fields instead of a numbered text list:
- LLM can see `type`, `altText`, and `stateOptions` together per field without parsing noise
- Structured data allows the LLM to reason about field type natively (e.g. handle checkboxes differently from text fields)
- Does not inflate the prompt with a wall of redundant numbered text

---

## Debug Utility: `getFormContextPromptText`

Returns `{ systemPrompt, userMessage }` without making an Anthropic call or writing to MongoDB. Use this to inspect and tune prompts before spending tokens.

**Via API:**
```
POST /api/form-context/prompt
Body: { formId, formPdfPath }
```

**Via CLI:**
```bash
PRINT_PROMPT=1 npx ts-node src/services/buildFormContext.ts i-693 /path/to/i-693.pdf
```

---

## Output

**MongoDB `FormContext` document:**
```json
{
  "formId": "i-693",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "formMetadata": {
    "purpose": "...",
    "situations": "...",
    "use-cases": "...",
    "filing-context": "...",
    "parties-involved": "..."
  },
  "fields": [
    {
      "field": "form1[0].#subform[0].Pt1Line1a_FamilyName[0]",
      "description": "Applicant's legal family name (last name) exactly as it appears on their passport or travel document. Do not use a nickname or abbreviated name. Source: applicant's valid passport.",
      "party": "Applicant",
      "notes": "Must match the name on the applicant's identity document presented to the civil surgeon in Part 5. Do not use hyphens between double surnames unless the passport shows them. If the applicant has only one name, enter it here and write 'N/A' in the Given Name field."
    }
  ]
}
```

**API response (201):**
```json
{
  "formId": "i-693",
  "createdAt": "...",
  "fieldCount": 446,
  "formMetadata": { ... },
  "fields": [ ... ]
}
```

---

## API Endpoints

| Method | Path                         | Description |
|--------|------------------------------|-------------|
| `POST` | `/api/form-context/build`    | Full build — Anthropic call + MongoDB save |
| `POST` | `/api/form-context/prompt`   | Debug — return generated prompts only, no Anthropic call |
| `GET`  | `/api/form-context/:formId`  | Retrieve most recent FormContext for a formId |

**Multipart form fields for `/build` and `/prompt`:**
- `formId` (string)
- `formPdfPath` (string — server-side absolute path)
- `contextFiles` (file[], optional — supplemental reference docs)

---

## CLI Usage

```bash
# Full run (calls Anthropic, saves to MongoDB)
npx ts-node src/services/buildFormContext.ts i-693 /path/to/i-693.pdf

# With supplemental context files
npx ts-node src/services/buildFormContext.ts i-693 /path/to/i-693.pdf /path/to/i-693-instructions.md

# Print prompts only — no Anthropic call, no MongoDB write
PRINT_PROMPT=1 npx ts-node src/services/buildFormContext.ts i-693 /path/to/i-693.pdf
```

Requires `MONGODB_URI` and `ANTHROPIC_API_KEY` in `.env` (loaded automatically).

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No FormMap for `formId` in MongoDB | Throws — must run `buildFormMap` first |
| FormMap exists but has 0 fields | Throws |
| PDF not found at `formPdfPath` | Throws with path in message |
| `pdftk` not installed | Warns; falls back to bare field IDs without altText |
| PDF has no extractable text | Continues with fallback warning in user message |
| Supplemental context file not found | Warns to console, skips that file |
| LLM returns invalid JSON | Throws with first 600 chars of raw response |
| LLM skips some field IDs | Warns to console with list of missing IDs; saves partial result |
