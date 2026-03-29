# Skill: Build Form Map (`buildFormMap`)

**Service file:** `src/services/buildFormMap.ts`
**Route:** `POST /api/form-map/build`
**Model:** `FormMap` (MongoDB)

---

## Purpose

Given a blank PDF form, extract every fillable field ID and persist an empty `FormMap` to MongoDB — a flat `{ "<fieldId>": "" }` object that downstream services fill with values. This is a pure extraction step; no LLM is involved.

---

## Input

| Field | Source | Type | Required |
|---|---|---|---|
| `formId` | `req.body` | `string` | ✅ |
| `pdf` | `req.file` (multer single) | `File` | Either this or `formPdfPath` |
| `formPdfPath` | `req.body` | `string` (server-local path) | Either this or `pdf` upload |
| `version` | `req.body` | `string` | ❌ (defaults to `"1.0"`) |

The route accepts two usage modes:
- **Upload mode** — client POSTs a blank PDF as `multipart/form-data` with field name `"pdf"`. Multer writes it to `os.tmpdir()`.
- **Path mode** — caller provides `formPdfPath` pointing to a file already on the server. Used for internal/CLI invocations where the form lives in a known directory.

---

## Extraction Strategy Waterfall

The service tries four strategies in order, stopping at the first that returns at least one field. The winning strategy name is included in the response and stored in the service return value.

| Priority | Strategy | Tool / Method | Best for |
|---|---|---|---|
| 1 | **pdftk** | `pdftk <pdf> dump_data_fields` | XFA forms (USCIS I-series) |
| 2 | **pdf-lib** | `PDFDocument.load()` → `form.getFields()` | Standard AcroForm PDFs |
| 3 | **qpdf** | `qpdf --qdf` decompress → regex `/T (name)` scan | Compressed/encrypted AcroForms where pdf-lib fails |
| 4 | **raw-scan** | `fs.readFileSync` (latin1) → regex `/T (name)` scan | Any PDF, no external tools required |

If all four strategies return zero fields, the service throws an error describing which tools were and weren't available.

**Why this order?**
- pdftk reliably accesses XFA field definitions that pdf-lib cannot see (pdf-lib only reads AcroForm).
- pdf-lib handles modern AcroForm PDFs without needing any system CLI.
- qpdf's `--qdf` mode fully decompresses all object streams, exposing field data that may be compressed inside object streams and missed by a raw scan.
- Raw scan is the zero-dependency fallback — less reliable but always executable.

---

## Output

```typescript
{
  formId: string;       // from input
  version: string;      // from input, default "1.0"
  createdAt: Date;
  fields: FieldMap;     // Record<string, ""> — all values empty
  strategy: string;     // "pdftk" | "pdf-lib" | "qpdf" | "raw-scan"
  fieldCount: number;   // total fields extracted
}
```

The `fields` object is saved to MongoDB in the `FormMap` collection with `Schema.Types.Mixed`, allowing any flat structure.

---

## CLI Usage

The service file is directly executable as a CLI:

```bash
npx ts-node src/services/buildFormMap.ts <formId> <pdfPath> [version]

# Example
npx ts-node src/services/buildFormMap.ts i-130 forms/i-130.pdf 1.0
```

Requires `MONGODB_URI` in the environment. The CLI uses a lazy `connectDb()` import so the MongoDB connection is only opened when running standalone.

---

## Error Handling

| Condition | Behavior |
|---|---|
| Missing `formId` | Route returns `400` |
| Neither `pdf` upload nor `formPdfPath` provided | Route returns `400` with descriptive message |
| PDF file not found on disk | Service throws before any strategy is attempted |
| All four strategies yield zero fields | Service throws with list of tried strategies and tool availability |
| MongoDB write fails | Propagates as `500` from route |
