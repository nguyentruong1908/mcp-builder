#!/usr/bin/env node
import { createServer, type IncomingMessage } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { executeTool } from './runtime/http.js';
import { findTool, tools, toolsFile } from './runtime/registry.js';
import { ToolError } from './runtime/types.js';

function buildServer(): Server {
  const server = new Server(
    { name: toolsFile.package.name, version: toolsFile.package.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.requireConfirm ? `${t.description}\n\nConfirm with the user before calling this tool.` : t.description,
      inputSchema: t.inputSchema as { type: 'object'; properties?: Record<string, object> },
      annotations: {
        readOnlyHint: t.impact === 'read',
        destructiveHint: t.impact === 'destructive',
        openWorldHint: true,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = findTool(req.params.name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }] };
    try {
      const result = await executeTool(tool, (req.params.arguments ?? {}) as Record<string, unknown>);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const e = err instanceof ToolError ? err : new ToolError('server', (err as Error).message);
      return { isError: true, content: [{ type: 'text', text: `[${e.category}] ${e.message}` }] };
    }
  });
  return server;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

async function main() {
  const i = process.argv.indexOf('--http');
  if (i === -1) {
    await buildServer().connect(new StdioServerTransport());
    return;
  }
  const port = Number(process.argv[i + 1] ?? process.env.PORT ?? 8080);
  const authToken = process.env.MCP_AUTH_TOKEN;
  createServer(async (req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}'); return; }
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (authToken && req.headers.authorization !== `Bearer ${authToken}`) { res.writeHead(401).end(); return; }
    try {
      // Stateless mode: a fresh server + transport per request.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
    }
  }).listen(port, () => console.error(`MCP HTTP server listening on :${port}/mcp`));
}

main().catch((err) => { console.error(err); process.exit(1); });
