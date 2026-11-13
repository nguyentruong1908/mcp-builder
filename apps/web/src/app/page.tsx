'use client';

import Link from 'next/link';
import { Activity, Boxes, GitBranch, Plus, ShieldAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { buildStatusMeta, fmtDate, fmtUsd, initials, STAGES, stageLabel, verdictMeta, versionStatusMeta } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Loaded, PageHeader, Stat } from '@/components/ui';

export default function DashboardPage() {
  const q = useApi(() => api.dashboard(), []);
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Tổng quan các bộ tool cho AI agents trong workspace."
        actions={<Link href="/projects/new" className="btn btn-outline"><Plus className="size-4" />Tạo Tool Project</Link>}
      />
      <Loaded q={q}>
        {(d) => (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Stat label="Tool Projects" icon={<Boxes className="size-4" />} value={d.stats.projects} sub={`${d.stats.releasedProjects} project có bản release`} />
              <Stat label="Job đang chạy" icon={<Activity className="size-4" />} value={d.stats.runningBuilds} sub={d.running.map((b) => b.projectName).join(' · ') || 'Không có job nào'} />
              <Stat label="QA thất bại · 7 ngày" icon={<ShieldAlert className="size-4 text-danger" />} value={d.stats.failedQa7d} valueClass={d.stats.failedQa7d ? 'text-danger' : ''} sub="Build không đạt Package verified" />
              <Stat label="Phiên bản mới · 7 ngày" icon={<GitBranch className="size-4" />} value={d.stats.newVersions7d} sub={<><span className="text-success">{d.stats.integrationVerified7d}</span> Integration verified</>} />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
              <Card className="overflow-hidden xl:col-span-2">
                <CardHeader title="Tool Projects" description="Release hiện tại, build mới nhất và bản nháp" />
                {d.projects.length === 0 ? (
                  <EmptyState icon={<Boxes className="size-5" />} title="Chưa có project nào" description="Tạo project đầu tiên rồi import Swagger để bắt đầu."
                    action={<Link href="/projects/new" className="btn btn-primary btn-sm"><Plus className="size-3.5" />Tạo project</Link>} />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="tbl">
                      <thead><tr><th>Project</th><th>Owner</th><th>Release</th><th>Build mới nhất</th><th>Bản nháp</th></tr></thead>
                      <tbody>
                        {d.projects.map((p) => (
                          <tr key={p.id}>
                            <td>
                              <Link href={`/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link>
                              <div className="text-xs text-muted-foreground">{p.selectedCount}/{p.toolCount} tool · {[p.outputs.mcp && 'MCP', p.outputs.cli && 'CLI'].filter(Boolean).join(' + ') || '—'}</div>
                            </td>
                            <td>{p.owner ? <span className="avatar" title={p.owner}>{initials(p.owner)}</span> : <span className="text-muted-foreground">—</span>}</td>
                            <td className="mono">{p.currentRelease?.number ?? '—'}</td>
                            <td>
                              {p.latestBuild ? (
                                <div className="flex flex-wrap items-center gap-1">
                                  <Link href={`/projects/${p.id}/builds/${p.latestBuild.id}`} className="mono text-xs hover:underline">{p.latestBuild.label}</Link>
                                  <Badge tone={buildStatusMeta[p.latestBuild.status].tone}>{buildStatusMeta[p.latestBuild.status].label}</Badge>
                                  {p.latestBuild.packageVerified !== null && <Badge tone={p.latestBuild.packageVerified ? 'success' : 'danger'}>Package {p.latestBuild.packageVerified ? '✓' : '✗'}</Badge>}
                                  {p.latestBuild.integrationVerified && <Badge tone={verdictMeta[p.latestBuild.integrationVerified].tone}>{verdictMeta[p.latestBuild.integrationVerified].label}</Badge>}
                                </div>
                              ) : <span className="text-muted-foreground">Chưa build</span>}
                            </td>
                            <td>{p.latestDraft ? <Badge tone={versionStatusMeta.draft.tone}>{p.latestDraft.number}</Badge> : <span className="text-muted-foreground">—</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>

              <div className="flex flex-col gap-4">
                <Card>
                  <CardHeader title="Job đang chạy" actions={d.running.length > 0 && <Badge tone="info"><span className="size-1.5 animate-pulse rounded-full bg-info" />Live</Badge>} />
                  <div className="space-y-4 px-5 pb-5">
                    {d.running.length === 0 && <p className="text-sm text-muted-foreground">Không có job nào đang chạy.</p>}
                    {d.running.map((b) => {
                      const idx = b.stage ? STAGES.indexOf(b.stage) : 0;
                      const pct = Math.round(((idx + 0.5) / STAGES.length) * 100);
                      return (
                        <Link key={b.id} href={`/projects/${b.projectId}/builds/${b.id}`} className="block rounded-md hover:bg-muted/40">
                          <div className="flex items-center justify-between text-sm"><span className="font-medium">{b.projectName} · {b.versionNumber}</span><span className="mono text-xs text-muted-foreground">{b.label}</span></div>
                          <div className="mt-1 text-xs text-muted-foreground">{b.stage ? stageLabel[b.stage] : 'Đang chờ worker'}</div>
                          <div className="progress mt-2"><span style={{ width: `${pct}%` }} /></div>
                        </Link>
                      );
                    })}
                  </div>
                </Card>
                <Card>
                  <CardHeader title="Ngân sách tháng này" description="Chi phí Codex ước tính theo token" />
                  <div className="px-5 pb-5">
                    <div className="flex justify-between text-xs"><span className="text-muted-foreground">Codex generation</span><span className="tabular-nums"><b>{fmtUsd(d.budget.costUsdMonth)}</b> / {fmtUsd(d.budget.budgetUsdMonth)}</span></div>
                    <div className="progress mt-2"><span style={{ width: `${Math.min(100, (d.budget.costUsdMonth / Math.max(1, d.budget.budgetUsdMonth)) * 100)}%` }} /></div>
                  </div>
                </Card>
              </div>
            </div>

            <Card className="mt-4">
              <CardHeader title="Hoạt động gần đây" />
              {d.activity.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">Chưa có hoạt động.</p> : (
                <ol className="space-y-3 px-5 pb-5">
                  {d.activity.map((a) => (
                    <li key={a.id} className="flex gap-3">
                      <span className="avatar">{initials(a.actor)}</span>
                      <div className="min-w-0 pt-0.5">
                        <div className="text-sm"><b>{a.actor}</b> · <span className="badge badge-outline">{a.action}</span> <span className="mono">{a.target}</span></div>
                        <div className="text-xs text-muted-foreground">{fmtDate(a.at)}</div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </>
        )}
      </Loaded>
    </>
  );
}
