import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, categoryOf, connect, textOf, type CallResult } from './mcp-client.js';
import type { IntegrationVerdict, QaLayer, QaStatus } from '@mcp-factory/shared';
import { resolveSecret } from '../../core/util.js';
import { MockApi } from './mock-api.js';
import { minimalEnv, run, tail } from './proc.js';
import { sampleArgs } from './samples.js';
import { runAgentEval } from './agent-eval.js';
import { parseResult, PlaceholderError, resolveArgs } from './steps.js';
import { BuildAbort, type BuildCtx, type CustomToolCase, type QaRow, type ToolSnapshot } from './types.js';

const QA_TOKEN = 'qa-token';
const kebab = (s: string) => s.replace(/_/g, '-');

function expectedPath(t: ToolSnapshot, args: Record<string, unknown>) {
  return t.params.filter((p) => p.in === 'path').reduce((p, x) => p.replace(`{${x.name}}`, encodeURIComponent(String(args[x.name]))), t.path);
}

/** Runs one user-defined tool_call test case and checks its expectations. */
type Expect = CustomToolCase['expect'];
function checkExpect(r: CallResult, expect: Expect): string[] {
  const text = textOf(r);
  const wantError = expect.isError ?? false;
  return [
    !!r.isError !== wantError && (wantError ? 'Expected the tool to fail but it succeeded' : `Expected success but the tool failed: ${text.slice(0, 160)}`),
    expect.category && categoryOf(r) !== expect.category && `Error category [${categoryOf(r) ?? 'none'}] ≠ [${expect.category}]`,
    ...(expect.contains ?? []).filter((s) => !text.includes(s)).map((s) => `Result does not contain "${s}"`),
  ].filter(Boolean) as string[];
}

type StepResult = { index: number; tool: string; cleanup: boolean; status: 'pass' | 'fail' | 'skipped'; args: unknown; result: string; detail: string };

/**
 * Runs a multi-step case: main steps in order (stop at the first failure), then cleanup steps, which always run.
 * Returns the QA row plus a per-tool verdict used to credit write tools in the integration layer.
 */
async function runStepsCase(client: Client, c: CustomToolCase, mock?: MockApi): Promise<{ row: QaRow; perTool: Map<string, 'pass' | 'fail'> }> {
  const steps = c.steps ?? [];
  const results: unknown[] = new Array(steps.length).fill(undefined);
  const out: StepResult[] = [];
  const perTool = new Map<string, 'pass' | 'fail'>();
  const order = [...steps.keys()].filter((i) => !steps[i].cleanup).concat([...steps.keys()].filter((i) => steps[i].cleanup));
  let mainFailed = false;
  for (const i of order) {
    const s = steps[i];
    const base = { index: i + 1, tool: s.tool, cleanup: s.cleanup };
    if (mainFailed && !s.cleanup) { out.push({ ...base, status: 'skipped', args: s.args, result: '', detail: 'Skipped because an earlier step failed' }); continue; }
    let args: Record<string, unknown>;
    try {
      args = resolveArgs(s.args, results) as Record<string, unknown>;
    } catch (err) {
      if (!(err instanceof PlaceholderError)) throw err;
      // A cleanup with nothing to clean (its data was never created) is not a failure.
      if (s.cleanup && mainFailed) { out.push({ ...base, status: 'skipped', args: s.args, result: '', detail: `Nothing to clean up: ${err.message}` }); continue; }
      out.push({ ...base, status: 'fail', args: s.args, result: '', detail: err.message });
      if (!s.cleanup) mainFailed = true;
      continue;
    }
    if (mock) mock.next();
    let r: CallResult;
    try {
      r = await call(client, s.tool, args, 30_000);
    } catch (err) {
      r = { isError: true, content: [{ type: 'text', text: `[network] ${(err as Error).message}` }] };
    }
    const text = textOf(r);
    results[i] = r.isError ? text : parseResult(text);
    const problems = checkExpect(r, s.expect ?? {});
    const status = problems.length ? 'fail' : 'pass';
    out.push({ ...base, status, args, result: text.slice(0, 1500), detail: problems.join('; ') });
    perTool.set(s.tool, perTool.get(s.tool) === 'fail' || status === 'fail' ? 'fail' : 'pass');
    if (status === 'fail' && !s.cleanup) mainFailed = true;
  }
  const failed = out.filter((x) => x.status === 'fail');
  const firstFail = failed[0];
  const cleanupFail = failed.find((x) => x.cleanup);
  const detail = !failed.length
    ? `${out.filter((x) => x.status === 'pass').length}/${steps.length} steps passed${steps.some((x) => x.cleanup) ? ' (data cleaned up)' : ''}`
    : `Step ${firstFail.index} (${firstFail.tool}${firstFail.cleanup ? ', cleanup' : ''}): ${firstFail.detail}${cleanupFail && cleanupFail !== firstFail ? `; cleanup failed at step ${cleanupFail.index}` : ''}`;
  return { row: { layer: 'custom', tool: null, name: c.name, status: failed.length ? 'fail' : 'pass', detail, evidence: { kind: 'tool_steps', target: c.target, steps: out } }, perTool };
}

async function runToolCase(client: Client, c: CustomToolCase, mock?: MockApi): Promise<QaRow> {
  const row = (status: QaRow['status'], detail: string, evidence?: unknown): QaRow => ({ layer: 'custom', tool: c.tool, name: c.name, status, detail, evidence });
  if (mock) mock.next(...(c.mockResponse ? [{ status: c.mockResponse.status, body: c.mockResponse.body }] : []));
  let r: CallResult;
  try {
    r = await call(client, c.tool, c.args, 30_000);
  } catch (err) {
    return row('fail', `Tool call failed: ${(err as Error).message}`, { args: c.args, target: c.target });
  }
  const text = textOf(r);
  const problems = checkExpect(r, c.expect);
  const evidence = { args: c.args, target: c.target, mockResponse: c.mockResponse, expect: c.expect, result: text.slice(0, 1500), isError: !!r.isError, request: mock?.requests[0] ? { method: mock.requests[0].method, path: mock.requests[0].path, query: mock.requests[0].query, body: mock.requests[0].body } : undefined };
  return problems.length ? row('fail', problems.join('; '), evidence) : row('pass', text.slice(0, 200), evidence);
}

export async function runQa(ctx: BuildCtx): Promise<QaRow[]> {
  const rows: QaRow[] = [];
  const add = (layer: QaLayer, tool: string | null, name: string, status: QaStatus, detail = '', evidence?: unknown) => rows.push({ layer, tool, name, status, detail, evidence });
  const tools = ctx.tools;

  // ---- input: definitions are well formed
  for (const t of tools) {
    const s = t.inputSchema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
    const problems = [
      !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && 'invalid tool name',
      s.type !== 'object' && 'inputSchema is not an object',
      (s.required ?? []).some((r) => !s.properties?.[r]) && 'required references a missing property',
      t.params.some((p) => p.in === 'path' && !t.path.includes(`{${p.name}}`)) && 'path parameter does not match the path',
    ].filter(Boolean);
    add('input', t.name, 'Tool definition', problems.length ? 'fail' : 'pass', problems.join('; '));
  }

  // ---- build: results from the build stage
  add('build', null, 'TypeScript build', ctx.checks.tsc ? 'pass' : 'fail', ctx.checks.tscDetail ?? '');
  add('build', null, 'Secret scan', ctx.checks.secretScan ? 'pass' : 'fail', ctx.checks.secretDetail ?? '');

  const mcpEntry = join(ctx.ws, 'dist/mcp.js');
  const cliEntry = join(ctx.ws, 'dist/cli.js');
  const mock = new MockApi(tools);
  await mock.start();
  let client: Client | undefined;
  try {
    try {
      client = await connect(mcpEntry, { API_BASE_URL: mock.url, API_TOKEN: QA_TOKEN, API_TIMEOUT_MS: '2000' }, ctx.ws);
    } catch (err) {
      const msg = `MCP server failed to start: ${(err as Error).message}`;
      for (const t of tools) for (const layer of ['interface', 'contract', 'error', 'runtime'] as QaLayer[]) add(layer, t.name, 'MCP server', layer === 'interface' ? 'fail' : 'blocked', msg);
    }

    if (client) {
      // ---- interface: discovery matches the definitions
      const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
      for (const t of tools) {
        const l = listed.get(t.name);
        if (!l) { add('interface', t.name, 'tools/list', 'fail', 'Tool missing from tools/list'); continue; }
        const want = Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort();
        const got = Object.keys(l.inputSchema.properties ?? {}).sort();
        const problems = [
          !isDeepStrictEqual(want, got) && `properties ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`,
          (l.annotations?.readOnlyHint ?? false) !== (t.impact === 'read') && 'readOnlyHint does not match the impact level',
          !l.description && 'missing description',
        ].filter(Boolean);
        add('interface', t.name, 'tools/list', problems.length ? 'fail' : 'pass', problems.join('; '));
      }
      const extra = [...listed.keys()].filter((n) => !tools.some((t) => t.name === n));
      if (extra.length) add('interface', null, 'tools/list', 'fail', `Out-of-scope tools: ${extra.join(', ')}`);

      // ---- contract: request mapping against the Factory mock
      for (const t of tools) {
        const args = sampleArgs(t.inputSchema);
        mock.next();
        try {
          const r = await call(client, t.name, args);
          const req = mock.requests[0];
          const problems: string[] = [];
          if (r.isError) problems.push(`tool returned an error: ${textOf(r).slice(0, 200)}`);
          if (!req) problems.push('no request reached the API');
          else {
            if (req.method !== t.method) problems.push(`method ${req.method} ≠ ${t.method}`);
            const path = expectedPath(t, args);
            if (req.path !== path) problems.push(`path ${req.path} ≠ ${path}`);
            for (const p of t.params.filter((x) => x.in === 'query' && args[x.name] !== undefined)) {
              const want = Array.isArray(args[p.name]) ? (args[p.name] as unknown[]).map(String) : String(args[p.name]);
              const got = req.query[p.name];
              if (!isDeepStrictEqual(Array.isArray(want) && want.length === 1 ? want[0] : want, got)) problems.push(`query ${p.name}=${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
            }
            const bodyParams = t.params.filter((x) => x.in === 'body');
            if (t.bodyWhole) {
              if (args.body !== undefined && !isDeepStrictEqual(req.body, args.body)) problems.push('body mismatch');
            } else if (bodyParams.length) {
              const want = Object.fromEntries(bodyParams.filter((p) => args[p.name] !== undefined).map((p) => [p.name, args[p.name]]));
              if (Object.keys(want).length && !isDeepStrictEqual(req.body, want)) problems.push(`body ${JSON.stringify(req.body)} ≠ ${JSON.stringify(want)}`);
            }
            if (req.headers.authorization !== `Bearer ${QA_TOKEN}`) problems.push('missing Authorization header');
          }
          add('contract', t.name, `${t.method} ${t.path}`, problems.length ? 'fail' : 'pass', problems.join('; '), { args, request: req ? { method: req.method, path: req.path, query: req.query, body: req.body } : null });
        } catch (err) {
          add('contract', t.name, `${t.method} ${t.path}`, 'fail', `Tool call failed: ${(err as Error).message}`, { args });
        }
      }

      // ---- error handling: upstream failures become isError results, server keeps running
      const cases: [number, string][] = [[401, 'auth'], [404, 'not_found'], [500, 'server']];
      for (const t of tools) {
        const args = sampleArgs(t.inputSchema);
        for (const [status, cat] of cases) {
          mock.next({ status, body: { message: `qa simulated ${status}` } });
          try {
            const r = await call(client, t.name, args);
            const ok = r.isError === true && categoryOf(r) === cat && textOf(r).length > 0;
            add('error', t.name, `HTTP ${status}`, ok ? 'pass' : 'fail', ok ? textOf(r).slice(0, 200) : `Expected isError with [${cat}], got: ${JSON.stringify(r).slice(0, 200)}`);
          } catch (err) {
            add('error', t.name, `HTTP ${status}`, 'fail', `MCP error: ${(err as Error).message}`);
          }
        }
        mock.next({ status: 200, raw: '{"truncated": ', headers: { 'content-type': 'application/json' } });
        try {
          const r = await call(client, t.name, args);
          add('error', t.name, 'Malformed response', r.isError && categoryOf(r) === 'response' ? 'pass' : 'fail', textOf(r).slice(0, 200));
        } catch (err) {
          add('error', t.name, 'Malformed response', 'fail', (err as Error).message);
        }
      }

      // ---- runtime: retries are only applied to read tools
      for (const t of tools) {
        const args = sampleArgs(t.inputSchema);
        mock.next({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } });
        try {
          const r = await call(client, t.name, args);
          if (t.impact === 'read') add('runtime', t.name, 'Retry on 429', !r.isError && mock.requests.length === 2 ? 'pass' : 'fail', `${mock.requests.length} request, isError=${!!r.isError}`);
          else add('runtime', t.name, 'No retry for writes', r.isError && mock.requests.length === 1 ? 'pass' : 'fail', `${mock.requests.length} request, isError=${!!r.isError}`);
        } catch (err) {
          add('runtime', t.name, 'Retry', 'fail', (err as Error).message);
        }
      }
      const readTool = tools.find((t) => t.impact === 'read');
      if (readTool) {
        mock.next({ status: 200, body: {}, delayMs: 4000 });
        const r = await call(client, readTool.name, sampleArgs(readTool.inputSchema), 30_000).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: e.message }] }));
        add('runtime', null, 'Timeout', r.isError && categoryOf(r) === 'timeout' ? 'pass' : 'fail', textOf(r).slice(0, 200));
      }
      add('runtime', null, 'Pagination', 'not_run', 'Not covered in the MVP (no action needed). You can check it with a tool call test case using cursor/limit.');
      add('runtime', null, 'Idempotency', 'not_run', 'Not covered in the MVP (no action needed): the runtime never retries writes, so it does not send duplicates.');
    }

    // ---- custom test cases on the Factory mock
    const known = new Set(tools.map((t) => t.name));
    for (const c of ctx.toolCases.filter((x) => x.target === 'mock')) {
      const caseTools = c.steps ? c.steps.map((s) => s.tool) : [c.tool];
      const unknown = caseTools.filter((t) => !known.has(t));
      const rowTool = c.steps ? null : c.tool;
      if (unknown.length) add('custom', rowTool, c.name, 'blocked', `Tools not in this build: ${[...new Set(unknown)].join(', ')}`);
      else if (!client) add('custom', rowTool, c.name, 'blocked', 'MCP server failed to start');
      else if (c.steps) rows.push((await runStepsCase(client, c, mock)).row);
      else rows.push(await runToolCase(client, c, mock));
    }

    // ---- CLI interface
    if (ctx.project.outputs.cli) {
      const env = minimalEnv({ API_BASE_URL: mock.url, API_TOKEN: QA_TOKEN });
      const help = await run(process.execPath, [cliEntry, '--help'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
      add('interface', null, 'CLI --help', help.code === 0 && help.stdout.includes('Commands') ? 'pass' : 'fail', tail(help.stdout + help.stderr, 300));
      const bad = await run(process.execPath, [cliEntry, 'no-such-command'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
      add('interface', null, 'CLI unknown command → exit 2', bad.code === 2 ? 'pass' : 'fail', `exit ${bad.code}`);
      for (const t of tools) {
        const h = await run(process.execPath, [cliEntry, kebab(t.name), '--help'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
        add('interface', t.name, 'CLI --help', h.code === 0 ? 'pass' : 'fail', `exit ${h.code}`);
      }
      const t = tools.find((x) => x.impact === 'read' && x.params.every((p) => !['array', 'object'].includes(p.type)));
      if (t) {
        mock.next();
        const args = sampleArgs(t.inputSchema);
        const argv = Object.entries(args).flatMap(([k, v]) => [`--${k}`, String(v)]);
        const r = await run(process.execPath, [cliEntry, kebab(t.name), ...argv, '--json'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
        let json = false;
        try { JSON.parse(r.stdout); json = true; } catch { /* not json */ }
        add('interface', t.name, 'CLI --json', r.code === 0 && json ? 'pass' : 'fail', `exit ${r.code}${json ? '' : ', stdout is not JSON'}`);
      }
    }
  } finally {
    await client?.close().catch(() => undefined);
    await mock.close();
  }

  // ---- integration: real API through the QA connection
  const conn = ctx.qaConnection;
  const integrationSkip = !ctx.runIntegration ? 'Integration tests were turned off for this run'
    : !conn ? 'No environment is marked "Use for QA"' : null;
  const secret = conn ? resolveSecret(conn.secretRef) : undefined;
  const liveCases = ctx.toolCases.filter((x) => x.target === 'live');
  if (integrationSkip) {
    for (const t of tools) add('integration', t.name, 'Live API', 'not_run', integrationSkip);
    for (const c of liveCases) add('custom', c.tool, c.name, 'not_run', integrationSkip);
  } else if (conn!.authType !== 'none' && !secret) {
    const why = `Secret ${conn!.secretRef} is not configured on the QA server`;
    for (const t of tools) add('integration', t.name, 'Live API', 'blocked', why);
    for (const c of liveCases) add('custom', c.tool, c.name, 'blocked', why);
  }
  else {
    const env: Record<string, string> = { API_BASE_URL: conn!.baseUrl, API_TIMEOUT_MS: '10000' };
    if (conn!.authType === 'bearer') env.API_TOKEN = secret!;
    if (conn!.authType === 'api_key') { env.API_KEY = secret!; env.API_KEY_HEADER = conn!.authHeader; }
    let live: Client | undefined;
    try {
      live = await connect(mcpEntry, env, ctx.ws);
      // tool → verdict from user-written live tests (single calls and every executed step of multi-step cases)
      const liveVerdict = new Map<string, { status: 'pass' | 'fail'; name: string; detail: string }>();
      const credit = (tool: string, status: 'pass' | 'fail', name: string, detail: string) => {
        if (liveVerdict.get(tool)?.status !== 'fail') liveVerdict.set(tool, { status, name, detail });
      };
      for (const c of liveCases) {
        const caseTools = c.steps ? c.steps.map((s) => s.tool) : [c.tool];
        const defs = caseTools.map((n) => tools.find((x) => x.name === n));
        const rowTool = c.steps ? null : c.tool;
        if (defs.some((d) => !d)) add('custom', rowTool, c.name, 'blocked', `Tools not in this build: ${caseTools.filter((_, k) => !defs[k]).join(', ')}`);
        // A user-written live test on a write tool is explicit intent, but the environment must still allow writes.
        else if (defs.some((d) => d!.impact !== 'read') && !conn!.allowWrite) add('custom', rowTool, c.name, 'blocked', `Environment ${conn!.name} does not allow writes. Enable "Allow writes" in Connections.`);
        else if (c.steps) {
          const { row, perTool } = await runStepsCase(live, c);
          rows.push(row);
          for (const [tool, st] of perTool) credit(tool, st, c.name, row.detail);
        } else {
          const row = await runToolCase(live, c);
          rows.push(row);
          credit(c.tool, row.status === 'pass' ? 'pass' : 'fail', c.name, row.detail);
        }
      }
      for (const t of tools) {
        if (t.impact !== 'read') {
          // Never call write tools with guessed data on a real system: they count via user-written live test cases.
          const v = liveVerdict.get(t.name);
          if (v?.status === 'fail') add('integration', t.name, 'Live API', 'fail', `Live test case "${v.name}" failed: ${v.detail.slice(0, 200)}`);
          else if (v?.status === 'pass') add('integration', t.name, 'Live API', 'pass', `Verified by live test case "${v.name}"`);
          else add('integration', t.name, 'Live API', 'blocked', conn!.allowWrite
            ? 'Write tools are never called with generated data. Add a tool call test case (target: live API) with safe data to verify it.'
            : `Environment ${conn!.name} does not allow writes. Enable "Allow writes" in Connections and add a live test case to verify it.`);
          continue;
        }
        const args = sampleArgs(t.inputSchema);
        const r = await call(live, t.name, args, 30_000).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: `[network] ${e.message}` }] }) as CallResult);
        const cat = categoryOf(r);
        if (!r.isError) add('integration', t.name, 'Live API', 'pass', `OK with sample arguments ${JSON.stringify(args)}`, { args, sample: textOf(r).slice(0, 400) });
        else if (cat === 'not_found' || cat === 'client' || cat === 'conflict') add('integration', t.name, 'Live API', 'pass', `Connection and auth OK; the API returned a business error for the sample arguments: ${textOf(r).slice(0, 160)}`, { args });
        else add('integration', t.name, 'Live API', 'fail', textOf(r).slice(0, 300), { args });
      }
    } catch (err) {
      for (const t of tools) add('integration', t.name, 'Live API', 'fail', `Cannot start the MCP server: ${(err as Error).message}`);
      for (const c of liveCases) add('custom', c.tool, c.name, 'blocked', 'MCP server failed to start against the live environment');
    } finally {
      await live?.close().catch(() => undefined);
    }
  }

  // ---- agent evaluation: a Codex agent uses the generated MCP tools on the sample tasks
  if (!ctx.runAgentEval) for (const t of tools) add('agent', t.name, 'Agent task evaluation', 'not_run', 'Agent eval was turned off for this run');
  else {
    try {
      rows.push(...await runAgentEval(ctx, ctx.sampleTasks));
    } catch (err) {
      if (err instanceof BuildAbort || ctx.signal.aborted) throw err;
      for (const t of tools) add('agent', t.name, 'Agent task evaluation', 'fail', `Agent eval error: ${(err as Error).message}`);
    }
  }

  // ---- install: pack and install into a clean directory
  const tmp = await mkdtemp(join(tmpdir(), 'mcpf-install-'));
  try {
    for (const f of await readdir(ctx.outDir)) if (f.endsWith('.tgz')) await rm(join(ctx.outDir, f), { force: true }); // previous QA pass
    const pack = await run('npm', ['pack', '--pack-destination', ctx.outDir, '--silent'], { cwd: ctx.ws, timeoutMs: 120_000, signal: ctx.signal });
    const tgzName = (await readdir(ctx.outDir)).find((f) => f.endsWith('.tgz'));
    if (pack.code !== 0 || !tgzName) { add('install', null, 'npm pack', 'fail', tail(pack.stderr || pack.stdout, 500)); return rows; }
    ctx.tgzPath = join(ctx.outDir, tgzName);
    add('install', null, 'npm pack', 'pass', tgzName);
    await run('npm', ['init', '-y'], { cwd: tmp, timeoutMs: 30_000 });
    const inst = await run('npm', ['install', ctx.tgzPath, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: tmp, timeoutMs: 300_000, signal: ctx.signal });
    if (inst.code !== 0) { add('install', null, 'npm install (clean environment)', 'fail', tail(inst.stderr, 500)); return rows; }
    add('install', null, 'npm install (clean environment)', 'pass');
    if (ctx.project.outputs.cli) {
      const bin = join(tmp, 'node_modules/.bin', ctx.cliBin);
      const r = existsSync(bin) ? await run(bin, ['--help'], { cwd: tmp, timeoutMs: 15_000 }) : null;
      add('install', null, `${ctx.cliBin} --help`, r?.code === 0 ? 'pass' : 'fail', r ? `exit ${r.code}` : 'Binary not found');
    }
    if (ctx.project.outputs.mcp) {
      try {
        const c = await connect(join(tmp, 'node_modules', ctx.packageName, 'dist/mcp.js'), { API_BASE_URL: 'http://127.0.0.1:9' }, tmp);
        const n = (await c.listTools()).tools.length;
        await c.close();
        add('install', null, `${ctx.mcpBin} tools/list`, n === tools.length ? 'pass' : 'fail', `${n}/${tools.length} tool`);
      } catch (err) {
        add('install', null, `${ctx.mcpBin} tools/list`, 'fail', (err as Error).message);
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
  return rows;
}

const REQUIRED: QaLayer[] = ['input', 'build', 'interface', 'contract', 'error', 'install'];

export function verdicts(rows: QaRow[], tools: ToolSnapshot[]): { packageVerified: boolean; integration: IntegrationVerdict; failures: number } {
  const required = rows.filter((r) => REQUIRED.includes(r.layer));
  const covered = (layer: QaLayer) => tools.every((t) => rows.some((r) => r.layer === layer && r.tool === t.name));
  const packageVerified = required.length > 0 && required.every((r) => r.status === 'pass')
    && !rows.some((r) => (r.layer === 'runtime' || r.layer === 'custom') && r.status === 'fail')
    && covered('interface') && covered('contract') && covered('error')
    && rows.some((r) => r.layer === 'install' && r.name === 'npm pack' && r.status === 'pass');
  const integ = rows.filter((r) => r.layer === 'integration');
  const integration: IntegrationVerdict = integ.some((r) => r.status === 'fail') ? 'no'
    : integ.length && integ.every((r) => r.status === 'pass') ? 'yes'
      : integ.some((r) => r.status === 'pass') ? 'partial' : 'not_run';
  return { packageVerified, integration, failures: rows.filter((r) => r.status === 'fail').length };
}
