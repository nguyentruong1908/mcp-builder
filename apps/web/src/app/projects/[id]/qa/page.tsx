'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Bot, CircleDashed, CircleX, Download, FlaskConical, ListChecks, Lock, PackageCheck, PackageX, Plug, Scale, ShieldCheck } from 'lucide-react';
import type { QaLayer, QaReport } from '@mcp-factory/shared';
import { absUrl, api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, fmtDate, isActive, LAYERS, layerMeta, qaMeta, verdictMeta } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Loaded, PageHeader, Tabs } from '@/components/ui';
import { BuildBadges } from '@/components/build-badges';
import { QaRunDialog } from '@/components/qa-run-dialog';
import { TestCases } from './test-cases';

export default function QaPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const buildParam = useSearchParams().get('build');
  const builds = useApi(() => api.builds(id), [id]);
  const withQa = (builds.data ?? []).filter((b) => b.stages.qa !== 'idle');
  const selected = buildParam ?? withQa[0]?.id ?? null;
  const [tab, setTab] = useState<'report' | 'cases'>('report');
  const [qaOpen, setQaOpen] = useState(false);
  const sel = builds.data?.find((b) => b.id === selected);
  // A QA run re-uses its source build's code, so re-running it targets the source.
  const codeBuild = sel?.kind === 'qa' && sel.sourceBuildId ? { id: sel.sourceBuildId, label: sel.sourceBuildLabel ?? sel.sourceBuildId } : sel ? { id: sel.id, label: sel.label } : null;
  const running = builds.data?.some((b) => isActive(b.status)) ?? false;

  return (
    <>
      <PageHeader title="QA report" description="Kết luận dựa trên test thực sự chạy, không dựa trên báo cáo do model viết."
        actions={withQa.length > 0 && <>
          <button className="btn btn-primary btn-sm" disabled={!codeBuild || running || sel?.stages.build !== 'ok'}
            title={running ? 'Đang có build chạy' : sel?.stages.build !== 'ok' ? 'Build được chọn chưa có code đã biên dịch' : undefined}
            onClick={() => setQaOpen(true)}><FlaskConical className="size-3.5" />Chạy QA</button>
          <select className="input h-8 w-auto text-xs" aria-label="Chọn build" value={selected ?? ''} onChange={(e) => router.replace(`/projects/${id}/qa?build=${e.target.value}`)}>
            {buildParam && !withQa.some((b) => b.id === buildParam) && <option value={buildParam}>{buildParam}</option>}
            {withQa.map((b) => <option key={b.id} value={b.id}>{b.label}{b.kind === 'qa' ? ' (QA run)' : ''} · {b.versionNumber} · {fmtDate(b.createdAt)}</option>)}
          </select>
        </>} />
      {codeBuild && <QaRunDialog open={qaOpen} onClose={() => setQaOpen(false)} projectId={id} buildId={codeBuild.id} buildLabel={codeBuild.label} />}
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={[
        { id: 'report', label: <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5" />Report</span> },
        { id: 'cases', label: <span className="inline-flex items-center gap-1.5"><ListChecks className="size-3.5" />Test case</span> },
      ]} />
      {tab === 'cases' ? <TestCases projectId={id} /> : (
        <Loaded q={builds}>
          {() => !selected ? (
            <Card><EmptyState icon={<ShieldCheck className="size-5" />} title="Chưa có QA report" description="QA chạy trong mỗi lần Export. Bấm Export ở góc trên để tạo build." /></Card>
          ) : <Report buildId={selected} onOpenTests={() => setTab('cases')} />}
        </Loaded>
      )}
    </>
  );
}

function Report({ buildId, onOpenTests }: { buildId: string; onOpenTests: () => void }) {
  const q = useApi(() => Promise.all([api.qa(buildId), api.build(buildId)]), [buildId]);
  return (
    <Loaded q={q}>
      {([r, detail]) => {
        const qaArtifact = detail.artifacts.find((a) => a.kind === 'qa_report');
        return (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              Build <Link href={`/projects/${r.build.projectId}/builds/${r.build.id}`} className="mono text-foreground hover:underline">{r.build.label}</Link> · {r.build.versionNumber}
              <BuildBadges b={r.build} />
              {qaArtifact && <a className="btn btn-outline btn-sm ml-auto" href={absUrl(qaArtifact.downloadUrl)} download><Download className="size-3.5" />qa-report.json</a>}
            </div>
            <Gates r={r} />
            <div className="alert alert-warning mt-4">
              <Scale className="mt-0.5 size-4 shrink-0 text-warning" />
              <div><b>Nguyên tắc:</b> mock pass không được ghi thành integration pass. Thiếu credential hoặc môi trường thì ghi <code className="mono">NOT RUN</code>/<code className="mono">BLOCKED</code> kèm lý do. Không suy ra thao tác an toàn từ HTTP method.</div>
            </div>
            <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              <LayerTable r={r} />
              <Failures r={r} onOpenTests={onOpenTests} />
            </div>
            <CustomResults r={r} />
            <AgentEval r={r} />
            <Matrix r={r} />
          </>
        );
      }}
    </Loaded>
  );
}

function Gates({ r }: { r: QaReport }) {
  const pv = r.build.packageVerified;
  const iv = r.build.integrationVerified;
  const pkgFails = r.results.filter((x) => x.status === 'fail' && ['input', 'build', 'interface', 'contract', 'error', 'custom', 'install'].includes(x.layer)).length;
  const intRows = r.results.filter((x) => x.layer === 'integration');
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className={cn('card p-5', pv === false && 'border-danger/40')}>
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">Package verified{pv ? <PackageCheck className="size-4 text-success" /> : <PackageX className={cn('size-4', pv === false && 'text-danger')} />}</div>
        <div className={cn('mt-2 text-lg font-semibold', pv ? 'text-success' : pv === false ? 'text-danger' : '')}>{pv ? 'Đạt' : pv === false ? 'Không đạt' : 'Chưa kết luận'}</div>
        <p className="mt-1 text-xs text-muted-foreground">{pkgFails ? `${pkgFails} test bắt buộc fail` : 'Input, build, interface, contract, error, test case, install'}</p>
      </div>
      <div className="card p-5">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">Integration verified<Plug className="size-4" /></div>
        <div className={cn('mt-2 text-lg font-semibold', iv && { yes: 'text-success', partial: 'text-warning', no: 'text-danger', not_run: 'text-muted-foreground' }[iv])}>{iv ? verdictMeta[iv].label.replace('Integration ', '') : 'Chưa kết luận'}</div>
        <p className="mt-1 text-xs text-muted-foreground">{intRows.filter((x) => x.status === 'pass').length}/{intRows.length} kết quả pass · {intRows.filter((x) => x.status === 'blocked' || x.status === 'not_run').length} blocked/not run</p>
      </div>
      <div className="card p-5">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">Release gate<Lock className="size-4" /></div>
        <div className="mt-2 text-lg font-semibold">{pv ? 'Có thể release' : 'Bản nháp, chưa Ready'}</div>
        <p className="mt-1 text-xs text-muted-foreground">Cần Package verified · mọi tool có trạng thái coverage · không có secret trong artifact</p>
      </div>
    </div>
  );
}

function LayerTable({ r }: { r: QaReport }) {
  const rows = LAYERS.map((l) => r.layers.find((x) => x.layer === l) ?? { layer: l, pass: 0, fail: 0, blocked: 0, notRun: 0 });
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Theo lớp kiểm thử" description="P / F / Blocked / Not run" />
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Lớp</th><th className="w-[34%]">Kết quả</th><th className="text-right">P / F / B / NR</th></tr></thead>
          <tbody>
            {rows.map((l) => {
              const total = l.pass + l.fail + l.blocked + l.notRun || 1;
              return (
                <tr key={l.layer}>
                  <td><div className="font-medium">{layerMeta[l.layer].label}</div><div className="text-xs text-muted-foreground">{layerMeta[l.layer].description}</div></td>
                  <td>
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
                      <span className="bg-success" style={{ width: `${(l.pass / total) * 100}%` }} />
                      <span className="bg-danger" style={{ width: `${(l.fail / total) * 100}%` }} />
                      <span className="bg-warning" style={{ width: `${(l.blocked / total) * 100}%` }} />
                      <span className="bg-muted-foreground/40" style={{ width: `${(l.notRun / total) * 100}%` }} />
                    </div>
                  </td>
                  <td className="whitespace-nowrap text-right font-mono text-xs tabular-nums">
                    <span className="text-success">{l.pass}</span> / <span className={l.fail ? 'font-semibold text-danger' : 'text-muted-foreground'}>{l.fail}</span> / <span className={l.blocked ? 'text-warning' : 'text-muted-foreground'}>{l.blocked}</span> / <span className="text-muted-foreground">{l.notRun}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Failures need fixing; blocked / not-run items are coverage gaps with a reason, shown neutrally. */
function Failures({ r, onOpenTests }: { r: QaReport; onOpenTests: () => void }) {
  const fails = r.results.filter((x) => x.status === 'fail');
  const pending = r.results.filter((x) => x.status === 'blocked' || x.status === 'not_run');
  return (
    <Card>
      <CardHeader title="Lỗi cần sửa" actions={<Badge tone={fails.length ? 'danger' : 'success'}>{fails.length ? `${fails.length} fail` : 'Không có lỗi'}</Badge>} />
      <div className="max-h-[620px] overflow-y-auto px-5 pb-5">
        {fails.length === 0 && <p className="text-sm text-muted-foreground">Không có kiểm thử nào thất bại.</p>}
        <div className="space-y-3">
          {fails.map((x) => (
            <div key={x.id} className="alert alert-danger">
              <CircleX className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-medium">
                  {layerMeta[x.layer].label}{x.tool && <span className="mono">· {x.tool}</span>}<Badge tone={qaMeta[x.status].tone}>{qaMeta[x.status].label}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">{x.name}</div>
                <p className="mt-1">{x.detail}</p>
                {x.evidence !== undefined && x.evidence !== null && (
                  <details className="mt-2">
                    <summary className="text-xs font-medium underline underline-offset-2">Bằng chứng (đã che dữ liệu nhạy cảm)</summary>
                    <pre className="code mt-2 max-h-60">{JSON.stringify(x.evidence, null, 2)}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
        {pending.length > 0 && (
          <div className={cn(fails.length > 0 && 'mt-5 border-t pt-4')}>
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">Chưa kiểm chứng</div>
              <Badge tone="outline">{pending.length} mục</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">Không phải lỗi: các kiểm thử này không chạy hoặc bị chặn có chủ đích. Mỗi mục ghi lý do và cách kiểm chứng nếu cần.</p>
            <ul className="mt-3 divide-y rounded-lg border">
              {pending.map((x) => (
                <li key={x.id} className="flex gap-3 px-3 py-2.5 text-sm">
                  <CircleDashed className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{layerMeta[x.layer].label}</span>
                      {x.tool && <span className="mono text-xs">{x.tool}</span>}
                      <Badge tone="outline">{qaMeta[x.status].label}</Badge>
                    </div>
                    {x.name !== 'API thật' && x.name !== 'Agent task evaluation' && <div className="text-xs text-muted-foreground">{x.name}</div>}
                    <p className="mt-0.5 text-xs text-muted-foreground">{x.detail}</p>
                    <div className="mt-1.5 flex flex-wrap gap-2 empty:hidden">
                      {/test case/i.test(x.detail) && <button className="btn btn-outline btn-sm" onClick={onOpenTests}><ListChecks className="size-3.5" />Thêm test case</button>}
                      {/Connections/.test(x.detail) && <Link className="btn btn-outline btn-sm" href={`/projects/${r.build.projectId}/connections`}><Plug className="size-3.5" />Mở Connections</Link>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

function Matrix({ r }: { r: QaReport }) {
  const cols = LAYERS.filter((l) => r.matrix.some((m) => m.cells[l]));
  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader title="Ma trận coverage" description="Mỗi tool được chọn đều phải có trạng thái ở các lớp áp dụng"
        actions={<div className="hidden flex-wrap gap-1.5 sm:flex">{(['pass', 'fail', 'blocked', 'not_run'] as const).map((s) => <Badge key={s} tone={qaMeta[s].tone}>{qaMeta[s].label}</Badge>)}</div>} />
      {r.matrix.length === 0 ? <p className="px-5 pb-5 text-sm text-muted-foreground">Không có kết quả theo tool.</p> : (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Tool</th>{cols.map((c) => <th key={c} className="text-center">{layerMeta[c as QaLayer].short}</th>)}</tr></thead>
            <tbody>
              {r.matrix.map((m) => (
                <tr key={m.tool}>
                  <td className="mono">{m.tool}</td>
                  {cols.map((c) => {
                    const s = m.cells[c];
                    return <td key={c} className="text-center">{s ? <Badge tone={qaMeta[s].tone} className="min-w-[64px] justify-center">{qaMeta[s].label}</Badge> : <span className="text-xs text-muted-foreground">N/A</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

type AgentEvidence = { task: string; expected: string[]; env: string; calls?: { tool: string; args: unknown; ok: boolean; category?: string; text: string }[]; answer?: string; blockedReason?: string | null };

/** Per-task results of the Codex agent smoke test (rows with layer=agent and no tool). */
function AgentEval({ r }: { r: QaReport }) {
  const tasks = r.results.filter((x) => x.layer === 'agent' && x.tool === null);
  if (!tasks.length) return null;
  const env = (tasks.find((t) => t.evidence)?.evidence as AgentEvidence | undefined)?.env;
  return (
    <Card className="mt-4">
      <CardHeader title={<span className="inline-flex items-center gap-2"><Bot className="size-4" />Agent task evaluation</span>}
        description={`Codex dùng MCP tool vừa build để làm tác vụ mẫu${env ? ` · ${env}` : ''}. Chấm theo lệnh gọi tool thực tế.`} />
      <ul className="divide-y border-t">
        {tasks.map((t) => {
          const ev = t.evidence as AgentEvidence | undefined;
          return (
            <li key={t.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0 font-medium">{t.name}</div>
                <Badge tone={qaMeta[t.status].tone}>{qaMeta[t.status].label}</Badge>
              </div>
              {ev?.expected?.length ? <div className="mt-1 text-xs text-muted-foreground">Mong đợi: <span className="mono">{ev.expected.join(', ')}</span></div> : null}
              {ev?.calls?.length ? (
                <ol className="mt-2 space-y-1">
                  {ev.calls.map((c, i) => (
                    <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className={cn('mono font-semibold', c.ok ? 'text-success' : 'text-danger')}>{i + 1}. {c.tool}</span>
                      <code className="mono break-all text-muted-foreground">{typeof c.args === 'string' ? c.args : JSON.stringify(c.args)}</code>
                      {!c.ok && <Badge tone="danger">{c.category ?? 'lỗi'}</Badge>}
                    </li>
                  ))}
                </ol>
              ) : null}
              {ev?.answer ? <p className="mt-2 rounded-md bg-muted/50 px-3 py-2 text-sm">{ev.answer}</p> : null}
              {t.status !== 'pass' && <p className="mt-2 text-xs text-muted-foreground">{t.detail}</p>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

type CustomEvidence = { args?: unknown; target?: string; result?: unknown; expect?: unknown };

/** Results of user-defined tool_call test cases (layer=custom). */
function CustomResults({ r }: { r: QaReport }) {
  const rows = r.results.filter((x) => x.layer === 'custom');
  if (!rows.length) return null;
  return (
    <Card className="mt-4">
      <CardHeader title={<span className="inline-flex items-center gap-2"><ListChecks className="size-4" />Test case tùy chỉnh</span>}
        description={`${rows.filter((x) => x.status === 'pass').length}/${rows.length} pass · quản lý ở tab Test case`} />
      <ul className="divide-y border-t">
        {rows.map((t) => {
          const ev = (t.evidence ?? {}) as CustomEvidence;
          return (
            <li key={t.id} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium">{t.name}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {t.tool && <span className="mono">{t.tool}</span>}{ev.target && <> · {ev.target === 'live' ? 'API thật' : 'Mock'}</>}
                  </div>
                </div>
                <Badge tone={qaMeta[t.status].tone}>{qaMeta[t.status].label}</Badge>
              </div>
              {ev.args !== undefined && <code className="mono mt-2 block break-all text-xs text-muted-foreground">{typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args)}</code>}
              {t.detail && <p className="mt-2 text-sm">{t.detail}</p>}
              {(ev.result !== undefined || ev.expect !== undefined) && (
                <details className="mt-2">
                  <summary className="text-xs font-medium underline underline-offset-2">Kết quả và kỳ vọng</summary>
                  <pre className="code mt-2 max-h-60">{JSON.stringify({ expect: ev.expect, result: ev.result }, null, 2)}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
