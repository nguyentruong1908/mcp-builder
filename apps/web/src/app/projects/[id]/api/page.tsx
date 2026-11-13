'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { useParams } from 'next/navigation';
import { Check, CircleCheck, FileCode2, Info, Link as LinkIcon, Plus, Shield, Trash2, TriangleAlert, UploadCloud } from 'lucide-react';
import type { ContextDto, UpdateContextInput } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, fmtDate, shortHash } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Field, InlineError, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { SpecDiffView } from '@/components/spec-diff';
import { useToast } from '@/components/toast';

type Tab = 'swagger' | 'context' | 'glossary' | 'conflicts';
const IMPACT_PRESETS = ['Đọc dữ liệu', 'Ghi dữ liệu', 'Duyệt chứng từ', 'Gửi email', 'Xóa dữ liệu'];

export default function ApiContextPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<Tab>('swagger');
  const conflicts = useApi(() => api.conflicts(id), [id]);
  const ctx = useContextForm(id, conflicts.refetch);

  return (
    <>
      <PageHeader title="API & Context" description="Đặc tả và ngữ cảnh là dữ liệu đầu vào cho generation và QA. Chúng không làm thay đổi quyền của worker." />
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={[
        { id: 'swagger', label: 'Swagger snapshot' },
        { id: 'context', label: 'Context có cấu trúc' },
        { id: 'glossary', label: 'Glossary' },
        { id: 'conflicts', label: <>Mâu thuẫn{!!conflicts.data?.length && <span className="badge badge-warning ml-1.5">{conflicts.data.length}</span>}</> },
      ]} />
      {tab === 'swagger' && <SwaggerTab projectId={id} onImported={conflicts.refetch} />}
      {tab === 'context' && <ContextTab ctx={ctx} />}
      {tab === 'glossary' && <GlossaryTab ctx={ctx} />}
      {tab === 'conflicts' && (
        <Loaded q={conflicts}>
          {(list) => list.length === 0 ? (
            <Card><EmptyState icon={<CircleCheck className="size-5 text-success" />} title="Không phát hiện mâu thuẫn" description="Hệ thống so glossary và context với spec hiện tại. Không tự đoán endpoint hay quy tắc chưa được cung cấp." /></Card>
          ) : (
            <div className="space-y-3">
              {list.map((c) => (
                <Card key={c.id} className="p-5">
                  <div className="flex items-start gap-3">
                    {c.severity === 'warning' ? <TriangleAlert className="size-5 shrink-0 text-warning" /> : <Info className="size-5 shrink-0 text-info" />}
                    <div><div className="font-medium">{c.title}</div><p className="mt-1 text-sm text-muted-foreground">{c.detail}</p></div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </Loaded>
      )}
    </>
  );
}

// ---------------- Swagger ----------------
function SwaggerTab({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const q = useApi(() => api.spec(projectId), [projectId]);
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [diffPair, setDiffPair] = useState<[string, string] | null>(null);

  useEffect(() => { if (q.data?.current?.sourceUrl && !url) setUrl(q.data.current.sourceUrl); }, [q.data, url]);

  async function doImport(input: { url?: string; content?: string; filename?: string }) {
    setBusy(true); setErr(null);
    try {
      const snap = await api.importSpec(projectId, input);
      toast(`Đã import ${snap.title || 'spec'} · ${snap.operationCount} operation`);
      q.refetch(); onImported();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return setErr('File vượt quá 5MB.');
    await doImport({ content: await f.text(), filename: f.name });
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Nguồn đặc tả" description="OpenAPI 3.0.x · JSON hoặc YAML" />
          <div className="px-5 pb-5">
            <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); if (url.trim()) doImport({ url: url.trim() }); }}>
              <div className="relative flex-1">
                <LinkIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input className="input pl-9 font-mono text-xs" type="url" placeholder="https://api.example.com/openapi.yaml" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Swagger URL" />
              </div>
              <button className="btn btn-outline" disabled={busy || !url.trim()}>{busy ? <Spinner /> : <FileCode2 className="size-4" />}Fetch</button>
            </form>
            <label className={cn('mt-3 flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed py-6 text-center transition-colors hover:bg-muted/40', busy ? 'pointer-events-none opacity-60' : 'cursor-pointer')}>
              <UploadCloud className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">Bấm để upload file spec</span>
              <span className="text-xs text-muted-foreground">.json, .yaml, .yml · tối đa 5MB</span>
              <input type="file" className="sr-only" accept=".json,.yaml,.yml" onChange={onFile} disabled={busy} />
            </label>
            <p className="hint flex items-center gap-1.5"><Shield className="size-3.5" />Fetch URL chỉ tới domain trong allowlist của server; <code className="mono">$ref</code> ngoài file không được resolve.</p>
            <div className="mt-3"><InlineError error={err} /></div>
          </div>
        </Card>

        <Loaded q={q}>
          {(s) => !s.current ? (
            <Card><EmptyState icon={<FileCode2 className="size-5" />} title="Chưa có spec" description="Import Swagger/OpenAPI bằng URL hoặc file để hệ thống liệt kê endpoint." /></Card>
          ) : (
            <Card className="overflow-hidden">
              <CardHeader title="Kết quả kiểm tra đầu vào" description="Phần không hỗ trợ chỉ bị loại khi người dùng xác nhận phạm vi trong Tool designer" />
              <div className="grid grid-cols-2 border-y sm:grid-cols-4">
                {[
                  ['Operations', s.current.operationCount, ''],
                  ['Hỗ trợ', s.current.supportedCount, 'text-success'],
                  ['Cảnh báo', s.current.issues.filter((i) => i.level === 'warning').length, 'text-warning'],
                  ['Không hỗ trợ / lỗi', s.current.issues.filter((i) => i.level !== 'warning').length, 'text-danger'],
                ].map(([label, n, cls], i) => (
                  <div key={String(label)} className={cn('p-4', i > 0 && 'border-l')}>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div className={cn('stat-n mt-1 text-xl', String(cls))}>{n}</div>
                  </div>
                ))}
              </div>
              {s.current.issues.length === 0 ? <p className="px-5 py-4 text-sm text-muted-foreground">Không có cảnh báo.</p> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Mức</th><th>Operation</th><th>Vấn đề</th></tr></thead>
                    <tbody>
                      {s.current.issues.map((r, i) => (
                        <tr key={i}>
                          <td><Badge tone={r.level === 'warning' ? 'warning' : 'danger'}>{r.level === 'warning' ? 'Cảnh báo' : r.level === 'unsupported' ? 'Không hỗ trợ' : 'Lỗi'}</Badge></td>
                          <td className="mono whitespace-nowrap">{r.operation ?? '—'}</td>
                          <td className="text-muted-foreground">{r.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}
        </Loaded>

        {diffPair && (
          <Card>
            <CardHeader title="So sánh snapshot" description={<span className="mono">{shortHash(diffPair[0])} → {shortHash(diffPair[1])}</span>}
              actions={<button className="btn btn-ghost btn-sm" onClick={() => setDiffPair(null)}>Đóng</button>} />
            <div className="px-5 pb-5"><SpecDiffView projectId={projectId} from={diffPair[0]} to={diffPair[1]} /></div>
          </Card>
        )}
      </div>

      <Loaded q={q} loading={null}>
        {(s) => s.current && (
          <Card className="h-fit">
            <CardHeader title="Snapshot" actions={<Badge tone="success">OAS {s.current.oasVersion}</Badge>} />
            <dl className="kv px-5 pb-5">
              <dt>Tiêu đề</dt><dd>{s.current.title || '—'}</dd>
              <dt>API version</dt><dd>{s.current.apiVersion || '—'}</dd>
              <dt>SHA-256</dt><dd className="mono" title={s.current.sha256}>{shortHash(s.current.sha256)}</dd>
              <dt>Import</dt><dd>{fmtDate(s.current.createdAt)}</dd>
              <dt>Nguồn</dt><dd className="mono break-all text-xs">{s.current.sourceUrl ?? s.current.filename ?? '—'}</dd>
              <dt>Security</dt><dd>{s.current.securitySchemes.join(' · ') || '—'}</dd>
              <dt>Servers</dt><dd className="mono break-all text-xs">{s.current.servers.join(', ') || '—'}</dd>
            </dl>
            <div className="border-t px-5 py-4">
              <div className="mb-2 text-xs font-medium text-muted-foreground">Lịch sử</div>
              <HistoryList history={s.history} currentId={s.current.id} onDiff={setDiffPair} />
            </div>
          </Card>
        )}
      </Loaded>
    </div>
  );
}

function HistoryList({ history, currentId, onDiff }: { history: { id: string; sha256: string; createdAt: string }[]; currentId: string; onDiff: (p: [string, string]) => void }) {
  const sorted = [...history].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const [pick, setPick] = useState<string[]>([]);
  function toggle(sid: string) { setPick((p) => (p.includes(sid) ? p.filter((x) => x !== sid) : [...p.slice(-1), sid])); }
  function compare() {
    const [a, b] = pick.map((sid) => sorted.find((h) => h.id === sid)!).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    onDiff([a.id, b.id]);
  }
  return (
    <>
      <div className="space-y-1.5 text-sm">
        {sorted.map((h) => (
          <label key={h.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-muted/40">
            <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={pick.includes(h.id)} onChange={() => toggle(h.id)} aria-label={`Chọn snapshot ${shortHash(h.sha256)}`} />
            <span className={cn('mono flex-1', h.id !== currentId && 'text-muted-foreground')}>{shortHash(h.sha256)}</span>
            {h.id === currentId ? <Badge tone="brand">hiện tại</Badge> : <span className="text-xs text-muted-foreground">{fmtDate(h.createdAt)}</span>}
          </label>
        ))}
      </div>
      <button className="btn btn-outline btn-sm mt-3 w-full" disabled={pick.length !== 2} onClick={compare}>So sánh 2 snapshot đã chọn</button>
    </>
  );
}

// ---------------- Context ----------------
type CtxForm = ReturnType<typeof useContextForm>;

function useContextForm(projectId: string, onSaved: () => void) {
  const q = useApi(() => api.context(projectId), [projectId]);
  const toast = useToast();
  const [form, setForm] = useState<UpdateContextInput>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (q.data) { const { updatedAt: _, ...rest } = q.data; setForm(rest); }
  }, [q.data]);
  async function save() {
    if (!form) return;
    setBusy(true); setErr(null);
    try {
      const saved: ContextDto = await api.saveContext(projectId, { ...form, glossary: form.glossary.filter((g) => g.term.trim()) });
      q.setData(saved); toast('Đã lưu context'); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const set = <K extends keyof UpdateContextInput>(k: K, v: UpdateContextInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  return { q, form, set, save, busy, err, updatedAt: q.data?.updatedAt ?? null };
}

function SaveBar({ ctx }: { ctx: CtxForm }) {
  return (
    <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
      <div className="flex-1"><InlineError error={ctx.err} /></div>
      {ctx.updatedAt && <span className="text-xs text-muted-foreground">Lưu lần cuối {fmtDate(ctx.updatedAt)}</span>}
      <button className="btn btn-primary" disabled={ctx.busy || !ctx.form} onClick={ctx.save}>{ctx.busy && <Spinner />}Lưu context</button>
    </div>
  );
}

function ContextTab({ ctx }: { ctx: CtxForm }) {
  return (
    <Loaded q={ctx.q}>
      {() => {
        const f = ctx.form;
        if (!f) return null;
        const area = (k: 'purpose' | 'sampleTasks' | 'businessRules' | 'freeform', label: string, hint?: string, placeholder?: string, tall?: boolean) => (
          <Field label={label} hint={hint}>{(id) => <textarea id={id} className={cn('textarea', tall && 'min-h-[110px]')} value={f[k]} placeholder={placeholder} onChange={(e) => ctx.set(k, e.target.value)} />}</Field>
        );
        const line = (k: 'dataFormats' | 'accessScope' | 'expectedResults', label: string, hint?: string, placeholder?: string) => (
          <Field label={label} hint={hint}>{(id) => <input id={id} className="input" value={f[k]} placeholder={placeholder} onChange={(e) => ctx.set(k, e.target.value)} />}</Field>
        );
        const impacts = [...IMPACT_PRESETS, ...f.impacts.filter((i) => !IMPACT_PRESETS.includes(i))];
        return (
          <>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="space-y-4 p-5">
                {area('purpose', 'Mục đích', undefined, 'Cho agent tra cứu và tạo đơn bán hàng…')}
                {area('sampleTasks', 'Tác vụ mẫu', 'Mỗi dòng là một tác vụ, dùng cho Agent task evaluation (Codex làm thử bằng MCP tool). Thêm "=> tên_tool" ở cuối dòng để chấm cả việc chọn đúng tool.', '- Tra các đơn Draft của khách C0042 => search_sales_orders', true)}
                {area('businessRules', 'Điều kiện nghiệp vụ', undefined, 'Chỉ đơn ở trạng thái Draft được chỉnh sửa.')}
                {line('expectedResults', 'Kỳ vọng kết quả', undefined, 'Sau khi tạo đơn trả mã đơn và trạng thái.')}
              </Card>
              <Card className="space-y-4 p-5">
                {line('dataFormats', 'Định dạng dữ liệu', undefined, 'VND số nguyên · Asia/Ho_Chi_Minh')}
                {line('accessScope', 'Phạm vi truy cập', 'Mô tả quyền không có nghĩa là quyền đã được thực thi. Kiểm soát quyền vẫn nằm ở runtime và hệ thống đích.')}
                <div>
                  <div className="label">Tác động</div>
                  <div className="flex flex-wrap gap-2">
                    {impacts.map((t) => {
                      const on = f.impacts.includes(t);
                      return (
                        <button key={t} type="button" aria-pressed={on} onClick={() => ctx.set('impacts', on ? f.impacts.filter((x) => x !== t) : [...f.impacts, t])}
                          className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors', on ? 'border-brand/50 bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-muted')}>
                          {on ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}{t}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {area('freeform', 'Mô tả tự do')}
                <div className="alert alert-info"><Info className="mt-0.5 size-4 shrink-0 text-info" /><div>Hệ thống không tự đoán endpoint, trường dữ liệu hay quy tắc chưa được cung cấp. Chỗ còn thiếu sẽ được báo trong tab Mâu thuẫn.</div></div>
              </Card>
            </div>
            <SaveBar ctx={ctx} />
          </>
        );
      }}
    </Loaded>
  );
}

function GlossaryTab({ ctx }: { ctx: CtxForm }) {
  return (
    <Loaded q={ctx.q}>
      {() => {
        const f = ctx.form;
        if (!f) return null;
        const rows = f.glossary;
        const update = (i: number, k: 'term' | 'meaning' | 'mapping', v: string) => ctx.set('glossary', rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
        return (
          <>
            <Card className="overflow-hidden">
              <CardHeader title="Thuật ngữ" description="Ánh xạ thuật ngữ nghiệp vụ sang trường trong spec" actions={
                <button className="btn btn-outline btn-sm" onClick={() => ctx.set('glossary', [...rows, { term: '', meaning: '', mapping: '' }])}><Plus className="size-3.5" />Thêm</button>
              } />
              {rows.length === 0 ? <EmptyState title="Chưa có thuật ngữ" description="VD: customerCode là mã khách ERP, khác id nội bộ." /> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Thuật ngữ</th><th>Nghĩa</th><th>Ánh xạ trong spec</th><th className="w-12"><span className="sr-only">Xóa</span></th></tr></thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i}>
                          <td><input className="input h-8 font-mono text-xs" value={r.term} onChange={(e) => update(i, 'term', e.target.value)} aria-label="Thuật ngữ" /></td>
                          <td><input className="input h-8" value={r.meaning} onChange={(e) => update(i, 'meaning', e.target.value)} aria-label="Nghĩa" /></td>
                          <td><input className="input h-8 font-mono text-xs" value={r.mapping} placeholder="Customer.code · ?customer" onChange={(e) => update(i, 'mapping', e.target.value)} aria-label="Ánh xạ trong spec" /></td>
                          <td><button className="btn btn-ghost btn-icon size-8" aria-label="Xóa thuật ngữ" onClick={() => ctx.set('glossary', rows.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <SaveBar ctx={ctx} />
          </>
        );
      }}
    </Loaded>
  );
}
