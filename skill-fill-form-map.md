# Skill: fillFormMap

## Purpose

Takes a `FormContext` (detailed field annotations) and a `SituationalContext` (structured facts about the applicant) and calls Anthropic to produce a `FilledFormMap` — a flat `{ "<fieldId>": "<value>" }` object with a best-effort value for every field on the form. The result is saved to MongoDB and is a required prerequisite for `fillForm`.

**Run once per user per form. Uses claude-sonnet-4-5 with a 16K token budget.**

---

## Pipeline Position

```
buildFormMap  →  buildFormContext  →  buildSituationContext
                                              ↓
                                        fillFormMap   ← (this skill)
                                              ↓
                                          fillForm
```

---

## Pre-requisites

- A `FormContext` document must exist in MongoDB for the given `formId` (produced by `buildFormContext`).
- A `SituationalContext` document must exist in MongoDB (produced by `buildSituationContext`).
- `ANTHROPIC_API_KEY` and `MONGODB_URI` must be set in the environment.

---

## Input

| Parameter              | Type              | Required | Description |
|------------------------|-------------------|----------|-------------|
| `formId`               | `string`          | ✅       | Must match a `FormContext` document in MongoDB |
| `userId`               | `string`          | ✅       | The applicant's user ID — stored on the resulting `FilledFormMap` |
| `situationalContextId` | `string`          | ✅       | MongoDB `_id` of the `SituationalContext` |
| `assumptionLevel`      | `AssumptionLevel` | ❌       | `"conservative"` (default) \| `"moderate"` \| `"liberal"` |

---

## Assumption Levels

| Level          | Behavior |
|----------------|----------|
| `conservative` | Only fills fields where the answer is explicitly present in the context. Blank if any inference is required. Maximum accuracy, fewest fills. |
| `moderate`     | Fills explicit values plus simple single-step inferences (e.g. nationality from passport country). Reasonable balance. |
| `liberal`      | Fills as many fields as possible. Uses strong inference and immigration domain knowledge. Outputs "N/A" or "None" for inapplicable fields. Requires careful user review. |

---

## Processing Flow

1. **Load FormContext** — Queries MongoDB for the most recent `FormContext` for `formId`.
2. **Load FormMap** — Queries MongoDB for stored field IDs as a fallback merge set.
3. **Load SituationalContext** — Fetches the document by `situationalContextId`.
4. **Build prompts** — `buildFillFormMapSystemPrompt(assumptionLevel)` + `buildFillFormMapUserMessage(...)`.
5. **Anthropic call** — `claude-sonnet-4-5`, `max_tokens: 16000`.
6. **Parse response** — Strips markdown fences, parses JSON. Expects `{ fields: {...}, reasoning: "..." }`.
7. **Merge** — Ensures every field ID from both `FormContext` and `FormMap` appears in the output (fills missing with `""`).
8. **Persist** — Saves a `FilledFormMap` document to MongoDB.

---

## Prompt Design

### System Prompt (`buildFillFormMapSystemPrompt`)

Instructs the LLM to act as a senior immigration paralegal filling out a form. Key rules:

- **Text fields** — exact value only, correct format per field notes (date format, capitalization, address components).
- **Checkbox/Button fields** — "Yes" or "No" for the selected field, "" for unselected.
- **Signature fields** — always `""` (must be signed by the party).
- **Barcode/system fields** — always `""`.
- **Empty vs. "N/A" vs. "None"** — `""` for genuinely empty, `"N/A"` or `"None"` only when the form itself uses these tokens.

Assumption level guidance is injected at the top of the system prompt, before the field rules.

### User Message (`buildFillFormMapUserMessage`)

```
FORM: <formId>  |  <N> fields to fill  |  Assumption level: <level>
────────────────────────────────────────────────────────────────────────
FORM METADATA
────────────────────────────────────────────────────────────────────────
{ "purpose": "...", "situations": "...", ... }

────────────────────────────────────────────────────────────────────────
SITUATIONAL CONTEXT
────────────────────────────────────────────────────────────────────────
Summary: <situationSummary>

Party Data:
{ "<Party Name>": { "<Key>": "<Value>", ... }, ... }

────────────────────────────────────────────────────────────────────────
FORM FIELD ANNOTATIONS  (<N> fields)
────────────────────────────────────────────────────────────────────────
[
  { "field": "...", "description": "...", "party": "...", "notes": "..." },
  ...
]
```

---

## Output

**MongoDB `FilledFormMap` document:**
```json
{
  "formId": "i-485",
  "userId": "user_abc123",
  "createdAt": "2025-01-01T00:00:00.000Z",
  "assumptionLevel": "conservative",
  "fields": {
    "form1[0].#subform[0].Pt1Line1a_FamilyName[0]": "Smith",
    "form1[0].#subform[0].Pt1Line1b_GivenName[0]": "John",
    "form1[0].#subform[0].Pt1Line2_MiddleName[0]": "",
    "form1[0].#subform[0].Pt2Line1_CB_Basis[0]": ""
  }
}
```

**API response (201):**
```json
{
  "_id": "...",
  "formId": "i-485",
  "userId": "user_abc123",
  "createdAt": "...",
  "assumptionLevel": "conservative",
  "fieldCount": 312,
  "filledCount": 187,
  "fields": { ... }
}
```

---

## API Endpoints

| Method | Path                    | Description |
|--------|-------------------------|-------------|
| `POST` | `/api/filled-map/fill`  | Run fillFormMap — Anthropic call + MongoDB save |
| `GET`  | `/api/filled-map/user/:userId` | All FilledFormMaps for a user (optional `?formId=`) |
| `GET`  | `/api/filled-map/:id`   | Single FilledFormMap by MongoDB `_id` |

**Request body for `/fill`** (`application/json`):
```json
{
  "formId": "i-485",
  "userId": "user_abc123",
  "situationalContextId": "...",
  "assumptionLevel": "moderate"
}
```

---

## CLI Usage

```bash
npx ts-node src/services/fillFormMap.ts <formId> <userId> <situationalContextId> [assumptionLevel]

# Examples
npx ts-node src/services/fillFormMap.ts i-485 user_abc123 66f1234abc... conservative
npx ts-node src/services/fillFormMap.ts i-693 user_abc123 66f1234abc... moderate
```

Requires `MONGODB_URI` and `ANTHROPIC_API_KEY` in `.env`.

---

## Related Services

| Service | Purpose |
|---------|---------|
| `fillForm` | Takes a `FilledFormMap` + blank PDF → stamps field values into the PDF via pdftk → writes output PDF |
| `extractPdf` | Reads field values from an already-filled PDF → creates or updates a `FilledFormMap` in MongoDB |

### `fillForm`

**API:** `POST /api/form-fill/fill`

**Body** (`application/json`):
```json
{
  "formId": "i-485",
  "userId": "user_abc123",
  "filledFormMapId": "...",
  "outputDir": "/tmp/immi-filled-forms"
}
```

The blank PDF must exist at `forms/<formId>.pdf` relative to the project root. Returns `{ success, outputPath, filledFields, skippedFields, errors }`.

**CLI:**
```bash
npx ts-node src/services/fillForm.ts <formId> <userId> <filledFormMapId> [outputDir]
```

### `extractPdf`

**API:** `POST /api/form-fill/extract` (multipart/form-data)

**Fields:**
- `pdf` (file upload) OR `pdfPath` (server-side path) — the filled PDF to read
- `existingMapId` (optional) — if provided, merges extracted values into that `FilledFormMap`

**CLI:**
```bash
npx ts-node src/services/extractPdf.ts <pdfPath> [existingMapId]
```

---

## Error Handling

| Condition | Behavior |
|-----------|----------|
| No `FormContext` for `formId` | Throws — run `buildFormContext` first |
| `FormContext` has 0 fields | Throws |
| `SituationalContext` not found | Throws |
| Anthropic returns invalid JSON | Throws with first 600 chars of raw response |
| `fillForm`: blank PDF not found at `forms/<formId>.pdf` | Throws with candidate paths |
| `fillForm`: pdftk `fill_form` fails | Returns `{ success: false, errors: [...] }` (does not throw) |
| `extractPdf`: PDF not found | Throws |
| `extractPdf`: no fields found in PDF | Throws — PDF may be flat/non-interactive |
| `extractPdf`: `existingMapId` not found | Throws |
