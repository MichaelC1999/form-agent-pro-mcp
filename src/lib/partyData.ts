/**
 * Standard vocabulary for SituationalContext.partyData.
 *
 * Every fact the situational-context step extracts lands under one of these
 * keys, worded the way USCIS field labels word them ("Family Name (Last Name)",
 * "Street Number and Name", "I-94 Arrival-Departure Record Number"). The same
 * fact therefore gets the same key on every run, whatever document it came
 * from, and fillFormMap can match it to the field that asks for it.
 *
 * The model fills buildSituationResponseSchema() (structured output); toPartyDataMap
 * converts that into the stored partyData shape — party name → { key: value } —
 * which fillFormMap, fillAffidavit and the dashboard read unchanged.
 */

import type { MissingInformationItem, PartyDataMap, RequiredFormEntry } from "../types";

export const PARTY_ROLES = ["Beneficiary", "Petitioner", "Sponsor", "Joint Sponsor", "Derivative Beneficiary", "Other"] as const;

/** Single-value facts about a person. Dates are YYYY-MM-DD. */
export const PERSON_KEYS = [
  "Family Name (Last Name)",
  "Given Name (First Name)",
  "Middle Name",
  "Date of Birth",
  "Sex",
  "City/Town of Birth",
  "State/Province of Birth",
  "Country of Birth",
  "Country of Citizenship / Nationality",
  "A-Number",
  "USCIS Online Account Number",
  "U.S. Social Security Number",
  "Daytime Telephone Number",
  "Mobile Telephone Number",
  "Email Address",
  "Ethnicity",
  "Race",
  "Height",
  "Weight",
  "Eye Color",
  "Hair Color",
  "Current Marital Status",
  "Number of Times Married",
  "Passport Number",
  "Passport Country of Issuance",
  "Passport Issue Date",
  "Passport Expiration Date",
  "Visa Number",
  "Visa Class",
  "Visa Issue Date",
  "Visa Expiration Date",
  "Visa Issuing Post",
  "I-94 Arrival-Departure Record Number",
  "Date of Last Arrival",
  "Place of Last Arrival",
  "Status at Last Arrival (Class of Admission)",
  "Current Immigration Status",
  "Authorized Stay Expiration Date",
  "Current Occupation",
  "Annual Income",
] as const;

/** Fields of an address. "Street Number and Name" keeps the order used in the address's own country. */
export const ADDRESS_KEYS = [
  "In Care Of Name",
  "Street Number and Name",
  "Apt/Ste/Flr",
  "Apt/Ste/Flr Number",
  "Neighborhood / Colonia",
  "City or Town",
  "State",
  "Zip Code",
  "Province",
  "Postal Code",
  "Country",
] as const;

/** Single-object facts about a person. */
export const PERSON_OBJECT_KEYS: Record<string, readonly string[]> = {
  "Mailing Address": ADDRESS_KEYS,
};

/** List-valued facts about a person: key → fields of each entry. */
export const PERSON_LIST_KEYS: Record<string, readonly string[]> = {
  "Other Names Used": ["Family Name (Last Name)", "Given Name (First Name)", "Middle Name"],
  "Address History": [...ADDRESS_KEYS, "Date From", "Date To"],
  "Employment History": ["Employer or Company Name", "Occupation", ...ADDRESS_KEYS.slice(1), "Date From", "Date To"],
  Parents: [
    "Relationship",
    "Family Name (Last Name)",
    "Given Name (First Name)",
    "Middle Name",
    "Family Name at Birth",
    "Date of Birth",
    "Sex",
    "City/Town of Birth",
    "Country of Birth",
    "City/Town of Residence",
    "Country of Residence",
    "Date of Death",
  ],
  "Prior Marriages": [
    "Spouse Family Name (Last Name)",
    "Spouse Given Name (First Name)",
    "Spouse Middle Name",
    "Date of Marriage",
    "Date Marriage Ended",
    "How Marriage Ended",
  ],
  Children: [
    "Family Name (Last Name)",
    "Given Name (First Name)",
    "Middle Name",
    "Relationship",
    "Date of Birth",
    "Country of Birth",
  ],
  "Prior U.S. Entries": ["Date of Arrival", "Place of Arrival", "Class of Admission", "Date of Departure", "I-94 Number"],
  "Prior Immigration Filings": ["Form", "Receipt Number", "Date Filed", "Filed For", "Outcome"],
  "Background Statements": ["Statement"],
  "Extraordinary Ability Evidence": ["Criterion", "Description", "Issuing Organization", "Date"],
};

/** Facts about the current marriage — stored under the "Marriage" subject. */
export const MARRIAGE_KEYS = [
  "Date of Marriage",
  "City/Town of Marriage",
  "State/Province of Marriage",
  "Country of Marriage",
  "Date Began Living Together",
] as const;

/** Facts about the sponsor's household — stored under the "Household" subject. */
export const HOUSEHOLD_KEYS = ["Household Size", "Number of Dependents", "Total Household Income"] as const;

/**
 * Facts about a petitioning company or agent (e.g. the I-129 petitioner) —
 * stored under the "Petitioning Organization" subject. An individual
 * petitioner is a party instead.
 */
export const ORGANIZATION_KEYS = [
  "Legal Business Name",
  "Doing Business As (DBA) Name",
  "Petitioner Type",
  "Federal Employer Identification Number (FEIN)",
  "Type of Business",
  "NAICS Code",
  "Year Established",
  "Current Number of U.S. Employees",
  "Gross Annual Income",
  "Net Annual Income",
  ...ADDRESS_KEYS,
  "Daytime Telephone Number",
  "Email Address",
  "Authorized Signatory Family Name (Last Name)",
  "Authorized Signatory Given Name (First Name)",
  "Authorized Signatory Title",
] as const;

/** Facts about the offered job or engagement — stored under the "Job Offer" subject. */
export const JOB_OFFER_KEYS = [
  "Classification Sought",
  "Basis for Classification",
  "Requested Action",
  "Job Title",
  "Nontechnical Job Description",
  "Nature of Event or Activity",
  "Worksite Street Number and Name",
  "Worksite Apt/Ste/Flr Number",
  "Worksite City or Town",
  "Worksite State",
  "Worksite Zip Code",
  "Additional Worksites (Itinerary)",
  "Full-Time Position",
  "Hours Per Week",
  "Wages Amount",
  "Wages Per",
  "Other Compensation",
  "Dates of Intended Employment From",
  "Dates of Intended Employment To",
  "Written Contract Exists",
] as const;

/** Facts about the peer-group / labor-organization consultation — stored under the "Consultation" subject. */
export const CONSULTATION_KEYS = [
  "Consultation Organization Name",
  "Consultation Organization Street Number and Name",
  "Consultation Organization City or Town",
  "Consultation Organization State",
  "Consultation Organization Zip Code",
  "Consultation Organization Telephone Number",
  "Date of Consultation Letter",
  "Consultation Outcome",
] as const;

/** Subject names for the non-person entries in partyData. */
export const MARRIAGE_SUBJECT = "Marriage";
export const HOUSEHOLD_SUBJECT = "Household";
export const ORGANIZATION_SUBJECT = "Petitioning Organization";
export const JOB_OFFER_SUBJECT = "Job Offer";
export const CONSULTATION_SUBJECT = "Consultation";
export const CASE_SUBJECT = "Case Details";

// ─── Prompt text ──────────────────────────────────────────────────────────────

const quote = (keys: readonly string[]) => keys.map((k) => `"${k}"`).join(", ");

/**
 * Rules for the partyData part of the situational-context prompt. Shared by the
 * monolithic and per-document-synthesis prompts so both produce the same shape.
 */
export function renderPartyDataRules(): string {
  const lists = Object.entries(PERSON_LIST_KEYS)
    .map(([key, fields]) => `  - "${key}": entries with ${quote(fields)}`)
    .join("\n");

  return `PART D — Structured Party Data
Record every fact from the documents and UI answers in the response fields below. The field names are fixed and follow USCIS form wording; put each fact under the field that names it.

PARTIES — one entry per person (beneficiaries, petitioner, sponsors, children, other relevant people). Merge facts about the same person from every document into that one entry:
- "name": the person's full current legal name as written on their identity documents. Use the same string everywhere it is referenced (requiredForms beneficiaryKey).
- "role": one of ${quote(PARTY_ROLES)}. A U.S. citizen or LPR petitioner who also signs the Affidavit of Support is "Petitioner".
- "facts": one { "key", "value" } pair per known single-value fact, "key" taken from: ${quote(PERSON_KEYS)}. Leave out a key whose value appears nowhere in the materials — never guess or invent a value.
- "lists": one { "list", "entries" } item per list that has entries; each entry is a set of { "field", "value" } pairs.
  "Mailing Address" (one entry: ${quote(ADDRESS_KEYS)}) — only when it differs from the current physical address.
${lists}
- "otherFacts": any fact about this person that has no field above, as { "key", "value" } pairs with a short, specific English key.

MARRIAGE / HOUSEHOLD / CASE:
- "marriage": { "key", "value" } pairs from ${quote(MARRIAGE_KEYS)} for the current marriage between the parties.
- "household": { "key", "value" } pairs from ${quote(HOUSEHOLD_KEYS)} for the sponsor's household.

PETITIONING ORGANIZATION / JOB OFFER / CONSULTATION (employment-based petitions; leave empty when the case has none):
- "petitioningOrganization": { "key", "value" } pairs from ${quote(ORGANIZATION_KEYS)} for the company or agent filing the petition. "Petitioner Type" is "U.S. Employer", "U.S. Agent", or "Foreign Employer through U.S. Agent". The address fields are the organization's address. An individual petitioner is a party instead.
- "jobOffer": { "key", "value" } pairs from ${quote(JOB_OFFER_KEYS)} for the offered position or engagement. "Classification Sought" is the requested class as written on the form (e.g. "O-1A", "O-1B"). "Requested Action" says what the petition asks for (e.g. "Change status and extend stay"). "Wages Per" is "hour", "week", "month", or "year". "Full-Time Position" and "Written Contract Exists" are "Yes" or "No". Several venues or engagements go in "Additional Worksites (Itinerary)".
- "consultation": { "key", "value" } pairs from ${quote(CONSULTATION_KEYS)} for the advisory opinion from a peer group, labor organization, or management organization. "Consultation Outcome" is "No objection", "Objection", "No appropriate peer group exists", or "Pending".
- Evidence of the beneficiary's achievements (awards, memberships, press, judging, original contributions, publications, critical roles, high salary, commercial success) goes in the beneficiary's "Extraordinary Ability Evidence" list, one entry per item; "Criterion" names the regulatory criterion it supports in a few words (e.g. "Nationally recognized award").

- "caseFacts": facts about the case or the evidence that belong to no single person (e.g. lease terms, joint accounts), as { "key", "value" } pairs.

VALUE RULES:
- English only; translate labels and narrative values, but keep proper nouns (names, cities, streets, employers) exactly as written.
- Dates: YYYY-MM-DD. Where only a month or year is known, give what is known (YYYY-MM or YYYY).
- Addresses: "Street Number and Name" exactly as written, in the order of the address's own country ("Avenida Simulada 1234" stays as is). Neighborhood or colonia goes in "Neighborhood / Colonia", never in the street line. U.S. states as 2-letter codes in "State"; elsewhere use "Province" and "Postal Code".
- "Address History" and "Employment History": most recent first, covering at least the last five years. The current entry has "Date To": "Present". Record a period without work as an "Employment History" entry with "Employer or Company Name": "Unemployed".
- Phone, SSN, A-Number and I-94 numbers: digits only.
- Names: given, middle and family names split as on the person's passport or birth certificate; compound family names (e.g. "Garcia Lopez") stay together in "Family Name (Last Name)".
- "Background Statements": each statement the user makes about this person's immigration, criminal, or employment history (e.g. "Has never been arrested"), worded as the user stated it. Do not infer violations or eligibility problems that the materials do not state.

PHYSICAL & BIOGRAPHIC ATTRIBUTES — "Height", "Weight", "Eye Color", "Hair Color", "Ethnicity", "Race", "Sex" are required on government forms; record them exactly as given (e.g. "5 ft 4 in", "130 lbs") whenever they appear in any document or answer.

${renderMissingInformationRules()}`;
}

/**
 * Rules for the "missingInformation" part of the situational-context response:
 * what the required forms will ask for that the materials don't supply. It is
 * shown to the user (and their AI agent) so they can supply it or fill it in
 * by hand.
 */
export function renderMissingInformationRules(): string {
  return `PART E — Missing Information
List what the required forms will ask for that the user's answers and documents do not supply, so the user can provide it or fill it in by hand. Each "missingInformation" entry:
- "subject": the party name exactly as in "parties", or a subject such as "Petitioning Organization", "Job Offer", "Consultation", "Marriage", or "Household".
- "item": the missing information as a category a person would recognize (e.g. "Employer's FEIN", "Address history before June 2019", "Mother's date and city of birth"), not individual form field names.
- "neededFor": the formIds from requiredForms that ask for it.
- "howToProvide": one short sentence on where it is usually found or what to ask (e.g. "Shown on the employer's IRS Form SS-4 or W-2").
Only list information that applies to this situation and is genuinely absent from the materials. Leave out signatures and signing dates, sections completed by someone else (civil surgeon, interpreter, preparer, USCIS), and questions the user has already answered. Group related gaps into one entry, put the most important first, and list at most 20. Return an empty array when nothing is missing.`;
}

// ─── Response schema ──────────────────────────────────────────────────────────
//
// Facts are { key, value } pairs whose key is an enum of the vocabulary, not
// an object with one property per key: the schema still fixes the key names,
// but stays small enough to compile (one closed object per vocabulary key
// exceeds the structured-output grammar limit).

const str = { type: "string" } as const;

const pairs = (keyName: string, keys?: readonly string[]) => ({
  type: "array",
  items: {
    type: "object",
    properties: { [keyName]: keys ? { type: "string", enum: [...keys] } : str, value: str },
    required: [keyName, "value"],
    additionalProperties: false,
  },
});

/** Every list name, including the single-entry "Mailing Address". */
const LIST_NAMES = [...Object.keys(PERSON_OBJECT_KEYS), ...Object.keys(PERSON_LIST_KEYS)];
/** Every field name any list uses. */
const LIST_FIELDS = [...new Set([...Object.values(PERSON_OBJECT_KEYS), ...Object.values(PERSON_LIST_KEYS)].flat())];

/** Structured-output schema for the situational-context call: the success shape or the error shape. */
export function buildSituationResponseSchema(): Record<string, unknown> {
  return {
    anyOf: [
      {
        type: "object",
        properties: {
          situationSummary: str,
          processId: str,
          requiredForms: {
            type: "array",
            items: {
              type: "object",
              properties: { formId: str, beneficiaryKey: str },
              required: ["formId", "beneficiaryKey"],
              additionalProperties: false,
            },
          },
          parties: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: str,
                role: { type: "string", enum: [...PARTY_ROLES] },
                facts: pairs("key", PERSON_KEYS),
                lists: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      list: { type: "string", enum: LIST_NAMES },
                      entries: { type: "array", items: pairs("field", LIST_FIELDS) },
                    },
                    required: ["list", "entries"],
                    additionalProperties: false,
                  },
                },
                otherFacts: pairs("key"),
              },
              required: ["name", "role", "facts", "lists", "otherFacts"],
              additionalProperties: false,
            },
          },
          marriage: pairs("key", MARRIAGE_KEYS),
          household: pairs("key", HOUSEHOLD_KEYS),
          petitioningOrganization: pairs("key", ORGANIZATION_KEYS),
          jobOffer: pairs("key", JOB_OFFER_KEYS),
          consultation: pairs("key", CONSULTATION_KEYS),
          caseFacts: pairs("key"),
          missingInformation: {
            type: "array",
            items: {
              type: "object",
              properties: { subject: str, item: str, neededFor: { type: "array", items: str }, howToProvide: str },
              required: ["subject", "item", "neededFor", "howToProvide"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "situationSummary",
          "processId",
          "requiredForms",
          "parties",
          "marriage",
          "household",
          "petitioningOrganization",
          "jobOffer",
          "consultation",
          "caseFacts",
          "missingInformation",
        ],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: { code: str, message: str, details: str },
            required: ["code", "message"],
            additionalProperties: false,
          },
        },
        required: ["error"],
        additionalProperties: false,
      },
    ],
  };
}

// ─── Conversion to the stored shape ───────────────────────────────────────────

type KeyValue = { key: string; value: string };
type FieldValue = { field: string; value: string };

export interface SituationResponse {
  situationSummary: string;
  processId: string;
  requiredForms: Array<{ formId: string; beneficiaryKey: string }>;
  parties: Array<{
    name: string;
    role: string;
    facts: KeyValue[];
    lists: Array<{ list: string; entries: FieldValue[][] }>;
    otherFacts: KeyValue[];
  }>;
  marriage: KeyValue[];
  household: KeyValue[];
  petitioningOrganization?: KeyValue[];
  jobOffer?: KeyValue[];
  consultation?: KeyValue[];
  caseFacts: KeyValue[];
  missingInformation?: MissingInformationItem[];
}

/** missingInformation with blank entries dropped and text trimmed; unknown formIds kept as given. */
export function normalizeMissingInformation(response: SituationResponse): MissingInformationItem[] {
  return (response.missingInformation ?? [])
    .filter((m) => m && !isBlank(m.item))
    .map((m) => ({
      subject: (m.subject ?? "").trim(),
      item: m.item.trim(),
      neededFor: (Array.isArray(m.neededFor) ? m.neededFor : []).map((f) => String(f).trim()).filter(Boolean),
      howToProvide: (m.howToProvide ?? "").trim(),
    }));
}

const isBlank = (v: unknown) => typeof v !== "string" || v.trim() === "";

/** Folds { key, value } pairs into an object, skipping blanks; later duplicates win. */
function fromPairs(target: Record<string, unknown>, items: KeyValue[]): Record<string, unknown> {
  for (const { key, value } of items) {
    if (isBlank(key) || isBlank(value)) continue;
    target[key.trim()] = value;
  }
  return target;
}

/** One list entry as an object, or null when every field is blank. */
function entryObject(entry: FieldValue[]): Record<string, string> | null {
  const obj: Record<string, string> = {};
  for (const { field, value } of entry) {
    if (!isBlank(field) && !isBlank(value)) obj[field] = value;
  }
  return Object.keys(obj).length > 0 ? obj : null;
}

/**
 * Fixed order for list entries, so the same facts produce the same form rows on
 * every run: parents father first (form "Parent 1" / "Parent 2"), dated
 * histories most recent first. Dates are YYYY-MM-DD prefixes, so a string
 * comparison orders them; the current entry ("Present") sorts first.
 */
const LIST_ORDER: Record<string, (a: Record<string, string>, b: Record<string, string>) => number> = {
  Parents: (a, b) => parentRank(a) - parentRank(b),
  "Address History": byDateDesc("Date From"),
  "Employment History": byDateDesc("Date From"),
  "Prior U.S. Entries": byDateDesc("Date of Arrival"),
};

function parentRank(entry: Record<string, string>): number {
  const rel = `${entry["Relationship"] ?? ""} ${entry["Sex"] ?? ""}`.toLowerCase();
  if (/\b(father|male)\b/.test(rel)) return 0;
  if (/\b(mother|female)\b/.test(rel)) return 1;
  return 2;
}

function byDateDesc(field: string) {
  return (a: Record<string, string>, b: Record<string, string>) => {
    const current = (e: Record<string, string>) => /present/i.test(e["Date To"] ?? "");
    if (current(a) !== current(b)) return current(a) ? -1 : 1;
    return (b[field] ?? "").localeCompare(a[field] ?? "");
  };
}

/**
 * Converts the structured response into the stored partyData map — party name
 * → { "Role", standard keys, lists, other facts } plus "Marriage", "Household"
 * and "Case Details" subjects — dropping blank values so only known facts remain.
 * "Mailing Address" is stored as a single object; every other list as an array,
 * in LIST_ORDER where one is defined.
 */
export function toPartyDataMap(response: SituationResponse): PartyDataMap {
  const partyData: PartyDataMap = {};

  for (const party of response.parties) {
    const name = party.name.trim();
    if (!name) continue;
    const facts = fromPairs({ Role: party.role }, party.facts);
    for (const { list, entries } of party.lists) {
      const objects = entries.map(entryObject).filter((e): e is Record<string, string> => e !== null);
      if (objects.length === 0) continue;
      const order = LIST_ORDER[list];
      facts[list] = list in PERSON_OBJECT_KEYS ? objects[0] : order ? [...objects].sort(order) : objects;
    }
    fromPairs(facts, party.otherFacts);
    partyData[name] = facts;
  }

  const subjects: Array<[string, KeyValue[] | undefined]> = [
    [MARRIAGE_SUBJECT, response.marriage],
    [HOUSEHOLD_SUBJECT, response.household],
    [ORGANIZATION_SUBJECT, response.petitioningOrganization],
    [JOB_OFFER_SUBJECT, response.jobOffer],
    [CONSULTATION_SUBJECT, response.consultation],
    [CASE_SUBJECT, response.caseFacts],
  ];
  for (const [subject, items] of subjects) {
    const obj = fromPairs({}, items ?? []);
    if (Object.keys(obj).length > 0) partyData[subject] = obj;
  }

  return partyData;
}

/**
 * requiredForms with blank beneficiaryKeys removed (household-scope forms) and
 * each key matched to a party name, ignoring case and spacing, so it always
 * names an existing partyData entry.
 */
export function normalizeResponseForms(response: SituationResponse): RequiredFormEntry[] {
  const names = response.parties.map((p) => p.name.trim()).filter(Boolean);
  const canon = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return response.requiredForms
    .filter((e) => !isBlank(e.formId))
    .map((e) => {
      const key = e.beneficiaryKey.trim();
      if (!key) return { formId: e.formId.trim() };
      const match = names.find((n) => canon(n) === canon(key)) ?? key;
      return { formId: e.formId.trim(), beneficiaryKey: match };
    });
}
