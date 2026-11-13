#!/usr/bin/env node
import { executeTool } from './runtime/http.js';
import { tools, toolsFile } from './runtime/registry.js';
import { ToolError, type ToolDef } from './runtime/types.js';

// Exit codes are part of the CLI contract (documented in README).
const EXIT = { ok: 0, input: 2, auth: 3, api: 4, network: 5 } as const;

const bin = toolsFile.package.cliName ?? toolsFile.package.name;
const kebab = (s: string) => s.replace(/_/g, '-');

function usage(): string {
  const rows = tools.map((t) => `  ${kebab(t.name).padEnd(32)} ${t.description.split('\n')[0]}`);
  return `Usage: ${bin} <command> [--param value ...] [--json]\n\nCommands:\n${rows.join('\n')}\n\nEnvironment: API_BASE_URL, API_TOKEN | API_KEY (+ API_KEY_HEADER), API_TIMEOUT_MS`;
}

function toolUsage(t: ToolDef): string {
  const opts = t.params.map((p) => `  --${p.name.padEnd(24)} ${p.type}${p.required ? ' (required)' : ''}  ${p.description}`);
  return `Usage: ${bin} ${kebab(t.name)} [options]\n\n${t.description}\n\nOptions:\n${opts.join('\n') || '  (none)'}\n  --json                     print raw JSON`;
}

function coerce(raw: string, type: string): unknown {
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new ToolError('input', `"${raw}" is not a number`);
    return n;
  }
  if (type === 'boolean') return raw === 'true' || raw === '';
  if (type === 'array' || type === 'object') {
    try { return JSON.parse(raw); } catch { throw new ToolError('input', `Expected JSON for ${type}: ${raw}`); }
  }
  return raw;
}

function parseArgs(t: ToolDef, argv: string[]): { args: Record<string, unknown>; json: boolean } {
  const args: Record<string, unknown> = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (!a.startsWith('--')) throw new ToolError('input', `Unexpected argument: ${a}`);
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    const p = t.params.find((x) => x.name === key);
    if (!p) throw new ToolError('input', `Unknown option --${key}`);
    const value = inline ?? (p.type === 'boolean' && (argv[i + 1] ?? '--').startsWith('--') ? 'true' : argv[++i]);
    if (value === undefined) throw new ToolError('input', `Missing value for --${key}`);
    args[p.name] = coerce(value, p.type);
  }
  return { args, json };
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') { console.log(usage()); return cmd ? EXIT.ok : EXIT.input; }
  const tool = tools.find((t) => kebab(t.name) === cmd || t.name === cmd);
  if (!tool) { console.error(`Unknown command: ${cmd}\n\n${usage()}`); return EXIT.input; }
  if (rest.includes('--help') || rest.includes('-h')) { console.log(toolUsage(tool)); return EXIT.ok; }
  try {
    const { args, json } = parseArgs(tool, rest);
    const result = await executeTool(tool, args);
    console.log(json || typeof result !== 'string' ? JSON.stringify(result, null, json ? 0 : 2) : result);
    return EXIT.ok;
  } catch (err) {
    const e = err instanceof ToolError ? err : new ToolError('server', (err as Error).message);
    console.error(`error [${e.category}]: ${e.message}`);
    if (e.category === 'input') return EXIT.input;
    if (e.category === 'auth') return EXIT.auth;
    if (e.category === 'network' || e.category === 'timeout') return EXIT.network;
    return EXIT.api;
  }
}

main().then((code) => process.exit(code));
