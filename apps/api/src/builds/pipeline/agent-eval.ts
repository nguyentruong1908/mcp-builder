import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { codexHome, codexSandbox, config } from '../../config.js';
import { resolveSecret } from '../../core/util.js';
import { MockApi } from './mock-api.js';
import { minimalEnv } from './proc.js';
import { BuildAbort, type BuildCtx, type QaRow } from './types.js';

export const AGENT_EVAL_MAX_TASKS = Number(process.env.AGENT_EVAL_MAX_TASKS) || 5;
const TASK_TIMEOUT_MS = 4 * 60_000;
const SERVER = 'factory';

export interface SampleTask { text: string; expected: string[]; answerContains?: string[]; label?: string }

/** One task per line; bullets are stripped. Optional expected tools: "Tra đơn của khách A => search_sales_orders, get_sales_order". */
export function parseSampleTasks(raw: string): SampleTask[] {
  return raw.split('\n')
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [text, exp] = l.split(/\s*(?:=>|→)\s*/, 2);
      return { text: text.trim(), expected: exp ? exp.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : [] };
    })
    .filter((t) => t.text.length > 0);
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    completed: { type: 'boolean', description: 'true if the task was fully accomplished using the tools' },
    answer: { type: 'string', description: 'final answer for the user' },
    blockedReason: { type: ['string', 'null'], description: 'if not completed because no available tool can do it, explain; otherwise null' },
  },
  required: ['completed', 'answer', 'blockedReason'],
  additionalProperties: false,
} as const;

const prompt = (task: string) => `You are an AI agent evaluated on how well you use the MCP tools of the "${SERVER}" server to accomplish a business task.
Use only those MCP tools. Do not run shell commands, do not read files, do not guess data you did not get from a tool.
If no available tool can accomplish the task, do not improvise: set completed=false and explain in blockedReason.
Answer in the same language as the task.

Task: ${task}`;

interface ToolCall { tool: string; args: unknown; ok: boolean; category?: string; text: string }

/**
 * Runs each sample task with a fresh Codex agent connected to the generated MCP server.
 * Scoring uses the observed MCP tool calls (event stream), not the agent's self-report.
 */
export async function runAgentEval(ctx: BuildCtx, tasks: SampleTask[]): Promise<QaRow[]> {
  const rows: QaRow[] = [];
  const toolRows = (status: QaRow['status'], detail: string) => ctx.tools.map((t) => ({ layer: 'agent' as const, tool: t.name, name: 'Agent task evaluation', status, detail }));
  if (!tasks.length) return toolRows('not_run', 'Context chưa có tác vụ mẫu (mục "Tác vụ mẫu")');

  // Environment: real API (read tools; write tools only if the env allows writes) or the Factory mock.
  const conn = ctx.qaConnection;
  const secret = conn ? resolveSecret(conn.secretRef) : undefined;
  const live = !!conn && ctx.runIntegration && (conn.authType === 'none' || !!secret);
  // Live env: the operator decides how far the agent may change real data. Mock: everything is safe to expose.
  const access = live ? conn!.agentAccess : 'write_destructive';
  const allowed = (impact: string) => impact === 'read' || (impact === 'destructive' ? access === 'write_destructive' : access !== 'read_only');
  const enabled = ctx.tools.filter((t) => allowed(t.impact)).map((t) => t.name);
  let mock: MockApi | undefined;
  const env: Record<string, string> = { API_TIMEOUT_MS: '15000' };
  if (live) {
    env.API_BASE_URL = conn!.baseUrl;
    if (conn!.authType === 'bearer') env.API_TOKEN = secret!;
    if (conn!.authType === 'api_key') { env.API_KEY = secret!; env.API_KEY_HEADER = conn!.authHeader; }
  } else {
    mock = new MockApi(ctx.tools);
    await mock.start();
    env.API_BASE_URL = mock.url;
    env.API_TOKEN = 'qa-token';
  }
  const envLabel = live ? `API thật (${conn!.name})` : 'mock API của Factory';
  await ctx.log('info', 'qa', `Agent eval: ${Math.min(tasks.length, AGENT_EVAL_MAX_TASKS)} tác vụ · ${envLabel} · quyền ${access} · tool: ${enabled.join(', ')}`);

  const codex = new Codex({
    // Secrets reach the MCP server via env_vars passthrough, never via argv. Codex's shell policy excludes *TOKEN*/*KEY* vars by default.
    env: minimalEnv({ CODEX_HOME: codexHome, ...env }),
    ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}),
    config: {
      mcp_servers: {
        [SERVER]: {
          command: process.execPath,
          args: [join(ctx.ws, 'dist/mcp.js')],
          env_vars: Object.keys(env),
          enabled_tools: enabled,
          // Factory already restricts which tools the agent sees (writes only when the env allows them); Codex must not block them.
          default_tools_approval_mode: 'approve',
          startup_timeout_sec: 30,
          tool_timeout_sec: 60,
        },
      },
    },
  });

  const used = new Map<string, QaRow['status']>();
  const rank = { fail: 3, blocked: 2, not_run: 1, pass: 0 } as const;
  const mark = (tool: string, s: QaRow['status']) => { const cur = used.get(tool); if (!cur || rank[s] < rank[cur]) used.set(tool, s); };

  try {
    for (const task of tasks.slice(0, AGENT_EVAL_MAX_TASKS)) {
      if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new BuildAbort('Aborted');
      const missing = task.expected.filter((t) => !enabled.includes(t));
      if (missing.length) {
        const unknown = missing.filter((t) => !ctx.tools.some((x) => x.name === t));
        rows.push({ layer: 'agent', tool: null, name: task.label ?? task.text, status: 'blocked', detail: unknown.length ? `Tool mong đợi không có trong bộ tool: ${unknown.join(', ')}` : `Agent chưa được phép dùng ${missing.join(', ')} trên ${envLabel}. Cấp quyền ở Connections › "Agent eval được phép".`, evidence: { task: task.text, expected: task.expected, env: envLabel } });
        continue;
      }

      const dir = await mkdtemp(join(tmpdir(), 'mcpf-agent-'));
      const calls: ToolCall[] = [];
      let shell = 0;
      let final = '';
      const timer = new AbortController();
      const t = setTimeout(() => timer.abort(), TASK_TIMEOUT_MS);
      const onAbort = () => timer.abort();
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      try {
        const thread = codex.startThread({ workingDirectory: dir, skipGitRepoCheck: true, sandboxMode: codexSandbox, approvalPolicy: 'never', networkAccessEnabled: false, model: config.codexModel });
        const { events } = await thread.runStreamed(prompt(task.text), { outputSchema: OUTPUT_SCHEMA, signal: timer.signal });
        for await (const ev of events) {
          if (ev.type === 'item.completed') {
            const it = ev.item;
            if (it.type === 'mcp_tool_call' && it.server === SERVER) {
              const text = (it.result?.content ?? []).map((c) => ('text' in c ? String(c.text) : '')).join('\n');
              const category = /^\[([a-z_]+)\]/.exec(text)?.[1];
              calls.push({ tool: it.tool, args: it.arguments, ok: it.status === 'completed' && !it.error && !category, category: category ?? (it.error ? 'mcp' : undefined), text: (it.error?.message ?? text).slice(0, 300) });
            } else if (it.type === 'command_execution') shell++;
            else if (it.type === 'agent_message') final = it.text;
          } else if (ev.type === 'turn.completed') {
            const cost = await ctx.addUsage(ev.usage);
            if (cost > ctx.limits.maxCostUsd) throw new BuildAbort(`Vượt trần chi phí $${ctx.limits.maxCostUsd} trong agent eval (đã dùng $${cost.toFixed(2)})`);
          } else if (ev.type === 'turn.failed') throw new Error(ev.error.message);
        }
      } catch (err) {
        if (err instanceof BuildAbort || ctx.signal.aborted) throw err;
        final = JSON.stringify({ completed: false, answer: '', blockedReason: null, error: timer.signal.aborted ? 'Quá thời gian 4 phút' : (err as Error).message });
      } finally {
        clearTimeout(t);
        ctx.signal.removeEventListener('abort', onAbort);
        await rm(dir, { recursive: true, force: true });
      }

      let out: { completed?: boolean; answer?: string; blockedReason?: string | null; error?: string } = {};
      try { out = JSON.parse(final); } catch { out = { completed: false, answer: final }; }
      const called = [...new Set(calls.map((c) => c.tool))];
      // Business errors (404/409/400) are legitimate tool results; infrastructure errors are failures.
      const hardErrors = calls.filter((c) => !c.ok && !['not_found', 'conflict', 'client'].includes(c.category ?? ''));
      const missingExpected = task.expected.filter((e) => !called.includes(e));
      // Mock data is synthetic, so expected answer content is only checked against the real API.
      const missingAnswer = !live ? [] : (task.answerContains ?? []).filter((s) => !(out.answer ?? '').toLowerCase().includes(s.toLowerCase()));
      const problems = [
        out.error && `Agent lỗi: ${out.error}`,
        !calls.length && !out.blockedReason && 'Agent không gọi tool nào',
        missingExpected.length && `Không gọi tool mong đợi: ${missingExpected.join(', ')}`,
        missingAnswer.length && `Câu trả lời thiếu: ${missingAnswer.map((s) => `"${s}"`).join(', ')}`,
        hardErrors.length && `Tool lỗi: ${hardErrors.map((c) => `${c.tool} [${c.category}]`).join(', ')}`,
        shell && `Agent chạy ${shell} lệnh shell thay vì chỉ dùng tool`,
        !out.completed && !out.blockedReason && 'Agent không hoàn thành tác vụ',
      ].filter(Boolean) as string[];
      const status: QaRow['status'] = problems.length ? 'fail' : out.completed ? 'pass' : 'blocked';
      const summary = called.length ? `Gọi: ${calls.map((c) => `${c.tool}(${JSON.stringify(c.args)})${c.ok ? '' : ` [${c.category}]`}`).join(' → ')}` : 'Không gọi tool';
      const detail = status === 'pass' ? `${summary}. Trả lời: ${(out.answer ?? '').slice(0, 300)}`
        : status === 'blocked' ? `Agent báo không làm được: ${out.blockedReason}. ${summary}`
          : `${problems.join('; ')}. ${summary}`;
      rows.push({ layer: 'agent', tool: null, name: task.label ?? task.text, status, detail, evidence: { task: task.text, expected: task.expected, answerContains: task.answerContains ?? [], testCase: task.label ?? null, env: envLabel, calls, answer: out.answer ?? '', blockedReason: out.blockedReason ?? null } });
      for (const c of calls) mark(c.tool, status === 'pass' && c.ok ? 'pass' : status === 'fail' ? 'fail' : 'blocked');
      await ctx.log(status === 'pass' ? 'success' : status === 'fail' ? 'error' : 'warn', 'qa', `Agent [${status}] ${task.text} · ${summary}`);
    }
  } finally {
    await mock?.close();
  }

  if (tasks.length > AGENT_EVAL_MAX_TASKS) rows.push({ layer: 'agent', tool: null, name: `${tasks.length - AGENT_EVAL_MAX_TASKS} tác vụ còn lại`, status: 'not_run', detail: `Giới hạn ${AGENT_EVAL_MAX_TASKS} tác vụ mỗi build (AGENT_EVAL_MAX_TASKS)` });
  for (const t of ctx.tools) {
    const s = used.get(t.name);
    rows.push({ layer: 'agent', tool: t.name, name: 'Agent task evaluation', status: s ?? 'not_run', detail: s ? `Được agent dùng trong tác vụ mẫu (${envLabel})` : enabled.includes(t.name) ? 'Không tác vụ mẫu nào cần tool này' : `Agent chưa được phép dùng tool này trên ${envLabel} (quyền ${access})` });
  }
  return rows;
}
