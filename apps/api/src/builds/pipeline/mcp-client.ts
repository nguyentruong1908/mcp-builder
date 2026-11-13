import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { minimalEnv } from './proc.js';

/** Factory-side MCP client for the generated server (QA checks and data cleanup; never the agent under test). */
export type CallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
export const textOf = (r: CallResult) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
export const categoryOf = (r: CallResult) => /^\[([a-z_]+)\]/.exec(textOf(r))?.[1];

export async function connect(entry: string, env: Record<string, string>, cwd: string): Promise<Client> {
  const client = new Client({ name: 'mcp-factory-qa', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: minimalEnv(env), cwd, stderr: 'pipe' }));
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallResult;
}
