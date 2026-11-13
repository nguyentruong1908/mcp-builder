import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { CODEX_ISOLATION_CONFIG, codexHome, codexSandbox, config } from '../../config.js';
import { resolveSecret } from '../../core/util.js';
import { MockApi } from './mock-api.js';
import { minimalEnv } from './proc.js';
import { BuildAbort, type BuildCtx, type QaRow } from './types.js';

export const AGENT_EVAL_MAX_TASKS = Number(process.env.AGENT_EVAL_MAX_TASKS) || 5;
const TASK_TIMEOUT_MS = 4 * 60_000;
const SERVER = 'factory';

export interface SampleTask { text: string; expected: string[]; answerContains?: string[]; label?: string }

/** One task per line; bullets are stripped. Optional expected tools: "Find customer A's orders => search_sales_orders, get_sales_order". */
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
    preconditionFailed: { type: ['string', 'null'], description: 'if the current data, checked with the tools, makes the task inapplicable (e.g. already done, wrong state), explain; otherwise null' },
    cleanup: { type: ['string', 'null'], description: 'test data you created and what you did with it (removed / left in place and why); null if you created none' },
  },
  required: ['completed', 'answer', 'blockedReason', 'preconditionFailed', 'cleanup'],
  additionalProperties: false,
} as const;

const prompt = (task: string) => `You are an AI agent evaluated on how well you use the MCP tools of the "${SERVER}" server to accomplish a business task.
Use only those MCP tools. Do not run shell commands, do not read files, do not guess data you did not get from a tool.
If no available tool can accomplish the task, do not improvise: set completed=false and explain in blockedReason.
If you checked the data with the tools and its current state makes the task inapplicable (already done, wrong status, missing record), do not force it: set completed=false and explain in preconditionFailed.
This runs on a shared test environment. If you created data that is not part of the expected outcome, you may remove it with the available tools; only touch data you created during this task, never pre-existing data. Report what you did in cleanup.
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
  if (!tasks.length) return toolRows('not_run', 'The context has no sample tasks ("Sample tasks" field)');

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
  const envLabel = live ? `live API (${conn!.name})` : 'Factory mock API';
  await ctx.log('info', 'qa', `Agent eval: ${Math.min(tasks.length, AGENT_EVAL_MAX_TASKS)} tasks · ${envLabel} · access ${access} · tools: ${enabled.join(', ')}`);

  const codex = new Codex({
    // Secrets reach the MCP server via env_vars passthrough, never via argv. Codex's shell policy excludes *TOKEN*/*KEY* vars by default.
    env: minimalEnv({ CODEX_HOME: codexHome, ...env }),
    ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}),
    config: {
      ...CODEX_ISOLATION_CONFIG,
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
        rows.push({ layer: 'agent', tool: null, name: task.label ?? task.text, status: 'blocked', detail: unknown.length ? `Expected tools are not in the tool set: ${unknown.join(', ')}` : `The agent may not use ${missing.join(', ')} on the ${envLabel}. Grant access in Connections › "Agent eval access".`, evidence: { task: task.text, expected: task.expected, env: envLabel } });
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
            if (cost > ctx.limits.maxCostUsd) throw new BuildAbort(`Cost cap $${ctx.limits.maxCostUsd} exceeded during agent eval (spent $${cost.toFixed(2)})`);
          } else if (ev.type === 'turn.failed') throw new Error(ev.error.message);
        }
      } catch (err) {
        if (err instanceof BuildAbort || ctx.signal.aborted) throw err;
        final = JSON.stringify({ completed: false, answer: '', blockedReason: null, error: timer.signal.aborted ? 'Timed out after 4 minutes' : (err as Error).message });
      } finally {
        clearTimeout(t);
        ctx.signal.removeEventListener('abort', onAbort);
        await rm(dir, { recursive: true, force: true });
      }

      let out: { completed?: boolean; answer?: string; blockedReason?: string | null; preconditionFailed?: string | null; cleanup?: string | null; error?: string } = {};
      try { out = JSON.parse(final); } catch { out = { completed: false, answer: final }; }
      const called = [...new Set(calls.map((c) => c.tool))];
      // Business errors (404/409/400) are legitimate tool results; infrastructure errors are failures.
      const hardErrors = calls.filter((c) => !c.ok && !['not_found', 'conflict', 'client'].includes(c.category ?? ''));
      const missingExpected = task.expected.filter((e) => !called.includes(e));
      // Mock data is synthetic, so expected answer content is only checked against the real API.
      const missingAnswer = !live ? [] : (task.answerContains ?? []).filter((s) => !(out.answer ?? '').toLowerCase().includes(s.toLowerCase()));
      const problems = [
        out.error && `Agent error: ${out.error}`,
        !calls.length && !out.blockedReason && 'The agent called no tools',
        missingExpected.length && `Expected tools not called: ${missingExpected.join(', ')}`,
        missingAnswer.length && `Answer is missing: ${missingAnswer.map((s) => `"${s}"`).join(', ')}`,
        hardErrors.length && `Tool errors: ${hardErrors.map((c) => `${c.tool} [${c.category}]`).join(', ')}`,
        shell && `The agent ran ${shell} shell commands instead of using only tools`,
        !out.completed && !out.blockedReason && 'The agent did not complete the task',
      ].filter(Boolean) as string[];
      // The agent verified with tools that the data state makes the task inapplicable: a test-data issue, not a tool failure.
      // Wrong tool choices without such an explanation still fail.
      const precondition = !!out.preconditionFailed && calls.length > 0 && !hardErrors.length && !shell && !out.error;
      const status: QaRow['status'] = precondition ? 'blocked' : problems.length ? 'fail' : out.completed ? 'pass' : 'blocked';
      const summary = called.length ? `Calls: ${calls.map((c) => `${c.tool}(${JSON.stringify(c.args)})${c.ok ? '' : ` [${c.category}]`}`).join(' → ')}` : 'No tool calls';
      const detail = status === 'pass' ? `${summary}. Answer: ${(out.answer ?? '').slice(0, 300)}`
        : precondition ? `Precondition not met (the agent checked with tools): ${out.preconditionFailed}. Review the test data or write a task that creates its own data. ${summary}`
        : status === 'blocked' ? `The agent reported it cannot do this: ${out.blockedReason}. ${summary}`
          : `${problems.join('; ')}. ${summary}`;
      rows.push({ layer: 'agent', tool: null, name: task.label ?? task.text, status, detail: detail + (out.cleanup ? ` Agent cleanup report: ${out.cleanup}` : ''), evidence: { task: task.text, expected: task.expected, answerContains: task.answerContains ?? [], testCase: task.label ?? null, env: envLabel, calls, cleanup: out.cleanup ?? null, answer: out.answer ?? '', blockedReason: out.blockedReason ?? null, preconditionFailed: out.preconditionFailed ?? null } });
      for (const c of calls) mark(c.tool, status === 'pass' && c.ok ? 'pass' : status === 'fail' ? 'fail' : 'blocked');
      await ctx.log(status === 'pass' ? 'success' : status === 'fail' ? 'error' : 'warn', 'qa', `Agent [${status}] ${task.text} · ${summary}`);
    }
  } finally {
    await mock?.close();
  }

  if (tasks.length > AGENT_EVAL_MAX_TASKS) rows.push({ layer: 'agent', tool: null, name: `${tasks.length - AGENT_EVAL_MAX_TASKS} remaining tasks`, status: 'not_run', detail: `Limited to ${AGENT_EVAL_MAX_TASKS} tasks per build (AGENT_EVAL_MAX_TASKS)` });
  for (const t of ctx.tools) {
    const s = used.get(t.name);
    rows.push({ layer: 'agent', tool: t.name, name: 'Agent task evaluation', status: s ?? 'not_run', detail: s ? `Used by the agent in sample tasks (${envLabel})` : enabled.includes(t.name) ? 'No sample task needs this tool' : `The agent may not use this tool on the ${envLabel} (access ${access})` });
  }
  return rows;
}
