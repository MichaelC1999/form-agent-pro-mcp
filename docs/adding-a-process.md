# Adding a process

This guide explains how the pipeline models a "process" and how to add a new one (or build a custom workflow on top of an existing one) without changing any source code that branches on process identity.

A **process** is a form-filing workflow — e.g. US Adjustment of Status (`aos`), K-1 fiancé petition (`k1-fiance`), Italian Type-D visa (`italy-student-visa`). Each process has its own catalog of forms, its own description of when it applies, and (optionally) its own supplemental assets. The pipeline stages are universal; the process distinguishes itself entirely through assets on disk and metadata on MongoDB documents.

Two processes are live as reference implementations: [`aos`](../assets/forms/aos/) (the original, ~13 USCIS forms) and [`italy-student-visa`](../assets/forms/italy-student-visa/) (Italian Type D student visa, 1 form + 5 affidavit templates). Skim both before adding a third.

---

## The cardinal rule

**No code path branches on the value of `processId`.** Conditions key off the *presence* of assets and metadata (`is there a form directory? does this FormContext have applicableProcesses including X? does the process have a README?`), never off the literal string `"aos"` or any other process name. Adding a new process should require zero TypeScript edits.

If you find yourself writing `if (processId === "...")` to make something work, that's a signal the structure needs to be extended — push the variation into the asset layout or into a `FormContext` field rather than into a branch.

---

## Mental model

```
process  ──┬──> README.md                     (how the LLM recognizes this process)
           ├──> forms/<formId>/blank.pdf      (one per form in the process)
           └──> any other per-process assets  (affidavits, prompt fragments, etc.)
```

A process at runtime is:
1. A directory the helper [`src/lib/processes.ts`](../src/lib/processes.ts) discovers under `assets/forms/`.
2. A `processId` string saved on `SituationalContext.processId`, `FilledFormMap.processId`, and listed in `FormContext.applicableProcesses[]`.
3. A `README.md` next to the form set, used by the LLM during Stage 1 (situational context) to match a user's situation to this process.

That is the complete contract. Everything else falls out of it.

---

## Filesystem layout

```
immi-server/assets/forms/
└── <processId>/
    ├── README.md
    ├── <formId>/
    │   └── blank.pdf
    ├── <formId>/
    │   └── blank.pdf
    └── ...
```

Rules:
- The directory name **is** the `processId`. Pick a short, general kebab-case identifier (`aos`, `k1-fiance`, `eu-blue-card`).
- Every form directory must contain a file literally named `blank.pdf`. Directories without one are skipped by `listFormsInProcess()`.
- Process directories with zero valid form subdirectories are skipped by `listProcesses()`. This means you can stage assets without breaking discovery — until at least one `<formId>/blank.pdf` lands, the process is invisible.
- Hidden entries (anything starting with `.`) are ignored. macOS `.DS_Store` is filtered automatically.

The current `aos` process is the reference layout — see `assets/forms/aos/` for an example.

### Process-specific extras

A process may need supplemental assets the AoS process doesn't. The pipeline ships with first-class support for **affidavits** — markdown templates with bracketed placeholders that get LLM-filled from situational context and rendered to PDF. Other asset types follow the same file-existence-gated convention.

```
assets/forms/<processId>/
├── README.md
├── <formId>/blank.pdf   (one subdir per form in the process)
├── affidavits/          (process-specific markdown affidavit templates, if any)
│   ├── bank-sponsorship-affidavit.md
│   └── ...
└── (future) prompts/    (process-specific prompt fragments, if any)
```

Code that consumes new asset types must check for *presence* on disk, not for the process name. Example pattern:

```ts
import { getProcessDir } from "../lib/processes";

const customDir = path.join(getProcessDir(processId), "prompts");
if (fs.existsSync(customDir)) {
  // process-specific logic
}
```

This keeps the cardinal rule intact: adding `assets/forms/k1-fiance/prompts/` enables the behavior automatically; no code touches `processId === "k1-fiance"`.

---

## What you provide vs. what the pipeline generates

| You provide on disk | The pipeline generates in MongoDB |
| --- | --- |
| `assets/forms/<processId>/README.md` | `FormMap` per form (extracted from blank PDF) |
| `assets/forms/<processId>/<formId>/blank.pdf` | `FormContext` per form (Claude-annotated, with `applicableProcesses` + `scope`) |
| (optional) `affidavits/`, `prompts/` per process | `SituationalContext` per user, with `processId` |
|  | `FilledFormMap` per (form × beneficiary), with `processId` |

There is no separate "process config" file. The README is the only declarative artifact and it exists purely for the LLM in Stage 1.

---

## Affidavits (markdown templates rendered to PDF)

Some processes need *supporting documents* alongside the main filled form — bank-sponsorship letters, parental-travel authorizations, health-insurance affidavits, host-school acceptance letters, etc. These typically aren't fillable PDF forms; they're free-form documents the applicant or a third party signs.

The pipeline treats these as **affidavits**: markdown templates with `[BRACKETED_PLACEHOLDERS]` that get LLM-filled from the situational context and rendered to PDF via [`src/lib/markdownToPdf.ts`](../src/lib/markdownToPdf.ts).

### Layout

```
assets/forms/<processId>/affidavits/
├── bank-sponsorship-affidavit.md
├── health-insurance-affidavit.md
├── parental-travel-authorization.md
└── ...
```

- Filenames (minus the `.md`) are the affidavit identifiers. Use lowercase-hyphenated names.
- A process opts in simply by creating the `affidavits/` directory and dropping `.md` files in. Without that directory, the affidavit step is a no-op for that process — `hasAffidavits(processId)` returns `false`.

### Template format

A template is a regular markdown document with `[PLACEHOLDER_NAME]` slots. Example:

```markdown
# Notarized Affidavit of Financial Support

**To:** Visa Office, Italian Consulate General of [CONSULATE_CITY]
**Date:** [DATE]

I, the undersigned, **[SPONSOR_FULL_LEGAL_NAME]**, residing at:

> [SPONSOR_STREET_ADDRESS]
> [SPONSOR_CITY], [SPONSOR_STATE] [SPONSOR_ZIP]

... do hereby solemnly affirm that I am the **[RELATIONSHIP_TO_STUDENT]** of
**[STUDENT_FULL_LEGAL_NAME]** ...
```

Placeholder names should be descriptive — the LLM uses them to look up the right value in `partyData`. Placeholders the LLM can't confidently fill are left as literal `[NAME]` strings so the user notices and hand-fills before signing.

### Applicability gating

Some affidavits don't apply to every applicant — parental-travel-authorization is only required for minors, bank-sponsorship is unnecessary when the applicant is self-funded, etc. The fill prompt explicitly asks the LLM to detect "this doesn't apply" and emit a skip JSON instead of filled markdown:

```json
{ "skip": true, "reason": "Applicant is 21; parental authorization only required for minors." }
```

The `FilledAffidavit` doc is still persisted (with `status: "skipped"`) for audit, but no PDF is rendered. This is how a single set of templates serves both minor and adult applicants without code branches.

### Running the affidavit step

```bash
npx ts-node --transpile-only src/scripts/fill-affidavits.ts \
  --contextId <situationalContextId> \
  [--affidavit <name>] \
  [--beneficiaryKey <party-name>] \
  [--outputDir <dir>]
```

Without `--affidavit`, every template in the process's `affidavits/` directory is processed in turn. Filled PDFs land in `output/affidavits/<processId>/<name>.pdf`.

### Data shape

```ts
// src/models/FilledAffidavit.ts
{
  processId: string;
  affidavitName: string;               // file basename without .md
  userId: string;
  situationalContextId: string;
  beneficiaryKey?: string;
  status: "filled" | "skipped";
  filledMarkdown: string;              // empty when skipped
  reason?: string;                     // present when skipped
  createdAt: Date;
}
```

`FilledAffidavit` is an additive new model — it has no impact on the form-filling pipeline. Adding affidavits to a process never affects how its forms are filled.

---

## Languages (optional `languages.txt`)

**English is the default and only assumed language.** Without a process-level opt-in (or a per-request override), the pipeline treats every uploaded document as English. There is no implicit second language — any non-English bias must be declared explicitly via the mechanism below.

A process MAY ship a `languages.txt` at its root that lists the Tesseract OCR language codes the user's documents are expected to be in. When present, the pipeline does two things:

1. **OCR uses that language string.** When `buildSituationContext` is called with a `processIdHint`, Tesseract is invoked with the matching process's language list (e.g. `eng+ita+spa`) instead of the default `eng`.
2. **Fill prompts include a light hint.** `fillFormMap` and `fillAffidavit` system prompts get one extra sentence: *"Documents in this filing are expected to be in: eng, ita, spa. Preserve names and proper nouns from the source language…"* — this tells Claude which language codes to expect when reading party data.

When the file is absent (the AoS case), neither behavior triggers — OCR falls back to its universal default and the fill prompts skip the language hint. This is intentional for processes where the user could plausibly upload documents in any language and a per-document detection step matters more than a process-wide bias.

### Layout

```
assets/forms/<processId>/languages.txt
```

### Format

One Tesseract code per line. Comments with `#` and blank lines are ignored. Order doesn't matter for OCR but the first entry is shown first in the prompt — put the dominant language first.

```text
# Tesseract codes — https://tesseract-ocr.github.io/tessdoc/Data-Files-in-different-versions.html
eng
ita
spa
```

Codes are Tesseract's 3-letter ISO 639-2 form (`eng`, `ita`, `spa`, `por`, `fra`, `deu`, …) — *not* the 2-letter ISO 639-1 form. If you need a code you don't have installed locally, `tesseract.js` will fetch the trained data on first use from <https://tessdata.projectnaptha.com/>.

### The OCR chicken-and-egg

OCR happens *before* the Stage 1 LLM determines the final `processId`. To make the language file useful at OCR time, the caller (frontend or CLI) needs to supply `processIdHint` on the request — typically derived from a "what are you applying for?" step the user filled out before uploading documents.

If no hint is supplied, OCR uses the default `eng` regardless of which process Stage 1 ultimately picks. The `languages.txt` still kicks in downstream (fillFormMap, fillAffidavit) because by then `processId` is known and stored on the SituationalContext.

**English is the default for a reason.** It's the lowest-assumption baseline — Tesseract's English data ships with the package, and English is the only language the system assumes without explicit input from the user or the process. Any other language is opt-in via `languages.txt` (process-wide bias) or, for one-off cases, a manual hint at intake time. Do not treat any specific second language as a "natural" default — that bias compounds across processes and hides real intake-quality problems.

If your process needs language-correct OCR and your frontend doesn't surface a process-picker step, three options:

1. Add the picker step (best long-term).
2. Default to a broader Tesseract string that covers the languages your users typically upload.
3. Add a two-pass OCR strategy (out of scope for this guide; see the README's notes on `osd.traineddata` + script-specific Latin/Cyrillic/etc. training data).

### Helper API

| Function | Returns | Notes |
| --- | --- | --- |
| `hasProcessLanguages(p)` | `boolean` | True iff `assets/forms/<p>/languages.txt` exists. |
| `listProcessLanguages(p)` | `string[] \| null` | Parsed codes (one per line), or `null` when the file is absent. `null` is the "no preference" signal. |
| `getProcessLanguagesTesseractString(p)` | `string \| null` | The `"eng+ita+spa"` form, ready to pass to `Tesseract.recognize`. `null` when the file is absent. |

`null` (not `[]`) is the explicit "no preference" sentinel. Don't conflate them — `[]` would mean "the user opted in but left it empty," which is treated the same as `null` today but might diverge later (e.g. error if empty after opt-in).

---

## Step-by-step: add a new process

The example below adds `k1-fiance`. Substitute your own identifier and forms.

### 1. Pick a `processId`

Use general kebab-case. Examples that work: `aos`, `k1-fiance`, `eu-blue-card`, `uk-skilled-worker`. Examples that don't: `K1Fiance` (case), `k1_fiance` (underscore), `michaels-special-thing` (not general).

### 2. Create the process directory and README

```bash
mkdir -p immi-server/assets/forms/k1-fiance
$EDITOR immi-server/assets/forms/k1-fiance/README.md
```

The README should be 2–4 short paragraphs answering:
- **What process is this?** A one-sentence definition.
- **When does this apply?** The user circumstances that match it — country, status, relationship, goal.
- **What's the outcome?** What the user gets at the end.

The Stage 1 prompt embeds this README (newlines collapsed) when asking the LLM to identify a process. The clearer and more situation-anchored the wording, the better the match. Read `assets/forms/aos/README.md` as a template.

### 3. Add the blank PDFs

```bash
mkdir -p immi-server/assets/forms/k1-fiance/i-129f
cp ~/Downloads/i-129f-blank.pdf immi-server/assets/forms/k1-fiance/i-129f/blank.pdf
```

Repeat for every form in the process. Form identifiers should be short and lowercase-hyphenated (`i-129f`, `ds-160`, `g-1450`). If the same form lives in multiple processes, copy the same `blank.pdf` into each — disk space is cheap, lookups stay simple, and FormContext can be tagged with multiple processes (see below).

### 4. Generate the FormMap and FormContext for each form

The one-time setup script does both stages:

```bash
cd immi-server
npx ts-node --transpile-only src/scripts/setup-form.ts k1-fiance i-129f
```

This:
1. Reads `assets/forms/k1-fiance/i-129f/blank.pdf`.
2. Extracts every fillable field ID (`buildFormMap`).
3. Calls Claude to annotate each field, identify `applicableProcesses`, and set `scope` (`buildFormContext`).
4. Persists a `FormMap` and a `FormContext` to MongoDB.

For forms shared across processes — say I-130 lives in both `aos` and `k1-followup` — you have two options:

- **Re-run `setup-form.ts` once per process.** Cleanest. Each FormContext is tagged with its single process and the loader picks the right one based on `(formId, processId)`.
- **Manually broaden one FormContext.** Update `applicableProcesses` to `["aos", "k1-followup"]` on a single FormContext document. The `fillFormMap` lookup matches either process. Use when re-running setup would just produce semantically-identical annotations.

The LLM is told which candidate processes to choose from (passed via `candidateProcessIds`); it will only include processes that genuinely apply. You don't need to pre-curate this.

### 4a. (Optional) Add a `languages.txt`

If you know the language(s) the user's source documents will be in, drop a `languages.txt` at the process root listing Tesseract codes (one per line, `#` comments ok):

```bash
cat > immi-server/assets/forms/k1-fiance/languages.txt <<'EOF'
# Expected source-document languages.
eng
spa
EOF
```

See the [Languages section](#languages-optional-languagestxt) for the OCR chicken-and-egg and how `processIdHint` makes this useful at OCR time. Skip this step if your process accepts documents in arbitrary languages (e.g. AoS).

### 4b. (If your process has affidavits) Drop the markdown templates

If the process needs supporting documents (sponsorship letters, parental authorizations, school letters, etc.), create the `affidavits/` directory and add `.md` templates:

```bash
mkdir -p immi-server/assets/forms/k1-fiance/affidavits
$EDITOR immi-server/assets/forms/k1-fiance/affidavits/bona-fide-relationship-statement.md
```

See the [Affidavits section](#affidavits-markdown-templates-rendered-to-pdf) above for template format and applicability gating. **No `setup-form` equivalent is needed for affidavits** — they're read directly from disk at fill time.

### 5. (No code changes needed) Run the pipeline

That's the whole installation. The next time someone runs the pipeline:

- `buildSituationContext` reads `listProcesses()` at request time, sees `k1-fiance` in the result, embeds its README in the system prompt, and lets the LLM pick that processId when it matches.
- `runPipeline` reads `processId` off the `SituationalContext` and uses `getBlankPdfPath(processId, formId)` to find your PDFs.
- `fillFormMap` looks up the FormContext that lists this process in `applicableProcesses`, injects the process README into its prompt as light context, and persists `processId` on the resulting `FilledFormMap`.

### 6. Validate the new process is discoverable

```bash
npx ts-node --transpile-only -e '
import { summarizeProcesses } from "./src/lib/processes";
console.log(JSON.stringify(summarizeProcesses(), null, 2));
'
```

You should see `k1-fiance` listed with its README text and the form IDs you added. If not:
- Check that `assets/forms/k1-fiance/` exists and contains at least one `<formId>/blank.pdf`.
- Check that the README is in the right place (`assets/forms/k1-fiance/README.md`).
- Re-run — `listProcesses()` reads the filesystem on every call; there's no cache.

### 7. Smoke-test end-to-end

The cheapest end-to-end check is to ask the Stage 1 prompt for a description that obviously matches your new process. You don't have to run real LLM calls — use `PRINT_PROMPT=1` to inspect what would be sent:

```bash
PRINT_PROMPT=1 npx ts-node --transpile-only src/services/buildSituationContext.ts \
  --situation "I'm a US citizen petitioning a foreign fiancé to join me in the US" \
  --process "K-1 fiancé visa"
```

The "Supported processes" block in the printed system prompt should include your new process. That confirms the data is reaching the LLM. To prove end-to-end fills work, run the full pipeline through `POST /api/pipeline/run` or the CLI scripts in `src/scripts/`.

---

## Step-by-step: extend an existing process

The same conventions apply. You're not "adding a process," you're adding assets to an existing one.

### Add a new form to an existing process

```bash
mkdir -p immi-server/assets/forms/aos/i-944
cp ~/Downloads/i-944-blank.pdf immi-server/assets/forms/aos/i-944/blank.pdf
npx ts-node --transpile-only src/scripts/setup-form.ts aos i-944
```

The Stage 1 prompt now sees `i-944` in the AoS form list and may select it. No further wiring needed.

### Add a process-specific affidavit or template

Put it under the process directory:

```
assets/forms/aos/affidavits/joint-sponsor-statement.md
```

If the pipeline needs to consume it, gate the logic on file existence, not on process name. Example:

```ts
import { getProcessDir } from "../lib/processes";

const candidate = path.join(getProcessDir(processId), "affidavits", "joint-sponsor-statement.md");
if (fs.existsSync(candidate)) {
  // include the affidavit in the prompt context
}
```

This pattern is also how to handle "some processes need X that others don't" without violating the cardinal rule.

### Replace a process's README

Just edit it. The next request picks up the new wording — no restart, no cache invalidation.

---

## Data shapes (reference)

### `SituationalContext`

```ts
{
  userId: string;
  processId: string;            // <-- set by buildSituationContext (Stage 1).
                                //     Reads fall back to "aos" for legacy docs.
  partyData: { [partyName]: { [key]: value } };
  requiredForms: Array<{ formId: string; beneficiaryKey?: string }>;
  situationSummary: string;
  status: "processing" | "ready" | "error";
  // ...other fields
}
```

`processId` is what every later stage reads to find assets and disambiguate FormContexts.

### `FormContext`

```ts
{
  formId: string;
  applicableProcesses: string[];     // <-- which processes this form belongs to
  formMetadata: {
    purpose: string;
    situations: string;
    "use-cases": string;
    "filing-context": string;
    "parties-involved": string;
    scope: "per-beneficiary" | "household";   // <-- drives requiredForms shape
  };
  fields: Array<{ field, description, party, notes }>;
}
```

A form can apply to multiple processes — set `applicableProcesses` to all that are valid. The `fillFormMap` lookup prefers a FormContext whose `applicableProcesses` includes the current `processId`; if none is tagged, it falls back to the most recent FormContext for that `formId`.

`scope` tells Stage 1 whether to emit one `requiredForms` entry per beneficiary or one per household.

### `FilledFormMap`

```ts
{
  formId: string;
  userId: string;
  processId: string;          // <-- inherited from SituationalContext at fill time
  beneficiaryKey?: string;    // absent for household-scope forms
  fields: { [fieldId]: value };
  skipped: Array<{ fieldId, reason }>;
  // ...
}
```

`processId` is traceability metadata. The pipeline doesn't branch on it; analytics / debugging do.

### Schema migrations

All three fields above (`SituationalContext.processId`, `FormContext.applicableProcesses`, `FilledFormMap.processId`) are additive. Legacy documents without them continue to work — readers call `resolveProcessId()` which returns `DEFAULT_PROCESS_ID` (`"aos"`) when the field is missing.

To stamp the fields onto legacy documents, run the idempotent backfill:

```bash
npx ts-node --transpile-only src/scripts/backfillProcess.ts --dry-run   # preview
npx ts-node --transpile-only src/scripts/backfillProcess.ts             # write
```

---

## Helper API (reference)

Everything is exported from [`src/lib/processes.ts`](../src/lib/processes.ts).

| Function | Returns | Notes |
| --- | --- | --- |
| `listProcesses()` | `string[]` | Process IDs that have at least one valid form subdirectory. Sorted alphabetically. |
| `listFormsInProcess(p)` | `string[]` | Form IDs (i.e. subdir names containing `blank.pdf`) inside a process. |
| `getBlankPdfPath(p, formId)` | `string` | Absolute path. Doesn't check existence — callers do that. |
| `getProcessReadme(p)` | `string \| null` | Reads `assets/forms/<p>/README.md`. `null` when absent. |
| `getProcessReadmePath(p)` | `string` | Just the path. |
| `getProcessDir(p)` | `string` | Absolute path to the process directory. |
| `processExists(p)` | `boolean` | True iff the directory exists (not necessarily that it has forms). |
| `summarizeProcesses()` | `ProcessSummary[]` | One entry per discovered process, each `{ processId, readme, formIds, affidavitNames, languages }`. What the LLM sees in Stage 1. |
| `resolveProcessId(stored)` | `string` | Trims, validates, and falls back to `DEFAULT_PROCESS_ID` for empty/missing input. Always returns a usable string. |
| `hasAffidavits(p)` | `boolean` | True iff `assets/forms/<p>/affidavits/` exists. |
| `listAffidavits(p)` | `string[]` | Affidavit identifiers (basename minus `.md`) under the process. Sorted. |
| `getAffidavitsDir(p)` | `string` | Absolute path to the `affidavits/` directory. |
| `getAffidavitPath(p, name)` | `string` | Absolute path to a specific affidavit template. |
| `readAffidavitTemplate(p, name)` | `string` | Reads the markdown template into a string. |
| `hasProcessLanguages(p)` | `boolean` | True iff `assets/forms/<p>/languages.txt` exists. |
| `listProcessLanguages(p)` | `string[] \| null` | Parsed Tesseract codes from `languages.txt`. `null` when the file is absent. |
| `getProcessLanguagesTesseractString(p)` | `string \| null` | Tesseract-formatted (`"eng+ita+spa"`). `null` when absent. |
| `DEFAULT_PROCESS_ID` | `"aos"` | Legacy fallback only. Don't use it as a primary identifier in new code. |

`listProcesses()` reads the filesystem on every call. That's fine — directory listings are fast and we want zero stale state when assets change.

---

## Validation

After adding a process, prove three things:

### 1. The structure is discoverable

```bash
npx ts-node --transpile-only -e '
import { summarizeProcesses } from "./src/lib/processes";
console.log(summarizeProcesses());
'
```

Confirm your new process is in the output with its README text and form list.

### 2. The Stage 1 prompt advertises it

```bash
PRINT_PROMPT=1 npx ts-node --transpile-only src/services/buildSituationContext.ts \
  --situation "<a sentence matching your process>" \
  --process "<the goal>"
```

The printed system prompt should list your new processId under "Supported processes" with its description and available forms.

### 3. Filling works end-to-end

Create a representative `SituationalContext` (via the API or by hand-injecting via `src/services/manualLoad.ts` with a JSON fixture), then run the validation harness:

```bash
npx ts-node --transpile-only src/scripts/validateRefactor.ts capture \
  --contextId <yourContextId> --label new-process-smoke
```

Each form in `requiredForms` should produce a `FilledFormMap`. Inspect the JSON written to `output/validate/new-process-smoke/`.

To measure intrinsic LLM variance for the new process before drawing conclusions about regressions:

```bash
npx ts-node --transpile-only src/scripts/validateRefactor.ts noise \
  --contextId <yourContextId>
```

This captures twice and diffs the two runs against each other. Use the resulting percentage as the "noise floor" — any later refactor should produce a diff that stays at or below this floor on the same context.

---

## Operational gotchas learned the hard way

These are not pitfalls in your assets — they're papercuts in the tooling around them. Worth knowing before you start.

- **Always `cd immi-server/` before running scripts.** All `ts-node` / `setup-form.ts` / `fill-affidavits.ts` invocations assume the working directory is `immi-server/`, not the repo root. Running from the repo root fails with `Cannot find module './foo.ts'` because ts-node resolves relative to cwd.

- **Use `--transpile-only` for ad-hoc ts-node runs.** Some files (`src/models/AppError.ts`) rely on global Express `Request.auth` augmentation that only loads when `requireAuth.ts` is in the import graph. CLI scripts that don't import the router-side stack will fail typecheck. `npx ts-node --transpile-only src/scripts/foo.ts` skips the project-wide typecheck and runs cleanly; rely on `npx tsc --noEmit` separately for full type validation.

- **`manualLoad.ts` only passes through fields it knows about.** When you add a new field to `SituationalContext` / `FormContext` / `FilledFormMap` (or load a fixture that depends on it), check that the corresponding `loadX` function in `src/services/manualLoad.ts` explicitly forwards it. Otherwise the fixture upserts a record with the new field silently stripped, and downstream stages fall back to defaults.

- **Fixture upserts replace by `userId`, not `_id`.** Re-running `manualLoad situational-context foo.json` overwrites the existing doc for that user instead of creating a new one. Pick a distinctive `userId` (e.g. `user-italy-demo`) per fixture so demos don't trample each other.

- **Affidavit applicability gating relies on `partyData` quality.** The skip JSON comes from the LLM reasoning about the situation — if the fixture has no DOB for the applicant, parental-travel-authorization won't be detected as skippable for an adult. Make sure `partyData` includes the facts the gate would need (DOB, sponsor presence, funding source, etc.).

- **`scope` is decided at FormContext-build time, not at fill time.** If `buildFormContext` mis-classifies a form's scope, Stage 1 will keep emitting wrong `requiredForms` entries (per-beneficiary vs. household). The fix is to re-run `setup-form.ts` for that form, or hand-edit `formMetadata.scope` on the FormContext document. The pipeline never re-asks.

---

## Real-world expectations (from the `italy-student-visa` validation run)

Calibration data from adding the Italian student visa process end-to-end:

- **`setup-form` time.** `buildFormMap` is instant (filesystem extraction). `buildFormContext` is one Opus call with the full PDF attached — ~30s–3min depending on form size. The Italian D visa (43 fields, 367 KB PDF) took ~2 minutes.
- **First-run fill rates with a realistic fixture.** Italian D visa: 41/43 fields (the 2 blanks were "no value yet" cases like Codice Fiscale, correctly flagged in the skip audit log). Affidavits: 4/5 filled, 1 correctly skipped by the applicability gate.
- **Italian-style conventions get applied automatically.** The fill prompt picked up DD/MM/YYYY date formatting and "N/A" vs blank consulate conventions from the FormContext's field-level notes alone — no process-specific prompt was needed. This is evidence the universal prompts hold up across very different form styles.
- **One Opus call per affidavit.** Five affidavits ≈ 5 calls. The applicability gate cost is the same as a fill (the LLM has to read the situation to decide), so a "skip" still bills tokens.

---

## Common pitfalls

- **Process advertised but never picked.** Symptom: Stage 1 keeps emitting `processId: "aos"` even when the new process should match. Usually the README is too generic. Tighten the wording to name the user's situation directly ("for a US citizen petitioning a foreign fiancé before they enter the US…").

- **`getBlankPdfPath` returns a path but the file isn't there.** Helper doesn't existence-check by design — callers do. Always wrap with `fs.existsSync()` before passing to `fillForm`.

- **`FormContext` lookup misses your new tagging.** `fillFormMap` prefers a FormContext where `applicableProcesses` *contains* the resolved `processId`. If you forgot to re-run `setup-form.ts` for the new process, the lookup falls back to the most recent FormContext for that `formId` — which may not be process-appropriate. Check `applicableProcesses` on the FormContext you expect to be used.

- **LLM invents a `processId` that doesn't exist on disk.** This is by design — the Stage 1 prompt explicitly tells it to invent a kebab-case identifier when no supported process fits. Downstream, `getBlankPdfPath(invented, formId)` will point at a directory that doesn't exist and the run fails cleanly with a missing-PDF error. If this happens regularly for a real workflow, add the new process to the filesystem.

- **Code branches on `processId === "aos"` start creeping in.** This is the only thing to actively police. Whenever a process needs different behavior, encode it in a `FormContext` field, a per-process asset on disk, or a `formMetadata.scope`-style property — never in a code branch.
