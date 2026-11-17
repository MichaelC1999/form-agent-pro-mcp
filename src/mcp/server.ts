import type { IncomingMessage } from "http";
import { Router, Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import * as z from "zod/v4";
import { summarizeProcesses } from "../lib/processes";
import { mcpOAuthProvider, publicBaseUrl } from "./oauthProvider";
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

const SERVER_INFO = { name: "form-agent-pro", version: "0.1.0" };

/** First non-heading, non-empty line of a process README, used as a short description. */
function firstLine(readme: string | null): string | null {
  if (!readme) return null;
  const line = readme
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "" && !l.startsWith("#"));
  return line ?? null;
}

function buildServer(): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "list_supported_forms",
    {
      title: "List supported immigration processes and forms",
      description:
        "Lists the USCIS immigration processes this service can prepare, with the form IDs and " +
        "affidavit templates in each. Call this first to find the processId and formIds to use " +
        "with the other tools. Free; does not require payment.",
      inputSchema: {},
      outputSchema: {
        processes: z.array(
          z.object({
            processId: z.string().describe("Process identifier, e.g. 'aos' (adjustment of status)"),
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
