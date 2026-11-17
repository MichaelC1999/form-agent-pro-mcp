import { createHash, randomBytes } from "crypto";
import { isValidObjectId } from "mongoose";
import { Router, Request, Response } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { SituationalContext } from "../../models/SituationalContext";
import { FilledFormMap } from "../../models/FilledFormMap";
import { McpDownload } from "../../models/McpDownload";
import { logAppError } from "../../models/AppError";
import { resolveProcessId } from "../../lib/processes";
import { generatePdf, streamPdfAndCleanup, selectMapsForContext, buildMergedPdf } from "../../services/pdfDownloads";
import { publicBaseUrl } from "../oauthProvider";
import { mcpCaller } from "../shared";

const LINK_TTL_MS = 15 * 60_000;
export const DOWNLOAD_PATH_PREFIX = "/downloads";
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");

async function createLink(params: {
  kind: "form" | "merged";
  userId: string;
  situationalContextId: string;
  filledFormMapId?: string;
  expiresAt: Date;
}): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await McpDownload.create({ ...params, tokenHash: sha256(token) });
  return new URL(`${DOWNLOAD_PATH_PREFIX}/${token}`, publicBaseUrl()).toString();
}

const outputSchema = {
  situationalContextId: z.string(),
  found: z.boolean().describe("False if the situation doesn't exist for this account"),
  expiresAt: z.string().nullable().describe("ISO time after which the links stop working; call again for fresh ones"),
  mergedDownloadUrl: z.string().nullable().describe("One PDF with every ready form, in order"),
  forms: z.array(
    z.object({
      formId: z.string(),
      beneficiaryKey: z.string().nullable(),
      downloadUrl: z.string().describe("PDF of this one form"),
    })
  ),
  message: z.string(),
};
type Output = z.infer<z.ZodObject<typeof outputSchema>>;

function result(out: Output, isError = false): CallToolResult {
  return { structuredContent: out, content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError };
}

export function registerGetFilledPdf(server: McpServer): void {
  server.registerTool(
    "get_filled_pdf",
    {
      title: "Get download links for the filled immigration forms",
      description:
        "Free. Returns download links for the forms that are ready in a situation started with " +
        "build_situation_context: one link per form plus one merged PDF of all of them. Links are " +
        "private to this user and expire after 15 minutes; call again for fresh links. Give the links " +
        "to the user to open in a browser. Use get_situation_status first to see which forms are ready.",
      inputSchema: {
        situationalContextId: z.string().max(100).describe("The ID returned by build_situation_context"),
      },
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ situationalContextId }, extra) => {
      const empty = { situationalContextId, expiresAt: null, mergedDownloadUrl: null, forms: [] };
      const caller = mcpCaller(extra.authInfo);
      const ctx =
        caller && isValidObjectId(situationalContextId)
          ? await SituationalContext.findById(situationalContextId).lean()
          : null;
      // Another user's situation is reported as not found so IDs can't be probed.
      if (!caller || !ctx || ctx.userId !== caller.userId) {
        return result({ ...empty, found: false, message: "No situation with that ID was found for this account." }, true);
      }

      // Same rule as get_situation_status: only maps made for this situation.
      const maps = await selectMapsForContext(caller.userId, ctx.requiredForms, { onlyAfter: ctx.createdAt });
      if (maps.length === 0) {
        return result({
          ...empty,
          found: true,
          message: "No forms are ready yet. Check get_situation_status and try again once some are ready.",
        });
      }

      const expiresAt = new Date(Date.now() + LINK_TTL_MS);
      const base = { userId: caller.userId, situationalContextId, expiresAt };
      const forms = await Promise.all(
        maps.map(async (m) => ({
          formId: m.formId,
          beneficiaryKey: m.beneficiaryKey ?? null,
          downloadUrl: await createLink({ ...base, kind: "form", filledFormMapId: String(m._id) }),
        }))
      );
      const mergedDownloadUrl = await createLink({ ...base, kind: "merged" });

      return result({
        situationalContextId,
        found: true,
        expiresAt: expiresAt.toISOString(),
        mergedDownloadUrl,
        forms,
        message: `${forms.length} form(s) ready to download. Links expire in 15 minutes.`,
      });
    }
  );
}

// ─── Public download route for the links above ───────────────────────────────
// The unguessable token is the credential (no sign-in in a plain browser).
// Ownership is re-checked against the records on every download.

export const mcpDownloadRouter = Router();

// Mounted at DOWNLOAD_PATH_PREFIX in app.ts.
mcpDownloadRouter.get("/:token", async (req: Request, res: Response) => {
  const gone = () => res.status(404).type("text").send("This download link has expired. Ask your AI app for a new one.");
  try {
    const link = await McpDownload.findOne({ tokenHash: sha256(req.params.token) }).lean();
    if (!link || link.expiresAt.getTime() < Date.now()) return void gone();

    const ctx = await SituationalContext.findById(link.situationalContextId).lean();
    if (!ctx || ctx.userId !== link.userId) return void gone();

    if (link.kind === "form") {
      const map = await FilledFormMap.findById(link.filledFormMapId).lean();
      if (!map || map.userId !== link.userId) return void gone();
      const outputPath = await generatePdf(
        String(map._id),
        map.formId,
        link.userId,
        resolveProcessId(map.processId ?? ctx.processId)
      );
      const suffix = map.beneficiaryKey ? `-${map.beneficiaryKey.replace(/[^A-Za-z0-9_-]+/g, "_")}` : "";
      streamPdfAndCleanup(res, outputPath, `${map.formId}${suffix}.pdf`);
      return;
    }

    const maps = await selectMapsForContext(link.userId, ctx.requiredForms, { onlyAfter: ctx.createdAt });
    const mergedPath = await buildMergedPdf(maps, link.userId, ctx.processId, (formId, err) => {
      console.error(`[mcp-download] Skipping ${formId}:`, err);
      logAppError({
        err,
        service: "GET /downloads/:token (merged)",
        errorType: "pdf",
        formId,
        situationalContextId: link.situationalContextId,
        userId: link.userId,
      });
    });
    if (!mergedPath) {
      res.status(500).type("text").send("The forms couldn't be generated. Please try again shortly.");
      return;
    }
    streamPdfAndCleanup(res, mergedPath, "immigration-forms.pdf");
  } catch (err) {
    console.error("[mcp-download] Failed:", err);
    logAppError({ err, service: "GET /downloads/:token", errorType: "pdf" });
    if (!res.headersSent) res.status(500).type("text").send("Download failed. Please try again shortly.");
  }
});
