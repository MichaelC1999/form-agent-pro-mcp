# Adding a process

This guide explains how the pipeline models a "process" and how to add a new one (or build a custom workflow on top of an existing one) without changing any source code that branches on process identity.

A **process** is a form-filing workflow — e.g. US Adjustment of Status (`aos`), K-1 fiancé petition (`k1-fiance`), Italian Type-D visa (`italian-type-d`). Each process has its own catalog of forms, its own description of when it applies, and (optionally) its own supplemental assets. The pipeline stages are universal; the process distinguishes itself entirely through assets on disk and metadata on MongoDB documents.

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

A process may need supplemental assets the AoS process doesn't (custom affidavits, process-specific templates, etc.). The convention is to put them under the process directory using a uniform name across processes:

```
assets/forms/<processId>/
├── README.md
├── forms/...            (kept under <processId>/<formId>/ today; could be promoted to a forms/ subdir later)
├── affidavits/          (process-specific affidavit PDFs, if any)
└── prompts/             (process-specific prompt fragments, if any)
```

If any of these are added, the code that consumes them must check for *presence* on disk, not for the process name. Example pattern:

```ts
const affidavitsDir = path.join(getProcessDir(processId), "affidavits");
if (fs.existsSync(affidavitsDir)) {
  // process-specific affidavit logic
}
```

This keeps the cardinal rule intact: adding `assets/forms/k1-fiance/affidavits/` enables the behavior automatically; no code touches `processId === "k1-fiance"`.

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
  --situation "I'm a US citizen petitioning my fiancée from Brazil" \
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
| `summarizeProcesses()` | `ProcessSummary[]` | One entry per discovered process, each `{ processId, readme, formIds }`. What the LLM sees in Stage 1. |
| `resolveProcessId(stored)` | `string` | Trims, validates, and falls back to `DEFAULT_PROCESS_ID` for empty/missing input. Always returns a usable string. |
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

## Common pitfalls

- **Process advertised but never picked.** Symptom: Stage 1 keeps emitting `processId: "aos"` even when the new process should match. Usually the README is too generic. Tighten the wording to name the user's situation directly ("for a US citizen petitioning a foreign fiancé before they enter the US…").

- **`getBlankPdfPath` returns a path but the file isn't there.** Helper doesn't existence-check by design — callers do. Always wrap with `fs.existsSync()` before passing to `fillForm`.

- **`FormContext` lookup misses your new tagging.** `fillFormMap` prefers a FormContext where `applicableProcesses` *contains* the resolved `processId`. If you forgot to re-run `setup-form.ts` for the new process, the lookup falls back to the most recent FormContext for that `formId` — which may not be process-appropriate. Check `applicableProcesses` on the FormContext you expect to be used.

- **LLM invents a `processId` that doesn't exist on disk.** This is by design — the Stage 1 prompt explicitly tells it to invent a kebab-case identifier when no supported process fits. Downstream, `getBlankPdfPath(invented, formId)` will point at a directory that doesn't exist and the run fails cleanly with a missing-PDF error. If this happens regularly for a real workflow, add the new process to the filesystem.

- **Code branches on `processId === "aos"` start creeping in.** This is the only thing to actively police. Whenever a process needs different behavior, encode it in a `FormContext` field, a per-process asset on disk, or a `formMetadata.scope`-style property — never in a code branch.
