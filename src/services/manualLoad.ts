import * as fs from "fs";
import * as path from "path";
import { FormMap } from "../models/FormMap";
import { FormContext } from "../models/FormContext";
import { SituationalContext } from "../models/SituationalContext";
import { FilledFormMap } from "../models/FilledFormMap";
import type {
  IFormMap,
  IFormContext,
  ISituationalContext,
  IFilledFormMap,
} from "../types";

// ─── Constants ────────────────────────────────────────────────────────────────

const ASSETS_DIR = path.resolve(__dirname, "../../assets/manual-loads");

const COLLECTIONS = ["form-map", "form-context", "situational-context", "filled-form-map"] as const;
type Collection = (typeof COLLECTIONS)[number];

// ─── File loader ──────────────────────────────────────────────────────────────

function loadJson(filePath: string): unknown {
  const resolved = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(ASSETS_DIR, filePath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }

  const raw = fs.readFileSync(resolved, "utf-8");

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in file: ${resolved}`);
  }
}

// ─── Per-collection upsert functions ─────────────────────────────────────────

/**
 * Upserts a FormMap document.
 * Match key: formId (replaces the latest version for this form).
 *
 * Expected JSON shape:
 * {
 *   "formId":  "i-485",
 *   "version": "1.0",          // optional, defaults to "1.0"
 *   "fields":  { "<fieldId>": "", ... }
 * }
 */
export async function loadFormMap(filePath: string): Promise<IFormMap> {
  const data = loadJson(filePath) as Partial<IFormMap>;

  if (!data.formId || typeof data.formId !== "string") {
    throw new Error(`form-map JSON must have a "formId" string field.`);
  }
  if (!data.fields || typeof data.fields !== "object") {
    throw new Error(`form-map JSON must have a "fields" object.`);
  }

  const doc = await FormMap.findOneAndUpdate(
    { formId: data.formId },
    {
      formId: data.formId,
      version: data.version ?? "1.0",
      createdAt: new Date(),
      fields: data.fields,
    },
    { upsert: true, new: true }
  );

  console.log(`[manualLoad] ✅ form-map upserted — formId: "${doc.formId}"  _id: ${doc._id}`);
  return doc.toObject() as IFormMap;
}

/**
 * Upserts a FormContext document.
 * Match key: formId.
 *
 * Expected JSON shape:
 * {
 *   "formId": "i-485",
 *   "formMetadata": { "purpose": "...", "situations": "...", ... },
 *   "fields": [
 *     { "field": "<fieldId>", "description": "...", "party": "...", "notes": "..." }
 *   ]
 * }
 */
export async function loadFormContext(filePath: string): Promise<IFormContext> {
  const data = loadJson(filePath) as Partial<IFormContext>;

  if (!data.formId || typeof data.formId !== "string") {
    throw new Error(`form-context JSON must have a "formId" string field.`);
  }
  if (!data.formMetadata || typeof data.formMetadata !== "object") {
    throw new Error(`form-context JSON must have a "formMetadata" object.`);
  }
  if (!Array.isArray(data.fields)) {
    throw new Error(`form-context JSON must have a "fields" array.`);
  }

  const doc = await FormContext.findOneAndUpdate(
    { formId: data.formId },
    {
      formId: data.formId,
      createdAt: new Date(),
      formMetadata: data.formMetadata,
      fields: data.fields,
    },
    { upsert: true, new: true }
  );

  console.log(
    `[manualLoad] ✅ form-context upserted — formId: "${doc.formId}"  ` +
    `fields: ${doc.fields.length}  _id: ${doc._id}`
  );
  return doc.toObject() as IFormContext;
}

/**
 * Upserts a SituationalContext document.
 * Match key: userId (replaces the existing context for this user).
 *
 * Expected JSON shape:
 * {
 *   "userId": "user-abc",
 *   "situationSummary": "...",
 *   "partyData": {
 *     "Applicant Full Name": { "Date of Birth": "1990-04-15", ... },
 *     ...
 *   },
 *   "documents": []   // optional
 * }
 */
export async function loadSituationalContext(filePath: string): Promise<ISituationalContext> {
  const data = loadJson(filePath) as Partial<ISituationalContext>;

  if (!data.userId || typeof data.userId !== "string") {
    throw new Error(`situational-context JSON must have a "userId" string field.`);
  }
  if (!data.partyData || typeof data.partyData !== "object") {
    throw new Error(`situational-context JSON must have a "partyData" object.`);
  }
  if (!data.situationSummary || typeof data.situationSummary !== "string") {
    throw new Error(`situational-context JSON must have a "situationSummary" string field.`);
  }

  const doc = await SituationalContext.findOneAndUpdate(
    { userId: data.userId },
    {
      userId: data.userId,
      createdAt: new Date(),
      situationSummary: data.situationSummary,
      partyData: data.partyData,
      documents: data.documents ?? [],
      requiredForms: Array.isArray(data.requiredForms) ? data.requiredForms : [],
    },
    { upsert: true, new: true }
  );

  console.log(
    `[manualLoad] ✅ situational-context upserted — userId: "${doc.userId}"  _id: ${doc._id}`
  );
  return doc.toObject() as ISituationalContext;
}

/**
 * Upserts a FilledFormMap document.
 * Match key: formId + userId (replaces the latest fill for this form/user pair).
 *
 * Expected JSON shape:
 * {
 *   "formId":         "i-485",
 *   "userId":         "user-abc",
 *   "assumptionLevel": "conservative",   // optional
 *   "fields":         { "<fieldId>": "<value>", ... }
 * }
 */
export async function loadFilledFormMap(filePath: string): Promise<IFilledFormMap> {
  const data = loadJson(filePath) as Partial<IFilledFormMap>;

  if (!data.formId || typeof data.formId !== "string") {
    throw new Error(`filled-form-map JSON must have a "formId" string field.`);
  }
  if (!data.userId || typeof data.userId !== "string") {
    throw new Error(`filled-form-map JSON must have a "userId" string field.`);
  }
  if (!data.fields || typeof data.fields !== "object") {
    throw new Error(`filled-form-map JSON must have a "fields" object.`);
  }

  const validLevels = ["conservative", "moderate", "liberal"];
  const assumptionLevel = validLevels.includes(data.assumptionLevel as string)
    ? data.assumptionLevel
    : "conservative";

  const doc = await FilledFormMap.findOneAndUpdate(
    { formId: data.formId, userId: data.userId },
    {
      formId: data.formId,
      userId: data.userId,
      createdAt: new Date(),
      assumptionLevel,
      fields: data.fields,
    },
    { upsert: true, new: true }
  );

  const filledCount = Object.values(doc.fields as Record<string, string>).filter((v) => v !== "").length;
  const totalCount = Object.keys(doc.fields as Record<string, string>).length;

  console.log(
    `[manualLoad] ✅ filled-form-map upserted — formId: "${doc.formId}"  userId: "${doc.userId}"  ` +
    `filled: ${filledCount}/${totalCount}  _id: ${doc._id}`
  );
  return doc.toObject() as IFilledFormMap;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

/**
 * CLI:
 *   npx ts-node src/services/manualLoad.ts <collection> <file>
 *
 * <collection>  one of: form-map | form-context | situational-context | filled-form-map
 * <file>        filename inside assets/manual-loads/, or an absolute path
 *
 * Examples:
 *   npx ts-node src/services/manualLoad.ts form-map              i-485-map.json
 *   npx ts-node src/services/manualLoad.ts form-context          i-485-context.json
 *   npx ts-node src/services/manualLoad.ts situational-context   jane-2024.json
 *   npx ts-node src/services/manualLoad.ts filled-form-map       jane-i485-filled.json
 */
if (require.main === module) {
  (async () => {
    const dotenv = await import("dotenv");
    dotenv.config();

    const [, , collection, file] = process.argv;

    if (!collection || !file) {
      console.error(
        `Usage: ts-node manualLoad.ts <collection> <file>\n` +
        `\n` +
        `Collections:\n` +
        COLLECTIONS.map((c) => `  ${c}`).join("\n") +
        `\n\n` +
        `<file> is relative to assets/manual-loads/ or an absolute path.\n` +
        `\n` +
        `Examples:\n` +
        `  ts-node manualLoad.ts form-map             i-485-map.json\n` +
        `  ts-node manualLoad.ts form-context         i-485-context.json\n` +
        `  ts-node manualLoad.ts situational-context  jane-2024.json\n` +
        `  ts-node manualLoad.ts filled-form-map      jane-i485-filled.json`
      );
      process.exit(1);
    }

    if (!COLLECTIONS.includes(collection as Collection)) {
      console.error(
        `Unknown collection "${collection}". Must be one of:\n` +
        COLLECTIONS.map((c) => `  ${c}`).join("\n")
      );
      process.exit(1);
    }

    const { connectDB, disconnectDB } = await import("../lib/db");
    await connectDB();

    try {
      switch (collection as Collection) {
        case "form-map":
          await loadFormMap(file);
          break;
        case "form-context":
          await loadFormContext(file);
          break;
        case "situational-context":
          await loadSituationalContext(file);
          break;
        case "filled-form-map":
          await loadFilledFormMap(file);
          break;
      }
    } catch (err) {
      console.error("❌", err instanceof Error ? err.message : err);
      await disconnectDB();
      process.exit(1);
    }

    await disconnectDB();
    process.exit(0);
  })();
}
