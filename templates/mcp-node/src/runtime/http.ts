import { adapterFor } from './registry.js';
import { ToolError, type ToolDef } from './types.js';

export interface RuntimeConfig {
  baseUrl: string;
  token?: string;
  apiKey?: string;
  apiKeyHeader: string;
  timeoutMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    baseUrl: env.API_BASE_URL ?? '',
    token: env.API_TOKEN || undefined,
    apiKey: env.API_KEY || undefined,
    apiKeyHeader: env.API_KEY_HEADER || 'X-Api-Key',
    timeoutMs: Number(env.API_TIMEOUT_MS) || 15000,
  };
}

const TYPE_CHECK: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  integer: (v) => Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  array: Array.isArray,
  object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
};

/** Validates arguments against the tool's declared params. Throws ToolError('input'). */
export function validateArgs(tool: ToolDef, args: Record<string, unknown>): void {
  const known = new Set(tool.params.map((p) => p.name));
  for (const key of Object.keys(args)) {
    if (!known.has(key)) throw new ToolError('input', `Unknown argument "${key}" for ${tool.name}`);
  }
  for (const p of tool.params) {
    const v = args[p.name];
    if (v === undefined || v === null) {
      if (p.required) throw new ToolError('input', `Missing required argument "${p.name}"`);
      continue;
    }
    const check = TYPE_CHECK[p.type];
    if (check && !check(v)) throw new ToolError('input', `Argument "${p.name}" must be of type ${p.type}`);
  }
}

function categoryFor(status: number): ToolError['category'] {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'client';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Executes one tool call against the upstream API. Returns the (adapter-shaped) response body. */
export async function executeTool(tool: ToolDef, rawArgs: Record<string, unknown>, cfg = configFromEnv()): Promise<unknown> {
  if (!cfg.baseUrl) throw new ToolError('input', 'API_BASE_URL is not configured');
  const adapter = await adapterFor(tool.name);
  validateArgs(tool, rawArgs);
  const args = adapter?.prepare ? adapter.prepare({ ...rawArgs }) : rawArgs;

  let path = tool.path;
  const url = new URL(cfg.baseUrl.replace(/\/+$/, '') + '/');
  const headers: Record<string, string> = { accept: 'application/json' };
  const body: Record<string, unknown> = {};
  let hasBody = false;
  let wholeBody: unknown;

  for (const p of tool.params) {
    const v = args[p.name];
    if (v === undefined || v === null) continue;
    if (p.in === 'path') path = path.replace(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === 'query') (Array.isArray(v) ? v : [v]).forEach((x) => url.searchParams.append(p.name, String(x)));
    else if (p.in === 'header') headers[p.name] = String(v);
    else if (tool.bodyWhole) { wholeBody = v; hasBody = true; }
    else { body[p.name] = v; hasBody = true; }
  }
  url.pathname = url.pathname.replace(/\/$/, '') + path;
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (cfg.apiKey) headers[cfg.apiKeyHeader.toLowerCase()] = cfg.apiKey;
  if (hasBody) headers['content-type'] = 'application/json';

  // Only read tools are retried: retrying writes could duplicate side effects.
  const maxAttempts = tool.impact === 'read' ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: tool.method.toUpperCase(),
        headers,
        body: hasBody ? JSON.stringify(tool.bodyWhole ? wholeBody : body) : undefined,
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      const e = err as Error;
      if (e.name === 'TimeoutError') throw new ToolError('timeout', `Request timed out after ${cfg.timeoutMs}ms`);
      throw new ToolError('network', `Cannot reach API: ${e.message}`);
    }

    const text = await res.text();
    let data: unknown = text;
    if (text && (res.headers.get('content-type') ?? '').includes('json')) {
      try { data = JSON.parse(text); } catch { throw new ToolError('response', 'API returned invalid JSON', res.status); }
    }

    if (res.ok) return adapter?.transform ? adapter.transform(data, { status: res.status }) : data;

    const retryable = res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504;
    if (retryable && attempt < maxAttempts) {
      const after = Number(res.headers.get('retry-after'));
      await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 300 * attempt, 5000));
      continue;
    }
    const detail = typeof data === 'object' && data && 'message' in data ? String((data as { message: unknown }).message) : text.slice(0, 300);
    const err = new ToolError(categoryFor(res.status), `API responded ${res.status}${detail ? `: ${detail}` : ''}`, res.status, data);
    const custom = adapter?.describeError?.(err);
    throw custom ? new ToolError(err.category, custom, err.status, err.body) : err;
  }
}
