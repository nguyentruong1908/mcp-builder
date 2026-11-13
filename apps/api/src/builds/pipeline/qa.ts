import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { IntegrationVerdict, QaLayer, QaStatus } from '@mcp-factory/shared';
import { resolveSecret } from '../../core/util.js';
import { MockApi } from './mock-api.js';
import { minimalEnv, run, tail } from './proc.js';
import { sampleArgs } from './samples.js';
import { runAgentEval } from './agent-eval.js';
import { BuildAbort, type BuildCtx, type CustomToolCase, type QaRow, type ToolSnapshot } from './types.js';

const QA_TOKEN = 'qa-token';
type CallResult = { isError?: boolean; content?: { type: string; text?: string }[] };
const textOf = (r: CallResult) => (r.content ?? []).map((c) => c.text ?? '').join('\n');
const categoryOf = (r: CallResult) => /^\[([a-z_]+)\]/.exec(textOf(r))?.[1];
const kebab = (s: string) => s.replace(/_/g, '-');

async function connect(entry: string, env: Record<string, string>, cwd: string): Promise<Client> {
  const client = new Client({ name: 'mcp-factory-qa', version: '0.1.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], env: minimalEnv(env), cwd, stderr: 'pipe' }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs })) as CallResult;
}

function expectedPath(t: ToolSnapshot, args: Record<string, unknown>) {
  return t.params.filter((p) => p.in === 'path').reduce((p, x) => p.replace(`{${x.name}}`, encodeURIComponent(String(args[x.name]))), t.path);
}

/** Runs one user-defined tool_call test case and checks its expectations. */
async function runToolCase(client: Client, c: CustomToolCase, mock?: MockApi): Promise<QaRow> {
  const row = (status: QaRow['status'], detail: string, evidence?: unknown): QaRow => ({ layer: 'custom', tool: c.tool, name: c.name, status, detail, evidence });
  if (mock) mock.next(...(c.mockResponse ? [{ status: c.mockResponse.status, body: c.mockResponse.body }] : []));
  let r: CallResult;
  try {
    r = await call(client, c.tool, c.args, 30_000);
  } catch (err) {
    return row('fail', `Gọi tool lỗi: ${(err as Error).message}`, { args: c.args, target: c.target });
  }
  const text = textOf(r);
  const wantError = c.expect.isError ?? false;
  const problems = [
    !!r.isError !== wantError && (wantError ? 'Kỳ vọng tool trả lỗi nhưng thành công' : `Kỳ vọng thành công nhưng tool trả lỗi: ${text.slice(0, 160)}`),
    c.expect.category && categoryOf(r) !== c.expect.category && `Loại lỗi [${categoryOf(r) ?? 'none'}] ≠ [${c.expect.category}]`,
    ...(c.expect.contains ?? []).filter((s) => !text.includes(s)).map((s) => `Kết quả không chứa "${s}"`),
  ].filter(Boolean) as string[];
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
      !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) && 'tên tool không hợp lệ',
      s.type !== 'object' && 'inputSchema không phải object',
      (s.required ?? []).some((r) => !s.properties?.[r]) && 'required tham chiếu property không tồn tại',
      t.params.some((p) => p.in === 'path' && !t.path.includes(`{${p.name}}`)) && 'tham số path không khớp đường dẫn',
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
      const msg = `MCP server không khởi động: ${(err as Error).message}`;
      for (const t of tools) for (const layer of ['interface', 'contract', 'error', 'runtime'] as QaLayer[]) add(layer, t.name, 'MCP server', layer === 'interface' ? 'fail' : 'blocked', msg);
    }

    if (client) {
      // ---- interface: discovery matches the definitions
      const listed = new Map((await client.listTools()).tools.map((t) => [t.name, t]));
      for (const t of tools) {
        const l = listed.get(t.name);
        if (!l) { add('interface', t.name, 'tools/list', 'fail', 'Tool không xuất hiện trong tools/list'); continue; }
        const want = Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).sort();
        const got = Object.keys(l.inputSchema.properties ?? {}).sort();
        const problems = [
          !isDeepStrictEqual(want, got) && `properties ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`,
          (l.annotations?.readOnlyHint ?? false) !== (t.impact === 'read') && 'readOnlyHint không khớp mức tác động',
          !l.description && 'thiếu description',
        ].filter(Boolean);
        add('interface', t.name, 'tools/list', problems.length ? 'fail' : 'pass', problems.join('; '));
      }
      const extra = [...listed.keys()].filter((n) => !tools.some((t) => t.name === n));
      if (extra.length) add('interface', null, 'tools/list', 'fail', `Tool ngoài phạm vi: ${extra.join(', ')}`);

      // ---- contract: request mapping against the Factory mock
      for (const t of tools) {
        const args = sampleArgs(t.inputSchema);
        mock.next();
        try {
          const r = await call(client, t.name, args);
          const req = mock.requests[0];
          const problems: string[] = [];
          if (r.isError) problems.push(`tool trả lỗi: ${textOf(r).slice(0, 200)}`);
          if (!req) problems.push('không có request nào tới API');
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
              if (args.body !== undefined && !isDeepStrictEqual(req.body, args.body)) problems.push('body không khớp');
            } else if (bodyParams.length) {
              const want = Object.fromEntries(bodyParams.filter((p) => args[p.name] !== undefined).map((p) => [p.name, args[p.name]]));
              if (Object.keys(want).length && !isDeepStrictEqual(req.body, want)) problems.push(`body ${JSON.stringify(req.body)} ≠ ${JSON.stringify(want)}`);
            }
            if (req.headers.authorization !== `Bearer ${QA_TOKEN}`) problems.push('thiếu header Authorization');
          }
          add('contract', t.name, `${t.method} ${t.path}`, problems.length ? 'fail' : 'pass', problems.join('; '), { args, request: req ? { method: req.method, path: req.path, query: req.query, body: req.body } : null });
        } catch (err) {
          add('contract', t.name, `${t.method} ${t.path}`, 'fail', `Gọi tool lỗi: ${(err as Error).message}`, { args });
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
            add('error', t.name, `HTTP ${status}`, ok ? 'pass' : 'fail', ok ? textOf(r).slice(0, 200) : `Kỳ vọng isError với [${cat}], nhận: ${JSON.stringify(r).slice(0, 200)}`);
          } catch (err) {
            add('error', t.name, `HTTP ${status}`, 'fail', `MCP lỗi: ${(err as Error).message}`);
          }
        }
        mock.next({ status: 200, raw: '{"truncated": ', headers: { 'content-type': 'application/json' } });
        try {
          const r = await call(client, t.name, args);
          add('error', t.name, 'Response sai định dạng', r.isError && categoryOf(r) === 'response' ? 'pass' : 'fail', textOf(r).slice(0, 200));
        } catch (err) {
          add('error', t.name, 'Response sai định dạng', 'fail', (err as Error).message);
        }
      }

      // ---- runtime: retries are only applied to read tools
      for (const t of tools) {
        const args = sampleArgs(t.inputSchema);
        mock.next({ status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '0' } });
        try {
          const r = await call(client, t.name, args);
          if (t.impact === 'read') add('runtime', t.name, 'Retry khi 429', !r.isError && mock.requests.length === 2 ? 'pass' : 'fail', `${mock.requests.length} request, isError=${!!r.isError}`);
          else add('runtime', t.name, 'Không retry thao tác ghi', r.isError && mock.requests.length === 1 ? 'pass' : 'fail', `${mock.requests.length} request, isError=${!!r.isError}`);
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
      add('runtime', null, 'Phân trang', 'not_run', 'Chưa hỗ trợ trong MVP (không cần xử lý). Có thể kiểm bằng test case gọi tool với cursor/limit.');
      add('runtime', null, 'Idempotency', 'not_run', 'Chưa hỗ trợ trong MVP (không cần xử lý): runtime không retry thao tác ghi nên không gửi trùng.');
    }

    // ---- custom test cases on the Factory mock
    const known = new Set(tools.map((t) => t.name));
    for (const c of ctx.toolCases.filter((x) => x.target === 'mock')) {
      if (!known.has(c.tool)) add('custom', c.tool, c.name, 'blocked', `Tool "${c.tool}" không có trong bộ tool của build này`);
      else if (!client) add('custom', c.tool, c.name, 'blocked', 'MCP server không khởi động');
      else rows.push(await runToolCase(client, c, mock));
    }

    // ---- CLI interface
    if (ctx.project.outputs.cli) {
      const env = minimalEnv({ API_BASE_URL: mock.url, API_TOKEN: QA_TOKEN });
      const help = await run(process.execPath, [cliEntry, '--help'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
      add('interface', null, 'CLI --help', help.code === 0 && help.stdout.includes('Commands') ? 'pass' : 'fail', tail(help.stdout + help.stderr, 300));
      const bad = await run(process.execPath, [cliEntry, 'no-such-command'], { cwd: ctx.ws, env, timeoutMs: 15_000 });
      add('interface', null, 'CLI lệnh sai → exit 2', bad.code === 2 ? 'pass' : 'fail', `exit ${bad.code}`);
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
        add('interface', t.name, 'CLI --json', r.code === 0 && json ? 'pass' : 'fail', `exit ${r.code}${json ? '' : ', stdout không phải JSON'}`);
      }
    }
  } finally {
    await client?.close().catch(() => undefined);
    await mock.close();
  }

  // ---- integration: real API through the QA connection
  const conn = ctx.qaConnection;
  const integrationSkip = !ctx.runIntegration ? 'Người dùng tắt integration test cho lần chạy này'
    : !conn ? 'Chưa có môi trường được đánh dấu "Dùng cho QA"' : null;
  const secret = conn ? resolveSecret(conn.secretRef) : undefined;
  const liveCases = ctx.toolCases.filter((x) => x.target === 'live');
  if (integrationSkip) {
    for (const t of tools) add('integration', t.name, 'API thật', 'not_run', integrationSkip);
    for (const c of liveCases) add('custom', c.tool, c.name, 'not_run', integrationSkip);
  } else if (conn!.authType !== 'none' && !secret) {
    const why = `Secret ${conn!.secretRef} chưa được cấu hình trên máy chủ QA`;
    for (const t of tools) add('integration', t.name, 'API thật', 'blocked', why);
    for (const c of liveCases) add('custom', c.tool, c.name, 'blocked', why);
  }
  else {
    const env: Record<string, string> = { API_BASE_URL: conn!.baseUrl, API_TIMEOUT_MS: '10000' };
    if (conn!.authType === 'bearer') env.API_TOKEN = secret!;
    if (conn!.authType === 'api_key') { env.API_KEY = secret!; env.API_KEY_HEADER = conn!.authHeader; }
    let live: Client | undefined;
    try {
      live = await connect(mcpEntry, env, ctx.ws);
      const liveResults: QaRow[] = [];
      for (const c of liveCases) {
        const t = tools.find((x) => x.name === c.tool);
        if (!t) add('custom', c.tool, c.name, 'blocked', `Tool "${c.tool}" không có trong bộ tool của build này`);
        // A user-written live test on a write tool is explicit intent, but the environment must still allow writes.
        else if (t.impact !== 'read' && !conn!.allowWrite) add('custom', c.tool, c.name, 'blocked', `Môi trường ${conn!.name} không cho phép ghi`);
        else { const row = await runToolCase(live, c); rows.push(row); liveResults.push(row); }
      }
      for (const t of tools) {
        if (t.impact !== 'read') {
          // Never call write tools with guessed data on a real system: they count via user-written live test cases.
          const own = liveResults.filter((r) => r.tool === t.name);
          const failed = own.find((r) => r.status === 'fail');
          const passed = own.find((r) => r.status === 'pass');
          if (failed) add('integration', t.name, 'API thật', 'fail', `Test case live "${failed.name}" thất bại: ${failed.detail.slice(0, 200)}`);
          else if (passed) add('integration', t.name, 'API thật', 'pass', `Kiểm chứng bằng test case live "${passed.name}"`);
          else add('integration', t.name, 'API thật', 'blocked', conn!.allowWrite
            ? 'Tool ghi không được gọi bằng dữ liệu tự sinh. Thêm test case gọi tool (target: API thật) với dữ liệu an toàn để kiểm chứng.'
            : `Môi trường ${conn!.name} không cho phép ghi. Bật "Cho phép ghi" ở Connections và thêm test case live để kiểm chứng.`);
          continue;
        }
        const args = sampleArgs(t.inputSchema);
        const r = await call(live, t.name, args, 30_000).catch((e: Error) => ({ isError: true, content: [{ type: 'text', text: `[network] ${e.message}` }] }) as CallResult);
        const cat = categoryOf(r);
        if (!r.isError) add('integration', t.name, 'API thật', 'pass', `OK với tham số mẫu ${JSON.stringify(args)}`, { args, sample: textOf(r).slice(0, 400) });
        else if (cat === 'not_found' || cat === 'client' || cat === 'conflict') add('integration', t.name, 'API thật', 'pass', `Kết nối và xác thực OK; API trả lỗi nghiệp vụ với tham số mẫu: ${textOf(r).slice(0, 160)}`, { args });
        else add('integration', t.name, 'API thật', 'fail', textOf(r).slice(0, 300), { args });
      }
    } catch (err) {
      for (const t of tools) add('integration', t.name, 'API thật', 'fail', `Không khởi động được MCP server: ${(err as Error).message}`);
      for (const c of liveCases) add('custom', c.tool, c.name, 'blocked', 'MCP server không khởi động với môi trường thật');
    } finally {
      await live?.close().catch(() => undefined);
    }
  }

  // ---- agent evaluation: a Codex agent uses the generated MCP tools on the sample tasks
  if (!ctx.runAgentEval) for (const t of tools) add('agent', t.name, 'Agent task evaluation', 'not_run', 'Người dùng tắt agent eval cho lần chạy này');
  else {
    try {
      rows.push(...await runAgentEval(ctx, ctx.sampleTasks));
    } catch (err) {
      if (err instanceof BuildAbort || ctx.signal.aborted) throw err;
      for (const t of tools) add('agent', t.name, 'Agent task evaluation', 'fail', `Agent eval lỗi: ${(err as Error).message}`);
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
    if (inst.code !== 0) { add('install', null, 'npm install (môi trường sạch)', 'fail', tail(inst.stderr, 500)); return rows; }
    add('install', null, 'npm install (môi trường sạch)', 'pass');
    if (ctx.project.outputs.cli) {
      const bin = join(tmp, 'node_modules/.bin', ctx.cliBin);
      const r = existsSync(bin) ? await run(bin, ['--help'], { cwd: tmp, timeoutMs: 15_000 }) : null;
      add('install', null, `${ctx.cliBin} --help`, r?.code === 0 ? 'pass' : 'fail', r ? `exit ${r.code}` : 'Không tìm thấy binary');
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
