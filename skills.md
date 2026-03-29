# immi-server Skills

Documented patterns, rules, and design decisions for each major service. This file is the source of truth for how each mechanism is expected to behave. Update it when a service's logic, prompting strategy, or data contract changes.

## Situational Context (`buildSituationContext`)

**Service file:** `src/services/buildSituationContext.ts`
**Route:** `POST /api/situation/build`
**Model:** `SituationalContext` (MongoDB)

### Purpose

Accepts a user's self-described immigration situation, the process they are pursuing, and any uploaded supporting documents. Returns a structured situational context object saved to MongoDB that contains enough information to later fill out immigration forms on their behalf.

---

### Input

| Field | Source | Type | Required |
|---|---|---|---|
| `userId` | `req.body` | `string` | ✅ |
| `situationDescription` | `req.body` | `string` | ✅ |
| `processDescription` | `req.body` | `string` | ✅ |
| `additionalNotes` | `req.body` | `string` | ❌ |
| `documents` | `req.files` (multer) | `File[]` (up to 20) | ❌ |

Accepted document types: passports, driver's licenses, I-94s, visas, marriage/birth certificates, tax returns, employment records (CTPS, pay stubs), resumes, background checks, property deeds, vehicle titles.

---

### Document Pre-Processing (before LLM)

Documents are categorized and pre-processed with native libraries — **not** the LLM — to extract raw text cheaply and reliably.

| Category | Detection | Extraction Method |
|---|---|---|
| `pdf` | `.pdf` extension or `application/pdf` MIME | `pdf-parse` → `result.text` |
| `image` | `.jpg/.jpeg/.png/.gif/.webp/.bmp/.tiff` or `image/*` MIME | `tesseract.js` → `Tesseract.recognize(path, "eng+por")` |
| `text` | anything else | `fs.readFileSync(path, "utf-8")` |

**Why pre-process?** Reduces LLM token cost and avoids relying on the model for mechanical scanning. The extracted raw text is then passed as a text block in the user message. Image files are additionally sent as base64 vision blocks so Claude can visually cross-check OCR output.

**Known edge case:** Some Brazilian PDFs (e.g. CTPS digital) are AES-encrypted with an empty password. `pdf-parse` may not decrypt these automatically. `pypdf` with the `cryptography` package handles it. Consider adding a fallback or using `qpdf --decrypt` as a pre-step for encrypted PDFs.

**OCR language:** Tesseract is configured with `"eng+por"` (English + Portuguese) to handle both US and Brazilian documents. Add additional language codes here if the user base expands.

---

### Anthropic Call

**Model:** `claude-opus-4-5`
**Max tokens:** `8096`

**Message structure:**
```
system:  buildSystemPrompt()
user:    [
           ...base64 image blocks (one per image file),
           { type: "text", text: buildUserMessage(uiAnswers, parsedDocuments) }
         ]
```

Image blocks come before the text block so Claude sees the visual context before reading the extracted text.

---

### System Prompt Design

The system prompt instructs the model to produce two outputs in a single JSON response:

**Part A — `situationSummary`:** A 2-3 sentence plain-English summary covering who the parties are, what immigration process they are pursuing, and what the service needs to do for them.

**Part B — `partyData`:** A structured map where top-level keys are specific parties or situational subjects (e.g. `"John Alexander Doe"`, `"Marriage (Brazil, 2024)"`, `"US Immigration Context"`). Values are key→value fact bags.

#### Translation Rules
All output must be in English, including field labels translated from foreign-language documents.

| Original (Portuguese) | Output (English) |
|---|---|
| Data de Nascimento | Date of Birth |
| Naturalidade | Place of Birth |
| Validade | Expiration Date |
| Filiação | Parents / Parentage |
| Data de Expedição | Date of Issue |
| Prazo Indeterminado | Indefinite Term |
| Certidão de Casamento | Marriage Certificate |
| Comunhão Parcial de Bens | Partial Community Property |

Proper nouns (names, cities, employer names) are preserved as written in the source document and **not** translated.

Foreign codes and abbreviations (e.g. CBO occupation codes, CNPJ tax IDs) include both the original code and a translated label.

#### Data Sanitization Rules
Values are sanitized to reflect only the practical, usable piece of information implied by the field label. Document-context artifacts and incidental metadata are stripped.

| Raw value | Stored as |
|---|---|
| `"Sarasota, FL USA (Open To Relocation)"` | `"Sarasota, FL, USA"` |
| `"R$ 1.948,17/month"` | `"R$ 1,948.17 / month"` |
| `"19 MAI/MAY 1999"` | `"1999-05-19"` |
| `"DOE<<JANE<MARY"` (MRZ) | `"Jane Mary Doe"` |

Dates are normalized to ISO 8601 (`YYYY-MM-DD`) wherever the original is unambiguous. Parenthetical clarifications do not belong inside a value — they belong in the key name or a separate `"Notes"` field if truly needed.

#### Structure Rules
- Top-level keys: specific named parties or situational subjects. Avoid vague keys like `"Documents"`.
- Within subjects: discrete facts use precise values; narrative/multi-entry information uses labeled strings or nested objects.
- Redundancy across subjects is acceptable. Omissions are not.
- Exact proper nouns, ID numbers, dates, and addresses are never paraphrased.
- Derived/inferred facts (e.g. immigration eligibility implied by visa status + marriage certificate) are included under a `"US Immigration Context"` subject.

---

### Output

The LLM response is parsed as JSON and saved to MongoDB. The stored document shape:

```typescript
{
  userId: string;
  createdAt: Date;
  situationSummary: string;         // Part A
  partyData: PartyDataMap;          // Part B — Record<string, Record<string, unknown>>
  documents: ParsedDocument[];      // One entry per uploaded file
}
```

Each `ParsedDocument`:
```typescript
{
  originalName: string;             // Original filename
  mimeCategory: "pdf" | "image" | "text";
  rawText: string;                  // Output of OCR/pdf-parse/fs.readFileSync
  uploadedAt: Date;
}
```

---

### Error Handling

| Condition | Behavior |
|---|---|
| Missing `userId` / `situationDescription` / `processDescription` | Route returns `400` before calling service |
| LLM returns non-JSON text | Service throws with first 500 chars of raw response included in message |
| File path does not exist (image block) | `buildImageBlocks` silently skips that file |
| PDF decryption fails in `pdf-parse` | `extractRawText` throws; caught by route's `500` handler |
