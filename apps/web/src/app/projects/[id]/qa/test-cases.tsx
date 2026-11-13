'use client';

import { useState } from 'react';
import { Bot, ListChecks, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import type { TestCaseDto, ToolDto, UpsertTestCaseInput } from '@mcp-factory/shared';
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
    if (!confirm(`Xóa test case "${tc.name}"?`)) return;
    try { await api.deleteTestCase(tc.id); toast('Đã xóa test case'); q.refetch(); } catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <Loaded q={q}>
      {([cases, allTools]) => {
        const tools = allTools.filter((t) => t.selected && !t.unsupportedReason);
        return (
          <Card className="overflow-hidden">
            <CardHeader title="Test case tùy chỉnh" description="Chạy trong mỗi lần Export và QA run. Test case thất bại sẽ chặn nhãn Package verified."
              actions={<button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Thêm test case</button>} />
            {cases.length === 0 ? (
              <EmptyState icon={<ListChecks className="size-5" />} title="Chưa có test case" description="Thêm test case gọi tool với kết quả mong đợi, hoặc tác vụ để agent Codex làm thử." />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Bật</th><th>Loại</th><th>Tên</th><th>Tool / tác vụ</th><th>Môi trường</th><th className="text-right">Thao tác</th></tr></thead>
                  <tbody>
                    {cases.map((tc) => (
                      <tr key={tc.id} className={cn(!tc.enabled && 'opacity-60')}>
                        <td><Switch checked={tc.enabled} onChange={(v) => toggle(tc, v)} label={`Bật test case ${tc.name}`} /></td>
                        <td>{tc.kind === 'tool_call' ? <Badge tone="info"><Wrench className="size-3" />Gọi tool</Badge> : <Badge tone="brand"><Bot className="size-3" />Tác vụ agent</Badge>}</td>
                        <td className="font-medium">{tc.name}</td>
                        <td className="max-w-[360px]">
                          {tc.kind === 'tool_call'
                            ? <span className="mono break-all">{tc.tool}<span className="text-muted-foreground">({tc.args ? JSON.stringify(tc.args) : ''})</span></span>
                            : <span className="line-clamp-2 text-sm">{tc.task}</span>}
                        </td>
                        <td>{tc.kind === 'tool_call' ? <Badge tone={tc.target === 'live' ? 'warning' : 'outline'}>{tc.target === 'live' ? 'API thật' : 'Mock'}</Badge> : <span className="text-xs text-muted-foreground">theo agent eval</span>}</td>
                        <td className="whitespace-nowrap text-right">
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditing(tc)} aria-label={`Sửa ${tc.name}`}><Pencil className="size-3.5" /></button>
                          <button className="btn btn-ghost btn-sm text-danger" onClick={() => remove(tc)} aria-label={`Xóa ${tc.name}`}><Trash2 className="size-3.5" /></button>
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
  try { v = JSON.parse(s); } catch { throw new Error(`${label}: JSON không hợp lệ`); }
  if (objectOnly && (typeof v !== 'object' || v === null || Array.isArray(v))) throw new Error(`${label} phải là một JSON object`);
  return v;
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
      if (!name.trim()) throw new Error('Cần đặt tên test case');
      if (kind === 'tool_call') {
        if (!tool) throw new Error('Chọn tool');
        const status = Number(mockStatus);
        if (mockOn && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error('HTTP status giả lập phải từ 100 đến 599');
        input = {
          kind, name: name.trim(), enabled: initial?.enabled ?? true,
          tool, args: parseJson('Tham số', args || '{}', true) as Record<string, unknown>, target,
          mockResponse: target === 'mock' && mockOn ? { status, ...(mockBody.trim() ? { body: parseJson('Body giả lập', mockBody, false) } : {}) } : null,
          expect: { isError, ...(category ? { category } : {}), ...(splitList(contains).length ? { contains: splitList(contains) } : {}) },
          task: null, expectedTools: [], answerContains: [],
        };
      } else {
        if (!task.trim()) throw new Error('Nhập nội dung tác vụ');
        input = {
          kind, name: name.trim(), enabled: initial?.enabled ?? true,
          tool: null, args: null, target: 'mock', mockResponse: null, expect: {},
          task: task.trim(), expectedTools, answerContains: splitList(answerContains),
        };
      }
    } catch (e) { setErr((e as Error).message); return; }

    setBusy(true);
    try {
      if (initial) await api.updateTestCase(initial.id, input); else await api.createTestCase(projectId, input);
      toast(initial ? 'Đã lưu test case' : 'Đã thêm test case');
      onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} size="max-w-2xl" title={initial ? 'Sửa test case' : 'Thêm test case'}
      description="Test case được chạy độc lập với code Codex sinh và có thể chạy lại bằng QA run."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Hủy</button>
        <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Lưu</button>
      </>}>
      <div className="space-y-4">
        <div className="seg" role="radiogroup" aria-label="Loại test case">
          <button type="button" role="radio" aria-checked={kind === 'tool_call'} className={cn(kind === 'tool_call' && 'on')} onClick={() => setKind('tool_call')}>Gọi tool</button>
          <button type="button" role="radio" aria-checked={kind === 'agent_task'} className={cn(kind === 'agent_task' && 'on')} onClick={() => setKind('agent_task')}>Tác vụ agent</button>
        </div>
        <Field label="Tên">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'tool_call' ? 'Duyệt đơn đã Confirmed phải báo 409' : 'Tra đơn Draft của khách C0042'} />}</Field>

        {kind === 'tool_call' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tool">
                {(id) => (
                  <select id={id} className="input font-mono text-xs" value={tool} onChange={(e) => pickTool(e.target.value)}>
                    {tools.length === 0 && <option value="">(chưa chọn tool nào)</option>}
                    {tool && !tools.some((t) => t.name === tool) && <option value={tool}>{tool} (không còn được chọn)</option>}
                    {tools.map((t) => <option key={t.id} value={t.name}>{t.name}</option>)}
                  </select>
                )}
              </Field>
              <Field label="Môi trường" hint={target === 'live' ? 'Gọi API thật qua connection "Dùng cho QA". Tool ghi chỉ chạy khi môi trường cho phép ghi.' : 'Mock API của Factory, có thể giả lập response.'}>
                {(id) => (
                  <select id={id} className="input" value={target} onChange={(e) => setTarget(e.target.value as TestCaseDto['target'])}>
                    <option value="mock">Mock</option>
                    <option value="live">API thật</option>
                  </select>
                )}
              </Field>
            </div>
            <Field label="Tham số (JSON object)">{(id) => <textarea id={id} className="textarea min-h-[96px] font-mono text-xs" spellCheck={false} value={args} onChange={(e) => setArgs(e.target.value)} />}</Field>
            {target === 'mock' && (
              <div className="rounded-lg border p-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={mockOn} onChange={(e) => setMockOn(e.target.checked)} />Giả lập response của API
                </label>
                {mockOn && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-[120px_1fr]">
                    <Field label="HTTP status">{(id) => <input id={id} type="number" min={100} max={599} className="input" value={mockStatus} onChange={(e) => setMockStatus(e.target.value)} />}</Field>
                    <Field label="Body (JSON, tùy chọn)">{(id) => <textarea id={id} className="textarea min-h-[76px] font-mono text-xs" spellCheck={false} value={mockBody} onChange={(e) => setMockBody(e.target.value)} placeholder='{"code":"ORDER_NOT_DRAFT","message":"..."}' />}</Field>
                  </div>
                )}
              </div>
            )}
            <div className="rounded-lg border p-3">
              <div className="mb-3 text-sm font-medium">Kết quả mong đợi</div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={isError} onChange={(e) => setIsError(e.target.checked)} />Tool trả lỗi (isError)
                </label>
                <Field label="Loại lỗi">
                  {(id) => (
                    <select id={id} className="input font-mono text-xs" value={category} onChange={(e) => setCategory(e.target.value)}>
                      {CATEGORIES.map((c) => <option key={c} value={c}>{c || '(không kiểm tra)'}</option>)}
                    </select>
                  )}
                </Field>
              </div>
              <Field className="mt-3" label="Kết quả phải chứa" hint="Mỗi dòng hoặc mỗi dấu phẩy là một chuỗi.">{(id) => <textarea id={id} className="textarea min-h-[60px] text-xs" value={contains} onChange={(e) => setContains(e.target.value)} placeholder="Draft" />}</Field>
            </div>
          </>
        ) : (
          <>
            <Field label="Tác vụ" hint="Agent Codex sẽ làm tác vụ này bằng MCP tool, trong môi trường của agent eval.">{(id) => <textarea id={id} className="textarea min-h-[96px]" value={task} onChange={(e) => setTask(e.target.value)} placeholder="Liệt kê các đơn Draft của khách C0042" />}</Field>
            <div>
              <div className="label">Tool mong đợi được gọi</div>
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
                {tools.length === 0 && <span className="text-sm text-muted-foreground">Chưa chọn tool nào trong Tool designer.</span>}
              </div>
              <p className="hint">Không chọn thì chỉ chấm việc agent dùng tool và hoàn thành tác vụ.</p>
            </div>
            <Field label="Câu trả lời phải chứa" hint="Mỗi dòng hoặc mỗi dấu phẩy là một chuỗi.">{(id) => <textarea id={id} className="textarea min-h-[60px] text-xs" value={answerContains} onChange={(e) => setAnswerContains(e.target.value)} placeholder="SO-1001" />}</Field>
          </>
        )}
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
