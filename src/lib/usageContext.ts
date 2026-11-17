import { AsyncLocalStorage } from "async_hooks";

/**
 * Which entry point a model call came from, carried implicitly through async
 * work (including background pipelines) so AnthropicLog can record it without
 * threading a parameter through every service.
 */
export interface UsageContext {
  /** "mcp" for MCP tool calls; anything else defaults to "web". */
  channel: "web" | "mcp";
  /** MCP tool that started the work, e.g. "build_situation_context". */
  mcpTool?: string;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Runs `fn` (and everything it starts) with the given usage context. */
export function runWithUsage<T>(ctx: UsageContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentUsage(): UsageContext {
  return storage.getStore() ?? { channel: "web" };
}
