export type Impact = 'read' | 'write' | 'side_effect' | 'destructive';

export interface ToolParam {
  name: string;
  in: 'path' | 'query' | 'header' | 'body';
  type: string;
  required: boolean;
  description: string;
}

/** One entry of factory/tools.json. Written by MCP Factory, never by Codex. */
export interface ToolDef {
  name: string;
  description: string;
  method: string;
  path: string;
  impact: Impact;
  requireConfirm: boolean;
  params: ToolParam[];
  inputSchema: Record<string, unknown>;
  /** true when the request body is not an object: the whole body is passed as the `body` argument. */
  bodyWhole?: boolean;
}

export interface ToolsFile {
  package: { name: string; version: string; description?: string; cliName?: string };
  tools: ToolDef[];
}

export type ErrorCategory = 'input' | 'auth' | 'not_found' | 'conflict' | 'rate_limited' | 'client' | 'server' | 'timeout' | 'network' | 'response';

export class ToolError extends Error {
  constructor(
    public readonly category: ErrorCategory,
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
  ) {
    super(message);
  }
}

/**
 * Per-tool customisation written by Codex in src/adapters/<tool_name>.ts (default export).
 * Every hook is optional; without an adapter the generic executor is used.
 */
export interface ToolAdapter {
  /** Transform validated arguments before the HTTP request is built. Must not add params the tool does not declare. */
  prepare?(args: Record<string, unknown>): Record<string, unknown>;
  /** Shape the parsed 2xx response body for the agent (e.g. keep relevant fields). */
  transform?(data: unknown, ctx: { status: number }): unknown;
  /** Turn an API error into a short, domain-specific message for the agent. Return undefined to keep the default. */
  describeError?(err: ToolError): string | undefined;
}
