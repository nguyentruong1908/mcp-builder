'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Bot, Info, ListChecks, ListOrdered, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import type { TestCaseDto, TestStep, ToolDto, UpsertTestCaseInput } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Field, InlineError, Loaded, Modal, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/toast';

const CATEGORIES = ['', 'auth', 'not_found', 'conflict', 'rate_limited', 'client', 'server', 'timeout', 'network', 'response', 'input'];
const splitList = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function TestCases({ projectId }: { projectId: string }) {
  const toast = useToast();
  const q = useApi(() => Promise.all([api.testCases(projectId), api.tools(projectId)]), [projectId]);
  const [editing, setEditing] = useState<TestCaseDto | 'new' | null>(null);

  async function toggle(tc: TestCaseDto, enabled: boolean) {
    q.setData((prev) => prev && [prev[0].map((x) => (x.id === tc.id ? { ...x, enabled } : x)), prev[1]]);
    try { await api.updateTestCase(tc.id, { enabled }); } catch (e) { toast((e as Error).message, 'error'); q.refetch(); }
  }
  async function remove(tc: TestCaseDto) {
    if (!confirm(`Delete test case "${tc.name}"?`)) return;
    try { await api.deleteTestCase(tc.id); toast('Test case deleted'); q.refetch(); } catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <Loaded q={q}>
      {([cases, allTools]) => {
        const tools = allTools.filter((t) => t.selected && !t.unsupportedReason);
        return (
          <Card className="overflow-hidden">
            <CardHeader title="Custom test cases" description="Run on every Export and QA run. A failing test case blocks the Package verified label."
              actions={<button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Add test case</button>} />
            {cases.length === 0 ? (
              <EmptyState icon={<ListChecks className="size-5" />} title="No test cases yet" description="Add a tool call with an expected result, or a task for the Codex agent to try." />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>On</th><th>Type</th><th>Name</th><th>Tool / task</th><th>Environment</th><th className="text-right">Actions</th></tr></thead>
                  <tbody>
                    {cases.map((tc) => (
                      <tr key={tc.id} className={cn(!tc.enabled && 'opacity-60')}>
                        <td><Switch checked={tc.enabled} onChange={(v) => toggle(tc, v)} label={`Enable test case ${tc.name}`} /></td>
                        <td>{tc.kind === 'tool_call' ? <Badge tone="info"><Wrench className="size-3" />Tool call</Badge> : tc.kind === 'tool_steps' ? <Badge tone="info"><ListOrdered className="size-3" />Multi-step</Badge> : <Badge tone="brand"><Bot className="size-3" />Agent task</Badge>}</td>
                        <td className="font-medium">{tc.name}</td>
                        <td className="max-w-[360px]">
                          {tc.kind === 'tool_call'
                            ? <span className="mono break-all">{tc.tool}<span className="text-muted-foreground">({tc.args ? JSON.stringify(tc.args) : ''})</span></span>
                            : tc.kind === 'tool_steps'
                              ? <span className="text-sm">{tc.steps.length} steps: <span className="mono text-xs text-muted-foreground">{tc.steps.map((x) => x.tool).join(' → ')}</span></span>
                              : <span className="line-clamp-2 text-sm">{tc.task}</span>}
                        </td>
                        <td>{tc.kind !== 'agent_task' ? <Badge tone={tc.target === 'live' ? 'warning' : 'outline'}>{tc.target === 'live' ? 'Live API' : 'Mock'}</Badge> : <span className="text-xs text-muted-foreground">per agent eval</span>}</td>
                        <td className="whitespace-nowrap text-right">
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(tc)} aria-label={`Edit ${tc.name}`}><Pencil className="size-3.5" /></button>
                          <button className="btn btn-ghost btn-sm text-danger" onClick={() => remove(tc)} aria-label={`Delete ${tc.name}`}><Trash2 className="size-3.5" /></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {editing && (
              <TestCaseForm key={editing === 'new' ? 'new' : editing.id} projectId={projectId} tools={tools} initial={editing === 'new' ? null : editing}
                onClose={() => setEditing(null)} onSaved={() => { setEditing(null); q.refetch(); }} />
            )}
          </Card>
        );
      }}
    </Loaded>
  );
}

function argsTemplate(t: ToolDto | undefined): string {
  if (!t) return '{}';
  return JSON.stringify(Object.fromEntries(t.params.filter((p) => p.required).map((p) => [p.name, ''])), null, 2);
}

function parseJson(label: string, s: string, objectOnly: boolean): unknown {
  let v: unknown;
  try { v = JSON.parse(s); } catch { throw new Error(`${label}: invalid JSON`); }
  if (objectOnly && (typeof v !== 'object' || v === null || Array.isArray(v))) throw new Error(`${label} must be a JSON object`);
  return v;
}

type StepDraft = { tool: string; args: string; isError: boolean; category: string; contains: string; cleanup: boolean };

const toDraft = (st: TestStep): StepDraft => ({
  tool: st.tool, args: JSON.stringify(st.args, null, 2), isError: st.expect.isError ?? false,
  category: st.expect.category ?? '', contains: (st.expect.contains ?? []).join(', '), cleanup: st.cleanup,
});

/** Example from the product docs when the ERP tools exist; otherwise a generic 2-step skeleton. */
function exampleSteps(tools: ToolDto[]): StepDraft[] {
  const has = (n: string) => tools.some((t) => t.name === n);
  const blank = { isError: false, category: '', contains: '', cleanup: false };
  if (has('create_sales_order') && has('approve_sales_order') && has('delete_sales_order')) {
    return [
      { ...blank, tool: 'create_sales_order', args: JSON.stringify({ customerCode: 'C0042', lines: [{ sku: 'SKU-1002', qty: 1, price: 150000 }] }, null, 2) },
      { ...blank, tool: 'approve_sales_order', args: JSON.stringify({ id: '{{step1.id}}' }, null, 2), contains: 'Confirmed' },
      { ...blank, tool: 'delete_sales_order', args: JSON.stringify({ id: '{{step1.id}}' }, null, 2), cleanup: true },
    ];
  }
  const a = tools[0];
  const b = tools[1] ?? tools[0];
  return [
    { ...blank, tool: a?.name ?? '', args: argsTemplate(a) },
    { ...blank, tool: b?.name ?? '', args: JSON.stringify(Object.fromEntries((b?.params ?? []).filter((p) => p.required).map((p) => [p.name, '{{step1.id}}'])), null, 2) },
  ];
}

function TestCaseForm({ projectId, tools, initial, onClose, onSaved }: { projectId: string; tools: ToolDto[]; initial: TestCaseDto | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<TestCaseDto['kind']>(initial?.kind ?? 'tool_call');
  const [name, setName] = useState(initial?.name ?? '');
  const [tool, setTool] = useState(initial?.tool ?? tools[0]?.name ?? '');
  const [args, setArgs] = useState(initial?.args ? JSON.stringify(initial.args, null, 2) : argsTemplate(tools.find((t) => t.name === (initial?.tool ?? tools[0]?.name))));
  const [target, setTarget] = useState<TestCaseDto['target']>(initial?.target ?? 'mock');
  const [mockOn, setMockOn] = useState(!!initial?.mockResponse);
  const [mockStatus, setMockStatus] = useState(String(initial?.mockResponse?.status ?? 200));
  const [mockBody, setMockBody] = useState(initial?.mockResponse?.body !== undefined ? JSON.stringify(initial.mockResponse.body, null, 2) : '');
  const [isError, setIsError] = useState(initial?.expect.isError ?? false);
  const [category, setCategory] = useState(initial?.expect.category ?? '');
  const [contains, setContains] = useState((initial?.expect.contains ?? []).join('\n'));
  const [task, setTask] = useState(initial?.task ?? '');
  const [expectedTools, setExpectedTools] = useState<string[]>(initial?.expectedTools ?? []);
  const [answerContains, setAnswerContains] = useState((initial?.answerContains ?? []).join('\n'));
  const [steps, setSteps] = useState<StepDraft[]>(() => initial?.kind === 'tool_steps' && initial.steps.length ? initial.steps.map(toDraft) : exampleSteps(tools).slice(0, 1));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function pickTool(n: string) {
    setTool(n);
    // Only overwrite args the user has not edited away from the previous template.
    if (args.trim() === argsTemplate(tools.find((t) => t.name === tool)).trim() || !args.trim()) setArgs(argsTemplate(tools.find((t) => t.name === n)));
  }

  async function save() {
    setErr(null);
    let input: UpsertTestCaseInput;
    try {
      if (!name.trim()) throw new Error('Give the test case a name');
      if (kind === 'tool_call') {
        if (!tool) throw new Error('Choose a tool');
        const status = Number(mockStatus);
        if (mockOn && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error('Simulated HTTP status must be between 100 and 599');
        input = {
          kind, name: name.trim(), enabled: initial?.enabled ?? true,
          tool, args: parseJson('Arguments', args || '{}', true) as Record<string, unknown>, target,
          mockResponse: target === 'mock' && mockOn ? { status, ...(mockBody.trim() ? { body: parseJson('Simulated body', mockBody, false) } : {}) } : null,
          expect: { isError, ...(category ? { category } : {}), ...(splitList(contains).length ? { contains: splitList(contains) } : {}) },
          steps: [], task: null, expectedTools: [], answerContains: [],
        };
      } else if (kind === 'tool_steps') {
        if (!steps.length) throw new Error('Add at least one step');
        if (steps.length > 10) throw new Error('At most 10 steps');
        if (!steps.some((x) => !x.cleanup)) throw new Error('Add at least one step that is not a cleanup step');
        const built: TestStep[] = steps.map((x, i) => {
          if (!x.tool) throw new Error(`Step ${i + 1}: choose a tool`);
          const c = splitList(x.contains);
          return {
            tool: x.tool, args: parseJson(`Step ${i + 1} · arguments`, x.args || '{}', true) as Record<string, unknown>, cleanup: x.cleanup,
            expect: { isError: x.isError, ...(x.category ? { category: x.category } : {}), ...(c.length ? { contains: c } : {}) },
          };
        });
        input = {
          kind, name: name.trim(), enabled: initial?.enabled ?? true,
          tool: null, args: null, target, mockResponse: null, expect: {},
          steps: built, task: null, expectedTools: [], answerContains: [],
        };
      } else {
        if (!task.trim()) throw new Error('Enter the task');
        input = {
          kind, name: name.trim(), enabled: initial?.enabled ?? true,
          tool: null, args: null, target: 'mock', mockResponse: null, expect: {},
          steps: [], task: task.trim(), expectedTools, answerContains: splitList(answerContains),
        };
      }
    } catch (e) { setErr((e as Error).message); return; }

    setBusy(true);
    try {
      if (initial) await api.updateTestCase(initial.id, input); else await api.createTestCase(projectId, input);
      toast(initial ? 'Test case saved' : 'Test case added');
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="max-w-2xl" title={initial ? 'Edit test case' : 'Add test case'}
      description="Test cases run independently of the Codex-generated code and can be re-run with a QA run."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button>
      </>}>
      <div className="space-y-4">
        <div className="seg" role="radiogroup" aria-label="Test case type">
          <button type="button" role="radio" aria-checked={kind === 'tool_call'} className={cn(kind === 'tool_call' && 'on')} onClick={() => setKind('tool_call')}>Tool call</button>
          <button type="button" role="radio" aria-checked={kind === 'tool_steps'} className={cn(kind === 'tool_steps' && 'on')} onClick={() => setKind('tool_steps')}>Multi-step</button>
          <button type="button" role="radio" aria-checked={kind === 'agent_task'} className={cn(kind === 'agent_task' && 'on')} onClick={() => setKind('agent_task')}>Agent task</button>
        </div>
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'tool_call' ? 'Approving a Confirmed order returns 409' : 'Find Draft orders of customer C0042'} />}</Field>

        {kind === 'tool_steps' && (
          <StepsEditor tools={tools} steps={steps} setSteps={setSteps} target={target} setTarget={setTarget} />
        )}
        {kind === 'tool_steps' ? null : kind === 'tool_call' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tool">
                {(id) => (
                  <select id={id} className="input font-mono text-xs" value={tool} onChange={(e) => pickTool(e.target.value)}>
                    {tools.length === 0 && <option value="">(no tools selected)</option>}
                    {tool && !tools.some((t) => t.name === tool) && <option value={tool}>{tool} (no longer selected)</option>}
                    {tools.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Environment" hint={target === 'live' ? 'Calls the live API through the "Use for QA" connection. Write tools only run when the environment allows writes.' : 'Factory mock API; the response can be simulated.'}>
                {(id) => (
                  <select id={id} className="input" value={target} onChange={(e) => setTarget(e.target.value as TestCaseDto['target'])}>
                    <option value="mock">Mock</option>
                    <option value="live">Live API</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="Arguments (JSON object)">{(id) => <textarea id={id} className="textarea min-h-[96px] font-mono text-xs" spellCheck={false} value={args} onChange={(e) => setArgs(e.target.value)} />}</Field>
            {target === 'mock' && (
              <div className="rounded-lg border p-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={mockOn} onChange={(e) => setMockOn(e.target.checked)} />Simulate the API response
                </label>
                {mockOn && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
                    <Field label="HTTP status">{(id) => <input id={id} type="number" min={100} max={599} className="input" value={mockStatus} onChange={(e) => setMockStatus(e.target.value)} />}</Field>
                    <Field label="Body (JSON, optional)">{(id) => <textarea id={id} className="textarea min-h-[76px] font-mono text-xs" spellCheck={false} value={mockBody} onChange={(e) => setMockBody(e.target.value)} placeholder='{"code":"ORDER_NOT_DRAFT","message":"..."}' />}</Field>
                  </div>
                )}
              </div>
            )}
            <div className="rounded-lg border p-3">
              <div className="mb-3 text-sm font-medium">Expected result</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={isError} onChange={(e) => setIsError(e.target.checked)} />Tool returns an error (isError)
                </label>
                <Field label="Error category">
                  {(id) => (
                    <select id={id} className="input font-mono text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c || '(not checked)'}</option>)}
                    </select>
                  )}
                </Field>
              </div>
              <Field className="mt-3" label="Result must contain" hint="One string per line or comma.">{(id) => <textarea id={id} className="textarea min-h-[60px] text-xs" value={contains} onChange={(e) => setContains(e.target.value)} placeholder="Draft" />}</Field>
            </div>
          </>
        ) : (
          <>
            <Field label="Task" hint="The Codex agent performs this task with the MCP tools, in the agent eval environment.">{(id) => <textarea id={id} className="textarea min-h-[96px]" value={task} onChange={(e) => setTask(e.target.value)} placeholder="List the Draft orders of customer C0042" />}</Field>
            <div>
              <div className="label">Tools expected to be called</div>
              <div className="flex flex-wrap gap-2">
                {tools.map((t) => {
                  const on = expectedTools.includes(t.name);
                  return (
                    <button key={t.id} type="button" aria-pressed={on} onClick={() => setExpectedTools(on ? expectedTools.filter((x) => x !== t.name) : [...expectedTools, t.name])}
                      className={cn('inline-flex h-8 items-center rounded-md border px-2.5 font-mono text-xs transition-colors', on ? 'border-brand/50 bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-muted')}>
                      {t.name}
                    </button>
                  );
                })}
                {tools.length === 0 && <span className="text-sm text-muted-foreground">No tools selected in the Tool designer.</span>}
              </div>
              <p className="hint">If none are chosen, the agent is scored only on using tools and completing the task.</p>
            </div>
            <Field label="Answer must contain" hint="One string per line or comma.">{(id) => <textarea id={id} className="textarea min-h-[60px] text-xs" value={answerContains} onChange={(e) => setAnswerContains(e.target.value)} placeholder="SO-1001" />}</Field>
          </>
        )}
        <InlineError error={err} />
      </div>
    </Modal>
  );
}

function StepsEditor({ tools, steps, setSteps, target, setTarget }: {
  tools: ToolDto[]; steps: StepDraft[]; setSteps: (s: StepDraft[]) => void; target: TestCaseDto['target']; setTarget: (t: TestCaseDto['target']) => void;
}) {
  const update = (i: number, patch: Partial<StepDraft>) => setSteps(steps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    setSteps(next);
  };
  function pickTool(i: number, n: string) {
    const prev = steps[i];
    // Keep edited args; replace only the untouched template of the previous tool.
    const untouched = !prev.args.trim() || prev.args.trim() === argsTemplate(tools.find((t) => t.name === prev.tool)).trim();
    update(i, { tool: n, ...(untouched ? { args: argsTemplate(tools.find((t) => t.name === n)) } : {}) });
  }
  return (
    <div className="space-y-3">
      <div className="alert alert-info text-xs">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <div>
          Later steps use earlier results via <code className="mono">{'{{step1.id}}'}</code> (nested paths: <code className="mono">{'{{step2.items.0.id}}'}</code>).
          A placeholder on its own keeps the value's type. <b>Cleanup</b> steps always run last, even if an earlier step failed.
          <div className="mt-1 text-muted-foreground">Example: 1. create_sales_order → 2. approve_sales_order {'{"id":"{{step1.id}}"}'} contains “Confirmed” → 3. cleanup delete_sales_order {'{"id":"{{step1.id}}"}'}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Field label="Environment" hint={target === 'live' ? 'Live API through the "Use for QA" connection; steps calling write tools need an environment that allows writes.' : 'Factory mock API.'}>
          {(id) => (
            <select id={id} className="input w-auto" value={target} onChange={(e) => setTarget(e.target.value as TestCaseDto['target'])}>
              <option value="mock">Mock</option>
              <option value="live">Live API</option>
            </select>
          )}
        </Field>
        <button type="button" className="btn btn-outline btn-sm" onClick={() => setSteps(exampleSteps(tools))}>Insert example</button>
      </div>
      <ol className="space-y-3">
        {steps.map((st, i) => (
          <li key={i} className={cn('rounded-lg border p-3', st.cleanup && 'border-dashed')}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-semibold">Step {i + 1}</span>
              {st.cleanup && <Badge tone="outline">CLEANUP</Badge>}
              <div className="ml-auto flex gap-1">
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}><ArrowUp className="size-3.5" /></button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}><ArrowDown className="size-3.5" /></button>
                <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={steps.length === 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label={`Delete step ${i + 1}`}><Trash2 className="size-3.5" /></button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Tool">
                {(id) => (
                  <select id={id} className="input font-mono text-xs" value={st.tool} onChange={(e) => pickTool(i, e.target.value)}>
                    {!st.tool && <option value="">(choose a tool)</option>}
                    {st.tool && !tools.some((t) => t.name === st.tool) && <option value={st.tool}>{st.tool} (no longer selected)</option>}
                    {tools.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                )}
              </Field>
              <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={st.cleanup} onChange={(e) => update(i, { cleanup: e.target.checked })} />Clean up data (cleanup, always runs last)
              </label>
            </div>
            <Field className="mt-3" label="Arguments (JSON object)">{(id) => <textarea id={id} className="textarea min-h-[72px] font-mono text-xs" spellCheck={false} value={st.args} onChange={(e) => update(i, { args: e.target.value })} />}</Field>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={st.isError} onChange={(e) => update(i, { isError: e.target.checked })} />Expect an error
              </label>
              <Field label="Error category">
                {(id) => (
                  <select id={id} className="input font-mono text-xs" value={st.category} onChange={(e) => update(i, { category: e.target.value })}>
                    {CATEGORIES.map((c) => <option key={c} value={c}>{c || '(not checked)'}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Result must contain">{(id) => <input id={id} className="input text-xs" value={st.contains} onChange={(e) => update(i, { contains: e.target.value })} placeholder="Confirmed" />}</Field>
            </div>
          </li>
        ))}
      </ol>
      <button type="button" className="btn btn-outline btn-sm" disabled={steps.length >= 10}
        onClick={() => setSteps([...steps, { tool: tools[0]?.name ?? '', args: argsTemplate(tools[0]), isError: false, category: '', contains: '', cleanup: false }])}>
        <Plus className="size-3.5" />Add step
      </button>
    </div>
  );
}
