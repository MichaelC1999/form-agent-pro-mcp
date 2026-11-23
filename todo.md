# Backlog

Last reviewed 2026-11-22. This file is the one place for planned work. Keep
each item to a few lines here; don't create separate per-item markdown files.

## Later (planned, not now)

- **Multi-beneficiary eval and parallel fills.** The pipeline already fills one
  copy per form per beneficiary (`requiredForms` entries carry a
  `beneficiaryKey`), but `runPipeline` fills them one after another in a
  `for` loop, so time and API calls grow linearly with family size. The only
  eval packet (`jones-aos`) has a single beneficiary.
  - Add an eval packet for a family case (e.g. a principal plus a spouse and a
    child who each need their own I-485 / I-765) and confirm every copy fills.
  - Then consider running the per-form fills in parallel with a concurrency
    cap, keeping Anthropic rate limits in mind.
  - Web intake (check what's already built): ask how many beneficiaries, list
    each with name, relationship and notes, and allow one upload per document
    type per person.
- **Browser agent for USCIS online filing.** Many forms can also be filed
  through the USCIS online account instead of on paper. Autofill those web
  forms from the same situation context and filled form maps. Not the main
  route today. Starting points:
  - Every blank-PDF field has a tooltip with the printed question
    (`readFieldLabels`), and `FormContext` adds a description, so each filled
    value can become a question-and-answer pair in USCIS wording.
    `FormType` in `types/index.ts` already anticipates a `"web"` medium.
  - Doesn't carry over directly: overflow moved to Additional Information
    (put full values back), fixed PDF rows vs "add another" repeaters (build
    from `partyData` lists), checkbox export codes vs option labels, some
    wrong USCIS tooltips (prefer `FormContext`), evidence uploads (documents
    are deleted after extraction, so the user attaches their own), and
    screens with no PDF counterpart (eligibility, e-signature, payment).
- **Agent-extracted document facts on the MCP path.** Let the user's AI agent
  read documents itself and send structured facts in our `partyData`
  vocabulary instead of base64 files, so we never receive ID images or store
  OCR text, and extraction runs on their model.
  - Recommended shape: an optional `extractedDocuments` input on
    `build_situation_context` (per document: type, party, facts, confidence,
    notes), used instead of `documents`. Skip OCR and extraction, keep our
    `synthesizeContext` call so we still choose the process and forms.
    About 150 lines; `fillFormMap` and the web app don't change.
  - Validate before payment (size caps, non-empty facts, not both inputs);
    treat facts as untrusted data in prompts; ask agents to transcribe only
    what's visible; surface low-confidence fields to the user.
  - First run the cost query on `anthropiclogs` grouped by `service` to
    confirm extraction spend is worth moving.
- **Better Testing Materials.** We want dummy assets like passports, tax forms etc to benchmark form map fills and situation context after every change. We do need better developed materials for this testing.

---

## Older notes (Jul–Sep 2026, not yet reviewed)

Building backend
- Write tests (agentic testing flow? Generates the payloads + parsed doc data)
- Batch the fill-form-map anthropic requests (higher quality + more efficient)
- Add support for multi beneficiary situation context + form fill


Building front end
- Add a flow for additional beneficiaries + their forms
- Fix the drafts functionality - based on login
- "Application in progress" should check if the situation context was submit in last 3 hours. If not, show error - get in contact
- FOllowing stripe checkout, better loading screen to show steps of the process and minimal feedback
- Post-form download dashboard

Marketing
- Spend May + June posting information about Immigration
- Add H1B visa type flow
- Approach law firms about white labeling
- new logo
- new email
- write more "how to" content and pages




ENTERPRISE REFACTOR
- Landing page for law firms
- Login + dashboard before filling out form
- Selection + routing intake for the immigration type
- dashboard for viewing your clients
- Slightly different steps - tailored for each visa type
- Account / object ownership changes?


ADDING EDUCATION SUPPORT
- Landing page for schools + study abroad programs (new domain needed)
- Slightly different steps - tailored for each visa type

