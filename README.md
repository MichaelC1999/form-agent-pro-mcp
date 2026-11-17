# immi-server

Node.js / TypeScript server that automates filling USCIS immigration forms. Anthropic is used for semantic understanding; all PDF I/O is handled by `pdftk`.

---

## Use it from an AI app (MCP)

Form Agent Pro is a remote [Model Context Protocol](https://modelcontextprotocol.io) server. Any MCP client that supports remote servers with OAuth (Claude, ChatGPT, Cursor, VS Code, …) can connect to:

```
https://immi-server-i5sok.ondigitalocean.app/mcp
```

Registry name: `pro.formagent/form-agent` (see [`server.json`](server.json)).

**Sign-in.** On first connect the app opens a browser window to sign in with Google. No API key is needed. Your forms are tied to your Google account, the same as on [formagent.pro](https://formagent.pro).

**Pricing.** Browsing and checking progress are free. Preparing a case is paid per case: the first `build_situation_context` call returns a Stripe checkout link, and the price is shown there. Inference costs are covered by the service.

### Tools

| Tool | Cost | What it does |
| --- | --- | --- |
| `list_supported_forms` | Free | Lists the immigration processes and USCIS forms supported. |
| `build_situation_context` | Paid | Takes the user's situation, goal and documents (base64; up to 20 files, 5 MB each, 7 MB total), works out the required forms and starts filling them. Returns a checkout link first, then a `situationalContextId` once paid. |
| `get_situation_status` | Free | Progress for each required form: ready, pending, failed or not generated. |
| `get_filled_pdf` | Free | 15-minute download links for each ready form and one merged PDF. |

Typical flow: `list_supported_forms` → `build_situation_context` (pay) → `build_situation_context` again with `stripeSessionId` → poll `get_situation_status` → `get_filled_pdf`.

### How it is protected

- **OAuth 2.1:** dynamic client registration and PKCE. immi-server is its own authorization server and uses Google for the login itself. Discovery is at `/.well-known/oauth-protected-resource/mcp`.
- **Paid tools:** these require a paid, single-use Stripe Checkout session.
- **Limits:** per-account and per-IP rate limits, plus per-user and service-wide daily spend caps.
- **Documents:** uploads are deleted from the server as soon as their text has been extracted. Download links expire after 15 minutes.

### Publishing to the MCP Registry

[`server.json`](server.json) is the registry entry. Publish it with [`mcp-publisher`](https://modelcontextprotocol.io/registry/quickstart). The `pro.formagent/` namespace is verified through a DNS TXT record on `formagent.pro`:

```bash
mcp-publisher login dns --domain formagent.pro --private-key <key>
mcp-publisher validate
mcp-publisher publish
```

Bump `version` in `server.json` (and `SERVER_INFO` in `src/mcp/server.ts`) for each release.

---

## Pipeline

```
[One-time, per form]
  buildFormMap  ──→  buildFormContext
                           │
[One-time, per user]       │
  buildSituationContext ───┘
                           │
[Once per form × user]     ↓
                      fillFormMap
                           │
                           ↓
                        fillForm  ──→  filled PDF
```

---

## Mechanisms

### 1 — Build Form Map

**Route:** `POST /api/form-map/build`
**File:** `src/services/buildFormMap.ts`
**AI:** None

Extracts every fillable field ID from a blank PDF and persists an empty `{ "<fieldId>": "" }` map to MongoDB as a `FormMap` document. Uses a four-strategy waterfall (pdftk → pdf-lib → qpdf → raw-scan) stopping at the first that returns fields. pdftk is preferred because it reliably accesses XFA field definitions that pdf-lib cannot see.

**Input:** `formId`, blank PDF (upload or server path), optional `version`
**Output:** `FormMap` — `{ formId, version, fields: Record<string, ""> }`

```bash
npx ts-node src/services/buildFormMap.ts <formId> <pdfPath> [version]
```

---

### 2 — Build Form Context

**Route:** `POST /api/form-context/build`
**File:** `src/services/buildFormContext.ts`
**AI:** `claude-opus-5-5` (streamed), up to 128 000 tokens

Annotates every field in the `FormMap` with rich metadata using the form's full narrative PDF text and pdftk-extracted per-field alt-text (USCIS-authored descriptions). Produces a `FormContext` document in MongoDB. Run once per form; thoroughness over speed.

**Requires:** `FormMap` already in MongoDB for `formId`.

**Input:** `formId`, blank PDF path, optional supplemental reference files
**Output:** `FormContext` — `{ formId, formMetadata, fields: [{ field, description, party, notes }] }`

```bash
npx ts-node src/services/buildFormContext.ts <formId> <pdfPath> [contextFiles...]

# Print prompts only — no Anthropic call, no DB write
PRINT_PROMPT=1 npx ts-node src/services/buildFormContext.ts <formId> <pdfPath>
```

---

### 3 — Build Situational Context

**Route:** `POST /api/situation/build`
**File:** `src/services/buildSituationContext.ts`
**AI:** `claude-opus-5-5` (streamed), up to 128 000 tokens

Accepts a user's immigration situation description and supporting documents. Documents are pre-processed without the LLM (PDFs via `pdf-parse`, images via Tesseract OCR with `eng+por`, plain text via `fs.readFileSync`) to extract raw text cheaply before it is passed to Anthropic. The model produces two outputs: a plain-English `situationSummary` and a structured `partyData` map of named parties to key→value fact bags. All output is in English; dates are normalized to ISO 8601; proper nouns are preserved as written in source documents.

**Input:** `userId`, `situationDescription`, `processDescription`, optional `additionalNotes`, optional document uploads
**Output:** `SituationalContext` — `{ userId, situationSummary, partyData, documents }`

---

### 4 — Fill Form Map

**Route:** `POST /api/filled-map/fill`
**File:** `src/services/fillFormMap.ts`
**AI:** `claude-sonnet-4-5`, up to 16 000 tokens

Takes the `FormContext` and `SituationalContext` and calls Anthropic to produce a best-effort value for every field on the form. Behaviour is controlled by `assumptionLevel`:

| Level | Behaviour |
|---|---|
| `conservative` (default) | Only fills fields with an explicit answer in context. Blank if any inference is required. |
| `moderate` | Adds simple single-step inferences (e.g. nationality from passport country). |
| `liberal` | Fills as many fields as possible; outputs "N/A" / "None" for inapplicable fields. Requires careful review. |

**Requires:** `FormContext` and `SituationalContext` already in MongoDB.

**Input:** `formId`, `userId`, `situationalContextId`, optional `assumptionLevel`
**Output:** `FilledFormMap` — `{ formId, userId, assumptionLevel, fields: Record<string, string> }`

```bash
npx ts-node src/services/fillFormMap.ts <formId> <userId> <situationalContextId> [assumptionLevel]
```

---

### 5 — Fill Form

**Route:** `POST /api/form-fill/fill`
**File:** `src/services/fillForm.ts`
**AI:** None

Reads a `FilledFormMap` from MongoDB and stamps its values into a blank PDF using pdftk. Zero AI involvement — pure deterministic PDF writing. Designed to be extended to additional form types via the `IFormFiller` interface + `getFormFiller()` factory; only PDF is implemented today.

**Pre-processing applied to every text field before the PDF layer:**

1. **NFC normalisation** (`sanitizeTextValue`) — collapses decomposed Unicode sequences (e.g. `a` + combining-tilde) into precomposed codepoints (`ã`).
2. **Word-wrap** (`prepareTextValue`, 45-char threshold) — inserts newlines at word boundaries for values that would overflow a field's visible area.

**FDF encoding** (`encodeFdfValue` in `pdf.ts`): Pure ASCII values use the compact `()` FDF literal. Values containing any non-ASCII character are encoded as UTF-16 BE hex strings prefixed with the Unicode BOM (`FEFF`), per PDF spec §7.3.4. This prevents pdftk from misreading UTF-8 multi-byte sequences as Latin-1 (the classic `São Paulo` → `SÃ£o Paulo` mojibake).

**Output filename:** `{userId}-{formId}-{mmddyyyy hhmm}.pdf`
**Default output directory:** `output/<formId>/`

**Requires:** `FilledFormMap` already in MongoDB.

**Input:** `formId`, `userId`, `filledFormMapId`, `formPdfPath`, optional `outputDir`, optional `formType` (default `"pdf"`)
**Output:** `{ success, outputPath, filledFields, skippedFields, errors }`

```bash
npx ts-node src/services/fillForm.ts <formId> <filledFormMapId> <formPdfPath> [outputDir] [formType]

# Example
npx ts-node src/services/fillForm.ts i-130 68a1b2c3d4e5f600 assets/forms/i-130/blank.pdf
```

---

### 6 — Manual Load (utility)

**File:** `src/services/manualLoad.ts`
**AI:** None

CLI-only utility for seeding or replacing MongoDB documents directly from JSON files. Useful for testing and for injecting manually prepared data without going through the full pipeline.

Supported collections: `form-map`, `form-context`, `situational-context`, `filled-form-map`
JSON source files live in `assets/manual-loads/`.

```bash
npx ts-node src/services/manualLoad.ts <collection> <file>

# Examples
npx ts-node src/services/manualLoad.ts form-map              i-130-map.json
npx ts-node src/services/manualLoad.ts form-context          i-130-context.json
npx ts-node src/services/manualLoad.ts situational-context   user-context.json
npx ts-node src/services/manualLoad.ts filled-form-map       user-i130-filled.json
```

---

---

## End-to-End Pipeline

### `POST /api/pipeline/run`
**File:** `src/routes/pipeline.ts`

Chains all three per-user/per-form steps into a single call: `buildSituationContext` → `fillFormMap` (×N) → `fillForm` (×N). The pipeline derives blank PDF paths automatically from `assets/forms/<formId>/blank.pdf`, validates they exist before making any AI calls, and continues to the next form if one fails.

**Body** (`multipart/form-data`):

| Field | Type | Required | Description |
|---|---|---|---|
| `userId` | string | ✅ | Applicant identifier |
| `situationDescription` | string | ✅ | Free-text description of the immigration situation |
| `processDescription` | string | ✅ | Which process/forms the user is pursuing |
| `additionalNotes` | string | ❌ | Any extra context |
| `formIds` | string | ✅ | JSON array or comma-separated — e.g. `"i-130,i-485"` |
| `assumptionLevel` | string | ❌ | `conservative` (default) \| `moderate` \| `liberal` |
| `documents` | File[] | ❌ | Up to 20 supporting documents (PDFs, images, text) |

**Response (200):**
```json
{
  "situationalContextId": "...",
  "forms": [
    {
      "formId": "i-130",
      "filledFormMapId": "...",
      "success": true,
      "outputPath": "output/i-130/user_abc-i-130-02272026 1430.pdf",
      "filledFields": [...],
      "skippedFields": [...],
      "errors": []
    }
  ]
}
```

---

### Form Setup (one-time, per form)

**File:** `src/scripts/setup-form.ts`

CLI that runs `buildFormMap` then `buildFormContext` in sequence for a new form. Run this once per form before using the pipeline.

```bash
npx ts-node src/scripts/setup-form.ts <formId> <pdfPath> [version] [contextFiles...]

# Examples
npx ts-node src/scripts/setup-form.ts i-485 assets/forms/i-485/blank.pdf
npx ts-node src/scripts/setup-form.ts i-693 assets/forms/i-693/blank.pdf 1.0 assets/context/i-693-instructions.md
```

Requires `MONGODB_URI` and `ANTHROPIC_API_KEY` in `.env`.

---

## Blank Form Assets

Blank PDFs live at `assets/forms/<formId>/blank.pdf`. Currently available:

```
assets/forms/
├── g-325a/blank.pdf
├── i-130/blank.pdf
├── i-130a/blank.pdf
├── i-131/blank.pdf
├── i-485/blank.pdf
├── i-693/blank.pdf
├── i-765/blank.pdf
└── i-864/blank.pdf
```

Pass the path directly to any service that accepts `formPdfPath`.

---

## Environment

```
MONGODB_URI=...
ANTHROPIC_API_KEY=...       # required for buildFormContext, buildSituationContext, fillFormMap
PORT=3001                   # optional, defaults to 3001
```

## Dependencies

- `pdftk-java` — field extraction, FDF generation, form filling (`brew install pdftk-java`)
- `qpdf` — fallback field extraction strategy (`brew install qpdf`)
- `tesseract` — OCR for image documents in buildSituationContext (`brew install tesseract`)
