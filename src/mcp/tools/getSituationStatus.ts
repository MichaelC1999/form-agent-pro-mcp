import { isValidObjectId } from "mongoose";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { SituationalContext } from "../../models/SituationalContext";
import { FilledFormMap } from "../../models/FilledFormMap";
import { normalizeRequiredForms } from "../../types";
import type { FormGenerationFailure } from "../../types";
import { mcpCaller } from "../shared";

const FORM_STATES = ["ready", "pending", "failed", "not_generated"] as const;
type FormState = (typeof FORM_STATES)[number];

const outputSchema = {
  situationalContextId: z.string(),
  status: z
    .enum(["processing", "ready", "error", "not_found"])
    .describe("processing = still analyzing the situation; ready = analysis done; error = analysis failed"),
  pipelineComplete: z.boolean().describe("True once every required form has been attempted"),
  processId: z.string().nullable().describe("Immigration process identified, e.g. 'aos'"),
  situationSummary: z.string().nullable().describe("Short summary of the user's situation"),
  forms: z.array(
    z.object({
      formId: z.string(),
      beneficiaryKey: z.string().nullable().describe("Which beneficiary this copy is for, if more than one"),
      state: z.enum(FORM_STATES).describe("ready, pending (still filling), failed, or not_generated"),
      filledFormMapId: z.string().nullable().describe("Present when ready; used to download the PDF"),
      filledFieldCount: z.number().nullable(),
      skippedFieldCount: z.number().nullable().describe("Fields left blank for lack of information"),
      failureReason: z.string().nullable(),
    })
  ),
  missingInformation: z
    .array(
      z.object({
        subject: z.string().describe("Person or subject the information is about, e.g. a party name or 'Job Offer'"),
        item: z.string().describe("What is missing, e.g. \"Employer's FEIN\""),
        neededFor: z.array(z.string()).describe("Form IDs that ask for it"),
        howToProvide: z.string().describe("Where it is usually found or what to ask the user"),
      })
    )
    .describe(
      "Information the forms ask for that the user's answers and documents did not supply. Those " +
        "fields are left blank. Available once analysis is done (status ready); empty when nothing is missing."
    ),
  message: z.string().describe("Plain-language status for the user"),
};

type Output = z.infer<z.ZodObject<typeof outputSchema>>;

function result(out: Output, isError = false): CallToolResult {
  return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError };
}

const entryKey = (formId: string, beneficiaryKey?: string | null) => `${formId}::${beneficiaryKey ?? ""}`;

export function registerGetSituationStatus(server: McpServer): void {
  server.registerTool(
    "get_situation_status",
    {
      title: "Check progress on a user's immigration forms",
      description:
        "Use when the user asks whether their immigration forms are ready. Free and read-only. " +
        "Returns the progress of a case started with build_situation_context: whether " +
        "analysis is done, which forms are required, and each form's state (ready, pending, failed, " +
        "not_generated). Preparation takes several minutes; poll no more than about once every 30 " +
        "seconds until pipelineComplete is true. Once analysis is done it also lists missingInformation: " +
        "what the forms ask for that the user's answers and documents did not supply. Those fields are " +
        "left blank, so share the list with the user; they can fill those fields in on the PDFs themselves.",
      inputSchema: {
        situationalContextId: z.string().max(100).describe("The ID returned by build_situation_context"),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ situationalContextId }, extra) => {
      const notFound = (): CallToolResult =>
        result(
          {
            situationalContextId,
            status: "not_found",
            pipelineComplete: false,
            processId: null,
            situationSummary: null,
            forms: [],
            missingInformation: [],
            message: "No situation with that ID was found for this account.",
          },
          true
        );

      const caller = mcpCaller(extra.authInfo);
      if (!caller || !isValidObjectId(situationalContextId)) return notFound();

      const ctx = await SituationalContext.findById(situationalContextId).lean();
      // Another user's situation is reported as not found so IDs can't be probed.
      if (!ctx || ctx.userId !== caller.userId) return notFound();

      const required = normalizeRequiredForms(ctx.requiredForms);
      const pipelineComplete = Boolean(ctx.pipelineCompletedAt);

      // FilledFormMaps aren't linked to a context by ID. Like the report page,
      // take the user's latest map per (form, beneficiary), but only maps
      // created after this situation, so an older submission can't show through.
      const maps = await FilledFormMap.find({ userId: caller.userId, createdAt: { $gte: ctx.createdAt } })
        .sort({ createdAt: -1 })
        .select({ formId: 1, beneficiaryKey: 1, fields: 1, skipped: 1, createdAt: 1 })
        .lean();
      const latestMap = new Map<string, (typeof maps)[number]>();
      for (const m of maps) {
        const k = entryKey(m.formId, m.beneficiaryKey);
        if (!latestMap.has(k)) latestMap.set(k, m);
      }
      const failures = new Map<string, FormGenerationFailure>();
      for (const f of ctx.failedForms ?? []) failures.set(entryKey(f.formId, f.beneficiaryKey), f);

      const forms = required.map((e) => {
        const k = entryKey(e.formId, e.beneficiaryKey);
        const map = latestMap.get(k);
        const failure = failures.get(k);
        // A retry can produce a map after an earlier failure; the newer one wins.
        const failedAfterMap = failure && (!map || new Date(failure.failedAt) > new Date(map.createdAt));
        let state: FormState;
        if (map && !failedAfterMap) state = "ready";
        else if (failure) state = "failed";
        else if (pipelineComplete || ctx.status === "error") state = "not_generated";
        else state = "pending";
        return {
          formId: e.formId,
          beneficiaryKey: e.beneficiaryKey ?? null,
          state,
          filledFormMapId: state === "ready" && map ? String(map._id) : null,
          filledFieldCount: state === "ready" && map ? Object.keys(map.fields ?? {}).length : null,
          skippedFieldCount: state === "ready" && map ? (map.skipped ?? []).length : null,
          failureReason: state === "failed" && failure ? failure.reason : null,
        };
      });

      const ready = forms.filter((f) => f.state === "ready").length;
      let message: string;
      if (ctx.status === "error") {
        message = "Analyzing the situation failed. The user may need to start again.";
      } else if (ctx.status === "processing") {
        message = "Still analyzing the situation and documents. Check again in a minute.";
      } else if (!pipelineComplete) {
        message = `Filling forms: ${ready} of ${forms.length} ready so far. Check again shortly.`;
      } else {
        message = `Done: ${ready} of ${forms.length} forms ready.`;
      }

      const missingInformation = (ctx.missingInformation ?? []).map((m) => ({
        subject: m.subject ?? "",
        item: m.item,
        neededFor: m.neededFor ?? [],
        howToProvide: m.howToProvide ?? "",
      }));
      if (ctx.status === "ready" && missingInformation.length > 0) {
        message +=
          ` ${missingInformation.length} item(s) of information were not in the user's answers or documents; ` +
          "those fields are left blank for the user to complete (see missingInformation).";
      }

      return result({
        situationalContextId,
        status: ctx.status,
        pipelineComplete,
        processId: ctx.processId ?? null,
        situationSummary: ctx.situationSummary || null,
        forms,
        missingInformation,
        message,
      });
    }
  );
}
