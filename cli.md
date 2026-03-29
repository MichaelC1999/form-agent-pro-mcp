# CLI Reference

All commands are run from `immi-server/`. Requires `MONGODB_URI` and `ANTHROPIC_API_KEY` in `.env`.

---

## Setup

### `setup-form` · _Build Form Map + Build Form Context_
Runs buildFormMap then buildFormContext in sequence. Execute once per new form before using it in the pipeline.
```
npx ts-node src/scripts/setup-form.ts <formId> <pdfPath> [version] [contextFiles...]
```
- `formId` — identifier for the form (e.g. `i-485`)
- `pdfPath` — path to the blank PDF
- `version` _(optional)_ — version tag for the stored FormMap (default: `1.0`)
- `contextFiles...` _(optional)_ — supplemental instruction files appended to the context prompt

---

## Individual Services

### `buildSituationContext` · _Build Situation Context_
Calls Claude to extract structured party/biographic data, a situation summary, and required USCIS forms from UI answers and uploaded documents. Saves a `SituationalContext` to MongoDB.
```
npx ts-node src/services/buildSituationContext.ts --userId <userId> --situation "..." --process "..." [files...]
PRINT_PROMPT=1 npx ts-node src/services/buildSituationContext.ts --situation "..." --process "..." [files...]
```
- `--userId` / `-u` — MongoDB user ID to associate with the context (omit with `PRINT_PROMPT=1`)
- `--situation` / `-s` _(required)_ — free-text description of the user's immigration situation
- `--process` / `-p` _(required)_ — the immigration goal or process being pursued (e.g. `"apply for green card through marriage to a US citizen"`)
- `--notes` / `-n` _(optional)_ — additional open-ended notes
- `files...` _(optional)_ — positional paths to supporting documents (PDF, image, or text)
- `PRINT_PROMPT=1` — processes documents (OCR/PDF parse) and prints the full prompt without making an API call

---

### `buildFormMap` · _Build Form Map_
Extracts all fillable field IDs from a blank PDF and saves a `FormMap` to MongoDB.
```
npx ts-node src/services/buildFormMap.ts <formId> <pdfPath> [version]
```
- `formId` — identifier for the form
- `pdfPath` — path to the blank PDF
- `version` _(optional)_ — version tag (default: `1.0`)

---

### `buildFormContext` · _Build Form Context_
Calls Claude to annotate each field with a description, party label, and formatting notes, saving a `FormContext` to MongoDB.
```
npx ts-node src/services/buildFormContext.ts <formId> <pdfPath> [contextFiles...]
PRINT_PROMPT=1 npx ts-node src/services/buildFormContext.ts <formId> <pdfPath>
```
- `formId` — must have an existing `FormMap` in MongoDB
- `pdfPath` — path to the blank PDF
- `contextFiles...` _(optional)_ — supplemental files included in the prompt
- `PRINT_PROMPT=1` — prints the full prompt without making an API call

---

### `fillFormMap` · _Fill Form Map_
Calls Claude to match a `SituationalContext` to every field in a `FormContext`, saving a `FilledFormMap` to MongoDB.
```
npx ts-node src/services/fillFormMap.ts <situationalContextId> [--formId <formId>] [level]
PRINT_PROMPT=1 npx ts-node src/services/fillFormMap.ts --formId <formId> [<situationalContextId>]
```
- `situationalContextId` — MongoDB `_id` of the target `SituationalContext`
- `--formId` / `-f` _(optional)_ — process a single form; omit to process all forms in `requiredForms`
- `level` _(optional)_ — `conservative` (default) | `moderate` | `liberal`
- `PRINT_PROMPT=1` — prints the compressed prompt Claude receives; requires `--formId`; omit `situationalContextId` to get a blank placeholder template

---

### `fillForm` · _Fill Form_
Writes a `FilledFormMap`'s values into a blank PDF via pdftk. No LLM call.
```
npx ts-node src/services/fillForm.ts <formId> <filledFormMapId> <pdfPath> [outputDir] [formType]
```
- `formId` — used in the output filename
- `filledFormMapId` — MongoDB `_id` of the target `FilledFormMap`
- `pdfPath` — path to the blank PDF to fill
- `outputDir` _(optional)_ — output directory (default: `output/<formId>/`)
- `formType` _(optional)_ — PDF form type override (`pdf` is the only supported value)

---

### `extractPdf` · _Extract PDF_
Reads raw field metadata from a PDF and prints it to stdout. Useful for inspecting fields before setup.
```
npx ts-node src/services/extractPdf.ts <pdfPath> [existingMapId]
```
- `pdfPath` — path to the PDF to inspect
- `existingMapId` _(optional)_ — MongoDB `_id` of an existing `FormMap` to diff against

---

### `manualLoad` · _Manual Load_
Inserts a hand-crafted JSON document directly into a MongoDB collection, bypassing all AI processing.
```
npx ts-node src/services/manualLoad.ts <collection> <file>
```
- `collection` — `form-map` | `form-context` | `situational-context` | `filled-form-map`
- `file` — path to the JSON file to load

---

## Pipeline

### `fill-forms` · _Fill Forms_
For every form in a SituationalContext's `requiredForms`, finds the most recently saved `FilledFormMap` and runs `fillForm` to produce filled PDFs. `fillFormMap` must have already been run before calling this.
```
npx ts-node src/scripts/fill-forms.ts <situationalContextId>
```
- `situationalContextId` — MongoDB `_id` of the target `SituationalContext`
