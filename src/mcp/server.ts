import type { IncomingMessage } from "http";
import { Router, Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as z from "zod/v4";
import { summarizeProcesses } from "../lib/processes";
import { mcpOAuthProvider, publicBaseUrl } from "./oauthProvider";
import { mcpIcons } from "./shared";
import { registerBuildSituationContext } from "./tools/buildSituationContext";
import { registerGetSituationStatus } from "./tools/getSituationStatus";
import { registerGetFilledPdf } from "./tools/getFilledPdf";

/**
 * Remote MCP endpoint (Streamable HTTP, stateless). Tools are thin wrappers
 * over the existing services; they must not re-implement pipeline logic.
 *
 * Every request needs an access token from our OAuth server (oauthProvider.ts);
 * tools read the caller's Google userId from extra.authInfo.extra.userId.
 */

const SERVER_INFO = { name: "form-agent-pro", version: "1.1.0" };

/** First non-heading, non-empty line of a process README, used as a short description. */
function firstLine(readme: string | null): string | null {
  if (!readme) return null;
  const line = readme
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return line ?? null;
}

/**
 * Sent to the AI app in the MCP initialize response. Tells the model when this
 * server is relevant, in the words users actually use. Keep it factual: no
 * "always use this" steering, which directory reviewers treat as injection.
 */
const SERVER_INSTRUCTIONS =
  "Form Agent Pro prepares official, filled-in immigration application forms (PDFs) from a " +
  "person's description of their situation and their supporting documents.\n\n" +
  "It is relevant when a user wants to apply for or file US immigration paperwork, for example: " +
  "a green card through marriage to a US citizen or permanent resident (I-130, I-130A, I-864 " +
  "affidavit of support, and from inside the US I-485 with I-765 work permit, I-131 travel permit " +
  "and I-693 medical exam); an EB-1 employment-based green card for extraordinary ability, " +
  "outstanding researchers or multinational managers (I-140, I-907 premium processing, and I-485 " +
  "with Supplement J when filing from inside the US); or an O-1 extraordinary-ability work visa " +
  "(I-129 with the O and P supplement, and I-539 / I-539A for O-3 family members switching status " +
  "inside the US). Forms are prepared whether the person is in the US or abroad; State Department " +
  "online applications (DS-160, DS-260) are not filled. It also covers some non-US processes, such " +
  "as the Italian National (Type D) student visa.\n\n" +
  "How to use it: call list_supported_forms first (free) to confirm the user's goal is supported. " +
  "Preparing a case with build_situation_context costs a one-time payment, so explain that and get " +
  "the user's agreement before starting; it returns a payment link the user opens. Then use " +
  "get_situation_status (free) to follow progress and get_filled_pdf (free) for download links.\n\n" +
  "It fills in forms for the user to review, sign and file themselves. It is not legal advice and " +
  "does not submit anything to USCIS or any government.";

function buildServer(): McpServer {
  const server = new McpServer(
    { ...SERVER_INFO, title: "Form Agent Pro", websiteUrl: "https://formagent.pro", icons: mcpIcons(publicBaseUrl()) },
    { instructions: SERVER_INSTRUCTIONS }
  );

  server.registerTool(
    "list_supported_forms",
    {
      title: "Check which immigration applications can be prepared",
      description:
        "Use when a user asks about applying for a green card, work permit, travel permit, O-1 " +
        "extraordinary-ability status or another immigration application, to check whether Form Agent " +
        "Pro can prepare the forms for it. Returns each supported process, one per way of obtaining " +
        "status (for example 'marriage' = green card through marriage, 'eb1' = EB-1 employment-based " +
        "green card, 'o1' = O-1 extraordinary-ability work visa), with its form IDs (such as i-130, " +
        "i-485, i-140, i-129) and affidavit templates. Free and read-only; call " +
        "it before build_situation_context.",
      inputSchema: {},
      outputSchema: {
        processes: z.array(
          z.object({
            processId: z.string().describe("Process identifier, e.g. 'marriage' or 'o1'"),
            description: z.string().nullable().describe("One-line description of the process"),
            formIds: z.array(z.string()).describe("USCIS form IDs in this process, e.g. 'i-485'"),
            affidavitNames: z.array(z.string()).describe("Affidavit templates available for this process"),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      const processes = summarizeProcesses().map((p) => ({
        processId: p.processId,
        description: firstLine(p.readme),
        formIds: p.formIds,
        affidavitNames: p.affidavitNames,
      }));
      const structuredContent = { processes };
      return {
        structuredContent,
        content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
      };
    }
  );

  registerBuildSituationContext(server);
  registerGetSituationStatus(server);
  registerGetFilledPdf(server);

  return server;
}

const jsonRpcError = (code: number, message: string) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id: null,
});

/** URL of this MCP endpoint — the OAuth "resource" its tokens are issued for. */
export function mcpResourceUrl(): URL {
  return new URL("/mcp", publicBaseUrl());
}

/**
 * Requires a valid MCP access token (issued by our OAuth server) on /mcp.
 * On failure, returns 401 with a WWW-Authenticate header pointing at the
 * protected-resource metadata, which is how MCP clients discover sign-in.
 */
export async function requireMcpToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(mcpResourceUrl());
  const deny = (error: string, description: string) => {
    res.set(
      "WWW-Authenticate",
      `Bearer error="${error}", error_description="${description}", resource_metadata="${metadataUrl}"`
    );
    res.status(401).json({ error, error_description: description });
  };

  const header = req.headers.authorization ?? "";
  const [type, token] = header.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) {
    deny("invalid_token", "Missing bearer token");
    return;
  }

  try {
    const info = await mcpOAuthProvider.verifyAccessToken(token);
    if (info.resource && info.resource.href.replace(/\/$/, "") !== mcpResourceUrl().href.replace(/\/$/, "")) {
      deny("invalid_token", "Token was not issued for this server");
      return;
    }
    res.locals.mcpAuth = info;
    next();
  } catch {
    deny("invalid_token", "Invalid or expired access token");
  }
}

export const mcpRouter = Router();

// Stateless: a fresh server + transport per request, no session IDs.
mcpRouter.post("/", async (req: Request, res: Response) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    // The SDK reads the caller's AuthInfo from req.auth and passes it to tools
    // as extra.authInfo. Our Express typings use req.auth for the web app's
    // Google payload, so attach it on a plain IncomingMessage view instead.
    const mcpReq = req as unknown as IncomingMessage & { auth?: AuthInfo };
    mcpReq.auth = res.locals.mcpAuth as AuthInfo;
    await transport.handleRequest(mcpReq, res, req.body);
  } catch (err) {
    console.error("[mcp] Error handling request:", err);
    if (!res.headersSent) res.status(500).json(jsonRpcError(-32603, "Internal server error"));
  }
});

// No server-initiated streams or sessions in stateless mode.
mcpRouter.get("/", (_req: Request, res: Response) => {
  res.status(405).json(jsonRpcError(-32000, "Method not allowed."));
});
mcpRouter.delete("/", (_req: Request, res: Response) => {
  res.status(405).json(jsonRpcError(-32000, "Method not allowed."));
});
