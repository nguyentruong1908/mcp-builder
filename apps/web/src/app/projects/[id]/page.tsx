'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Archive, Check, Download, Pencil, TriangleAlert, X } from 'lucide-react';
import type { ProjectDetail, StepState } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { buildStatusMeta, cn, fmtDate, initials, verdictMeta } from '@/lib/utils';
import { Badge, Card, CardHeader, Field, InlineError, Loaded, Modal, PageHeader, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/toast';
import { ProjectGenerationCard } from '@/components/project-generation';

const stepCls: Record<StepState, string> = {
  done: 'border-brand bg-brand text-brand-foreground',
  warn: 'border-warning/60 bg-warning-soft text-warning',
  fail: 'border-danger/60 bg-danger-soft text-danger',
  todo: 'bg-card text-muted-foreground',
};

export default function ProjectOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const q = useApi(() => api.project(id), [id]);
  const [editing, setEditing] = useState(false);

  async function archive(p: ProjectDetail) {
    if (!confirm(`Archive project “${p.name}”? Lịch sử được giữ nguyên; package đã tải không bị thu hồi.`)) return;
    try { await api.archiveProject(p.id); toast('Đã archive project'); router.push('/'); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <Loaded q={q}>
      {(p) => (
        <>
          <PageHeader
            title={
              <span className="flex flex-wrap items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-lg bg-info-soft text-sm font-bold text-info">{initials(p.name)}</span>
                {p.name}
                {p.currentRelease && <Badge tone="success">{p.currentRelease.number} released</Badge>}
                {p.latestDraft && <Badge>{p.latestDraft.number} nháp</Badge>}
                {p.archivedAt && <Badge tone="warning">Đã archive</Badge>}
              </span>
            }
            description={p.description || 'Chưa có mô tả.'}
            actions={<>
              <button className="btn btn-outline" onClick={() => setEditing(true)}><Pencil className="size-4" />Sửa</button>
              <button className="btn btn-danger" disabled={!!p.archivedAt} onClick={() => archive(p)}><Archive className="size-4" />Archive</button>
            </>}
          />

          <Card>
            <CardHeader title="Tiến trình" description="Từ tạo project đến phiên bản tiếp theo" />
            <div className="overflow-x-auto px-5 pb-5">
              <ol className="flex min-w-[880px] items-start">
                {p.steps.map((s, i) => (
                  <li key={s.key} className="flex flex-1 flex-col items-center text-center">
                    <div className="flex w-full items-center">
                      <div className={cn('h-px flex-1', i === 0 ? 'bg-transparent' : s.state === 'todo' ? 'bg-border' : 'bg-brand/50')} />
                      <div className={cn('flex size-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold', stepCls[s.state])}>
                        {s.state === 'done' ? <Check className="size-4" /> : s.state === 'warn' ? <TriangleAlert className="size-4" /> : s.state === 'fail' ? <X className="size-4" /> : i + 1}
                      </div>
                      <div className={cn('h-px flex-1', i === p.steps.length - 1 ? 'bg-transparent' : p.steps[i + 1].state === 'todo' ? 'bg-border' : 'bg-brand/50')} />
                    </div>
                    <div className="mt-2 px-1 text-xs font-medium">{s.label}</div>
                    {s.detail && <div className="text-[11px] text-muted-foreground">{s.detail}</div>}
                  </li>
                ))}
              </ol>
            </div>
          </Card>

          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Thông tin" />
              <dl className="kv px-5 pb-5">
                <dt>Owner</dt><dd>{p.owner || '—'}</dd>
                <dt>Slug</dt><dd className="mono">{p.slug}</dd>
                <dt>Nguồn API</dt><dd className="mono">{p.specSource ?? <Link href={`/projects/${p.id}/api`} className="text-brand hover:underline">Import Swagger</Link>}</dd>
                <dt>Tool</dt><dd>{p.selectedCount} được chọn / {p.toolCount} hỗ trợ</dd>
                <dt>Đầu ra</dt><dd className="flex flex-wrap gap-1">{p.outputs.mcp && <Badge>MCP</Badge>}{p.outputs.cli && <Badge>CLI</Badge>}{!p.outputs.mcp && !p.outputs.cli && '—'}</dd>
                <dt>Tạo lúc</dt><dd>{fmtDate(p.createdAt)}</dd>
              </dl>
            </Card>

            <Card>
              <CardHeader title="Release hiện tại" description={p.currentRelease ? `Released ${fmtDate(p.currentRelease.releasedAt)}` : undefined}
                actions={p.currentRelease && <span className="mono text-lg font-semibold">{p.currentRelease.number}</span>} />
              <div className="px-5 pb-5">
                {p.currentRelease ? (
                  <>
                    <dl className="kv"><dt>API version</dt><dd>{p.currentRelease.apiVersion || '—'}</dd></dl>
                    <Link href={`/projects/${p.id}/versions`} className="btn btn-outline btn-sm mt-4"><Download className="size-3.5" />Tải package</Link>
                  </>
                ) : <p className="text-sm text-muted-foreground">Chưa có bản release. Export và đạt Package verified để release.</p>}
              </div>
            </Card>

            <Card className={cn(p.latestBuild?.packageVerified === false && 'border-danger/40')}>
              <CardHeader title="Build mới nhất" description={p.latestBuild ? `${p.latestBuild.label} · ${fmtDate(p.latestBuild.createdAt)}` : undefined}
                actions={p.latestBuild && <span className="mono text-lg font-semibold">{p.latestBuild.versionNumber}</span>} />
              <div className="px-5 pb-5">
                {p.latestBuild ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge tone={buildStatusMeta[p.latestBuild.status].tone}>{buildStatusMeta[p.latestBuild.status].label}</Badge>
                      {p.latestBuild.packageVerified !== null && <Badge tone={p.latestBuild.packageVerified ? 'success' : 'danger'}>Package {p.latestBuild.packageVerified ? 'verified' : 'không đạt'}</Badge>}
                      {p.latestBuild.integrationVerified && <Badge tone={verdictMeta[p.latestBuild.integrationVerified].tone}>{verdictMeta[p.latestBuild.integrationVerified].label}</Badge>}
                    </div>
                    {p.latestBuild.error && <div className="mt-3"><InlineError error={p.latestBuild.error} /></div>}
                    <div className="mt-4 flex gap-2">
                      <Link className="btn btn-outline btn-sm" href={`/projects/${p.id}/qa?build=${p.latestBuild.id}`}>QA report</Link>
                      <Link className="btn btn-ghost btn-sm" href={`/projects/${p.id}/builds/${p.latestBuild.id}`}>Xem build</Link>
                    </div>
                  </>
                ) : <p className="text-sm text-muted-foreground">Chưa có build nào. Bấm Export ở góc trên khi đã chọn tool.</p>}
              </div>
            </Card>
          </div>

          <ProjectGenerationCard projectId={p.id} />

          <EditProject open={editing} project={p} onClose={() => setEditing(false)} onSaved={(np) => { q.setData(np); setEditing(false); toast('Đã lưu'); }} />
        </>
      )}
    </Loaded>
  );
}

function EditProject({ open, project, onClose, onSaved }: { open: boolean; project: ProjectDetail; onClose: () => void; onSaved: (p: ProjectDetail) => void }) {
  const [form, setForm] = useState({ name: project.name, description: project.description, owner: project.owner, outputs: project.outputs });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { onSaved(await api.updateProject(project.id, form)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open={open} onClose={onClose} title="Sửa project"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Hủy</button><button className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={save}>{busy && <Spinner />}Lưu</button></>}>
      <div className="space-y-4">
        <Field label="Tên">{(id) => <input id={id} className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Mô tả">{(id) => <textarea id={id} className="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        <Field label="Owner">{(id) => <input id={id} className="input" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />}</Field>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm"><Switch label="MCP" checked={form.outputs.mcp} onChange={(v) => setForm({ ...form, outputs: { ...form.outputs, mcp: v } })} />MCP</label>
          <label className="flex items-center gap-2 text-sm"><Switch label="CLI" checked={form.outputs.cli} onChange={(v) => setForm({ ...form, outputs: { ...form.outputs, cli: v } })} />CLI</label>
        </div>
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
