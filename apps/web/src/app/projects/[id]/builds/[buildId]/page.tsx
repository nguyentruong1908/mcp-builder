'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CircleCheck, CircleDashed, CircleMinus, CircleX, Download, FileCheck2, FileJson, FlaskConical, Loader2, Package, Rocket, Square } from 'lucide-react';
import type { BuildEvent, BuildLogDto, StageState } from '@mcp-builder/shared';
import { absUrl, api, buildEventsUrl } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, fmtBytes, fmtDate, fmtDuration, fmtNum, fmtUsd, isActive, shortHash, STAGES, stageLabel } from '@/lib/utils';
import { Card, CardHeader, InlineError, Loaded, PageHeader, Spinner } from '@/components/ui';
import { BuildBadges } from '@/components/build-badges';
import { EffectiveGenerationSummary } from '@/components/project-generation';
import { useToast } from '@/components/toast';
import { QaRunDialog } from '@/components/qa-run-dialog';
import { DeployDialog } from '@/components/deploy-dialog';

const stageIcon: Record<StageState, ReactNode> = {
  ok: <CircleCheck className="size-4 text-success" />,
  failed: <CircleX className="size-4 text-danger" />,
  running: <Loader2 className="size-4 animate-spin text-brand" />,
  idle: <CircleDashed className="size-4 text-muted-foreground" />,
  skipped: <CircleMinus className="size-4 text-muted-foreground" />,
};
const logCls: Record<BuildLogDto['level'], string> = { info: 'text-zinc-300', success: 'text-emerald-400', warn: 'text-amber-300', error: 'text-red-400' };
const artifactIcon = { mcp_package: Package, qa_report: FileCheck2, provenance: FileJson };

export default function BuildDetailPage() {
  const { id, buildId } = useParams<{ id: string; buildId: string }>();
  const toast = useToast();
  const b = useApi(() => api.build(buildId), [buildId]);
  const [logs, setLogs] = useState<BuildLogDto[]>([]);
  const [polling, setPolling] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [cancelling, setCancelling] = useState(false);
  const [qaOpen, setQaOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const active = b.data ? isActive(b.data.status) : false;
  const wasActive = useRef(false);
  const lastId = useRef(0);
  useEffect(() => { lastId.current = logs.at(-1)?.id ?? 0; }, [logs]);

  const addLogs = (incoming: BuildLogDto[]) => setLogs((prev) => {
    const seen = new Set(prev.map((l) => l.id));
    const fresh = incoming.filter((l) => !seen.has(l.id));
    return fresh.length ? [...prev, ...fresh].sort((x, y) => x.id - y.id) : prev;
  });

  // Initial logs + live events over SSE; fall back to polling if the stream fails.
  useEffect(() => {
    setLogs([]); setPolling(false);
    let closed = false;
    api.buildLogs(buildId, 0).then(addLogs).catch(() => {});
    const es = new EventSource(buildEventsUrl(buildId));
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data) as BuildEvent;
        if (ev.type === 'log') addLogs([ev.log]);
        else if (ev.type === 'build') {
          b.setData((prev) => (prev ? { ...prev, ...ev.build } : prev));
          // Finished build: logs come from REST, so no need to keep a stream open.
          if (!isActive(ev.build.status)) { closed = true; es.close(); }
        }
      } catch { /* ignore malformed event */ }
    };
    es.onerror = () => { es.close(); if (!closed) setPolling(true); };
    return () => { closed = true; es.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId]);

  useEffect(() => {
    if (!polling || !active) return;
    const t = setInterval(() => {
      api.buildLogs(buildId, lastId.current).then(addLogs).catch(() => {});
      b.refetch();
    }, 2000);
    return () => clearInterval(t);
  }, [polling, active, buildId, b.refetch]);

  // Refetch full detail (artifacts, provenance) once the build finishes.
  useEffect(() => {
    if (wasActive.current && !active) {
      b.refetch();
      window.dispatchEvent(new Event('mf:refresh')); // header "Exporting…" + sidebar
    }
    wasActive.current = active;
  }, [active, b.refetch]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [logs.length]);

  async function cancel() {
    setCancelling(true);
    try { await api.cancelBuild(buildId); toast('Cancellation requested'); b.refetch(); }
    catch (e) { toast((e as Error).message, 'error'); } finally { setCancelling(false); }
  }

  return (
    <Loaded q={b}>
      {(d) => {
        const duration = d.durationMs ?? (d.startedAt ? now - new Date(d.startedAt).getTime() : null);
        return (
          <>
            <PageHeader
              title={<span className="flex flex-wrap items-center gap-3"><span className="mono">{d.label}</span><span className="text-muted-foreground">·</span><span className="mono">{d.versionNumber}</span></span>}
              description={<span className="flex flex-wrap items-center gap-2">Created {fmtDate(d.createdAt)} by {d.triggeredBy}<BuildBadges b={d} />{d.kind === 'qa' && d.sourceBuildId && <span>on the code of <Link href={`/projects/${id}/builds/${d.sourceBuildId}`} className="mono text-foreground hover:underline">{d.sourceBuildLabel}</Link></span>}</span>}
              actions={<>
                <button className="btn btn-danger btn-sm" disabled={!active || cancelling} onClick={cancel}>{cancelling ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />}Cancel job</button>
                <button className="btn btn-outline btn-sm" disabled={active || d.stages.build !== 'ok'} title={d.stages.build === 'ok' ? undefined : 'This build has no compiled code'} onClick={() => setQaOpen(true)}><FlaskConical className="size-3.5" />Re-run QA</button>
                <Link className="btn btn-outline btn-sm" href={`/projects/${id}/qa?build=${d.id}`}>QA report</Link>
                {d.packageVerified && d.stages.package === 'ok' && <button className="btn btn-outline btn-sm" onClick={() => setDeployOpen(true)}><Rocket className="size-3.5" />Deploy</button>}
              </>}
            />
            <DeployDialog open={deployOpen} onClose={() => setDeployOpen(false)} projectId={id} buildId={d.id} />
            <QaRunDialog open={qaOpen} onClose={() => setQaOpen(false)} projectId={id} buildId={d.kind === 'qa' && d.sourceBuildId ? d.sourceBuildId : d.id} buildLabel={d.kind === 'qa' && d.sourceBuildLabel ? d.sourceBuildLabel : d.label} />
            {d.error && <div className="mb-4"><InlineError error={d.error} /></div>}

            <Card>
              <div className="grid grid-cols-1 gap-px overflow-hidden rounded-t-lg bg-border sm:grid-cols-5">
                {STAGES.map((s, i) => {
                  const st = d.stages[s];
                  return (
                    <div key={s} className="bg-card p-4">
                      <div className="flex items-center gap-2">{stageIcon[st]}<span className="text-xs font-medium text-muted-foreground">Step {i + 1}{st === 'skipped' && ' · Skipped'}</span></div>
                      <div className="mt-1.5 text-sm font-medium">{stageLabel[s]}</div>
                      <div className="progress mt-3">
                        <span className={cn(st === 'ok' && 'bg-success', st === 'failed' && 'bg-danger', st === 'skipped' && 'bg-muted-foreground/40')}
                          style={{ width: st === 'idle' ? '0%' : st === 'running' ? '55%' : '100%' }} />
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="grid grid-cols-1 border-t xl:grid-cols-[1fr_340px]">
                <div className="min-w-0 p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">Log · secrets masked</span>
                    <span className="kbd">{active ? (polling ? 'polling' : 'live') : 'ended'}</span>
                  </div>
                  <div className="overflow-hidden rounded-lg border border-white/5 bg-[#0b0c0f]">
                    <div className="flex items-center gap-1.5 border-b border-white/5 px-3 py-2">
                      <span className="size-2.5 rounded-full bg-zinc-700" /><span className="size-2.5 rounded-full bg-zinc-700" /><span className="size-2.5 rounded-full bg-zinc-700" />
                      <span className="ml-2 font-mono text-[11px] text-zinc-500">{d.label}.log</span>
                    </div>
                    <div ref={logRef} className="h-[360px] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed" aria-live="polite">
                      {logs.length === 0 && <div className="text-zinc-500">{active ? 'Waiting for logs…' : 'No logs.'}</div>}
                      {logs.map((l) => (
                        <div key={l.id} className="whitespace-pre-wrap break-words">
                          <span className="text-zinc-600">{new Date(l.ts).toLocaleTimeString('en-GB', { hour12: false })}</span>{' '}
                          <span className="text-zinc-500">[{l.stage}]</span>{' '}
                          <span className={logCls[l.level]}>{l.message}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="border-t p-5 xl:border-l xl:border-t-0">
                  <div className="mb-3 text-xs font-medium text-muted-foreground">Metrics</div>
                  <dl className="kv">
                    <dt>Duration</dt><dd className="tabular-nums">{fmtDuration(duration)}</dd>
                    <dt>Codex cost</dt><dd className="tabular-nums">{fmtUsd(d.costUsd)} <span className="text-muted-foreground">/ cap {fmtUsd(d.limits.maxCostUsd)}</span></dd>
                    <dt>Token</dt><dd className="text-xs tabular-nums">in {fmtNum(d.tokens.input)} · cache {fmtNum(d.tokens.cachedInput)} · out {fmtNum(d.tokens.output)}</dd>
                    <dt>Build repair rounds</dt><dd>{d.repairRounds} / {d.limits.maxRepairRounds}</dd>
                    <dt>QA repair rounds</dt><dd>{d.qaRepairRounds ?? 0} / {d.limits.maxQaRepairRounds ?? 0}</dd>
                    <dt>Timeout</dt><dd>{d.limits.timeoutMin} min</dd>
                  </dl>
                  <div className="mb-3 mt-6 text-xs font-medium text-muted-foreground">Generation profile</div>
                  {d.generation ? (
                    <>
                      <EffectiveGenerationSummary g={d.generation} />
                      {d.generation.rules.trim() && (
                        <details className="mt-3 rounded-md border px-3 py-2">
                          <summary className="cursor-pointer text-xs font-medium">Build AGENTS.md</summary>
                          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{d.generation.rules}</pre>
                        </details>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground">{d.kind === 'qa' && d.sourceBuildLabel ? `Reuses the code of ${d.sourceBuildLabel}` : 'No information (older build)'}</p>
                  )}
                  {Object.keys(d.provenance).length > 0 && <>
                    <div className="mb-3 mt-6 text-xs font-medium text-muted-foreground">Provenance</div>
                    <dl className="kv text-xs">
                      {Object.entries(d.provenance).map(([k, v]) => <div key={k} className="contents"><dt>{k}</dt><dd className="mono break-all">{v}</dd></div>)}
                    </dl>
                  </>}
                </div>
              </div>
            </Card>

            <Card className="mt-4">
              <CardHeader title="Artifacts" description="Package, QA report and provenance with checksums" />
              <div className="space-y-2 px-5 pb-5">
                {d.artifacts.length === 0 && <p className="text-sm text-muted-foreground">{active ? 'Artifacts appear after the Package stage.' : 'This build produced no artifacts.'}</p>}
                {d.artifacts.map((a) => {
                  const Icon = artifactIcon[a.kind] ?? Package;
                  return (
                    <div key={a.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <span className="flex size-8 items-center justify-center rounded-md bg-muted"><Icon className="size-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{a.filename}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground" title={a.sha256}>sha256:{shortHash(a.sha256)} · {fmtBytes(a.size)}</div>
                      </div>
                      <a className="btn btn-outline btn-sm" href={absUrl(a.downloadUrl)} download><Download className="size-3.5" />Download</a>
                    </div>
                  );
                })}
              </div>
            </Card>
          </>
        );
      }}
    </Loaded>
  );
}
