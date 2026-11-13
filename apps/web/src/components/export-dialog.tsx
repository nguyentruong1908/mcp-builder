'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Play, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { InlineError, LoadingBlock, Modal, Spinner, ErrorState } from './ui';
import { useToast } from './toast';

export function ExportDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const q = useApi(async () => {
    if (!open) return null;
    const [project, tools, connections, conflicts, settings, codex, generation] = await Promise.all([
      api.project(projectId), api.tools(projectId), api.connections(projectId), api.conflicts(projectId), api.settings(), api.codexAuth(),
      api.projectGeneration(projectId).catch(() => null),
    ]);
    return { project, tools, connections, conflicts, settings, codex, generation };
  }, [projectId, open]);

  const qaConn = q.data?.connections.find((c) => c.useForQa) ?? null;
  const [runIntegration, setRunIntegration] = useState(false);
  const [runAgentEval, setRunAgentEval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setRunIntegration(!!qaConn?.secretResolvable || qaConn?.authType === 'none'); }, [qaConn]);
  useEffect(() => { if (open) setErr(null); }, [open]);

  const d = q.data;
  const selected = d?.tools.filter((t) => t.selected) ?? [];
  const selectedUnsupported = selected.filter((t) => t.unsupportedReason);
  const outputs = d ? [d.project.outputs.mcp && 'MCP', d.project.outputs.cli && 'CLI'].filter(Boolean).join(' · ') : '';
  const canStart = !!d && d.codex.configured && selected.length > 0 && selectedUnsupported.length === 0 && !!outputs && !busy;

  async function start() {
    setBusy(true); setErr(null);
    try {
      const build = await api.createBuild(projectId, { runIntegration, runAgentEval });
      toast(`Queued ${build.label}`);
      onClose();
      router.push(`/projects/${projectId}/builds/${build.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={d ? `Export ${d.project.name}` : 'Export'}
      description="Runs generation, build, testing and packaging as a background job."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!canStart} onClick={start}>
          {busy ? <Spinner /> : <Play className="size-4" />} Start export
        </button>
      </>}
    >
      {!d ? (q.error ? <ErrorState error={q.error} onRetry={q.refetch} /> : <LoadingBlock />) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <SummaryBox label="Scope" value={`${selected.length} tools`} sub={`${d.tools.length} operations in the spec`} />
            <SummaryBox label="Outputs" value={outputs || 'None selected'} sub="Node.js · npm" />
            <SummaryBox label="QA environment" value={qaConn ? <span className="mono">{qaConn.name}</span> : 'Not configured'} sub={qaConn ? `${qaConn.authType} · ${qaConn.secretResolvable ? 'secret ready' : 'secret missing'}` : 'Integration will be NOT RUN'} />
            <SummaryBox label="Limits" value={`$${d.settings.maxCostUsdPerBuild} · ${d.settings.maxRepairRounds} repair rounds`} sub={`timeout ${d.settings.buildTimeoutMin} min · ${d.generation ? `${d.generation.effective.model} · reasoning ${d.generation.effective.reasoningEffort ?? 'default'}` : d.settings.codexModel}`} />
          </div>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" checked={runIntegration} disabled={!qaConn} onChange={(e) => setRunIntegration(e.target.checked)} />
            <span className="text-sm">Run integration tests{qaConn && <> on env <b className="mono">{qaConn.name}</b></>}
              <span className="block text-xs text-muted-foreground">{qaConn ? (qaConn.allowWrite ? 'Write tools are verified through live test cases' : 'Read tools only; write tools will be BLOCKED') : 'Add a “Use for QA” connection to enable'}</span>
            </span>
          </label>
          {!d.codex.configured && (
            <div className="alert alert-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div>Codex is not signed in, so builds cannot generate code. <Link href="/settings" className="font-medium underline underline-offset-2" onClick={onClose}>Sign in under Settings › Codex</Link></div>
            </div>
          )}
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
            <input type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" checked={runAgentEval} onChange={(e) => setRunAgentEval(e.target.checked)} />
            <span className="text-sm">Run agent task evaluation
              <span className="block text-xs text-muted-foreground">Codex uses the freshly built MCP tools on up to 5 sample tasks from the context (uses extra tokens)</span>
            </span>
          </label>
          {selected.length === 0 && <InlineError error="No tools selected. Pick endpoints in the Tool designer." />}
          {selectedUnsupported.length > 0 && <InlineError error={`${selectedUnsupported.length} unsupported tools are selected.`} />}
          {!outputs && <InlineError error="The project has no output selected (MCP / CLI)." />}
          {d.conflicts.length > 0 && (
            <div className="alert alert-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>{d.conflicts.length} conflicts remain between the context and the spec. You can still export; they are recorded in the QA report.</div>
            </div>
          )}
          <InlineError error={err} />
        </div>
      )}
    </Modal>
  );
}

function SummaryBox({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 font-medium">{value}</div>
      <div className="text-xs text-muted-foreground">{sub}</div>
    </div>
  );
}
