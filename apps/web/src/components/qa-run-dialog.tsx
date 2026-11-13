'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FlaskConical } from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { InlineError, Modal, Spinner } from './ui';
import { useToast } from './toast';

/** Standalone QA run on an existing build's generated code (Codex step skipped). */
export function QaRunDialog({ open, onClose, projectId, buildId, buildLabel }: { open: boolean; onClose: () => void; projectId: string; buildId: string; buildLabel: string }) {
  const router = useRouter();
  const toast = useToast();
  const conns = useApi(() => (open ? api.connections(projectId) : Promise.resolve(null)), [projectId, open]);
  const qaConn = conns.data?.find((c) => c.useForQa) ?? null;
  const [runIntegration, setRunIntegration] = useState(false);
  const [runAgentEval, setRunAgentEval] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { setRunIntegration(!!qaConn); }, [qaConn]);
  useEffect(() => { if (open) setErr(null); }, [open]);

  async function start() {
    setBusy(true); setErr(null);
    try {
      const run = await api.qaRun(buildId, { runIntegration, runAgentEval });
      toast(`Queued QA run ${run.label}`);
      onClose();
      router.push(`/projects/${projectId}/builds/${run.id}`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Run QA on ${buildLabel}`}
      description="Reuses this build's generated code and skips Codex generation. The current custom test cases are run."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy} onClick={start}>{busy ? <Spinner /> : <FlaskConical className="size-4" />}Run QA</button>
      </>}>
      <div className="space-y-3">
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" checked={runIntegration} disabled={!qaConn} onChange={(e) => setRunIntegration(e.target.checked)} />
          <span className="text-sm">Run integration tests{qaConn && <> on env <b className="mono">{qaConn.name}</b></>}
            <span className="block text-xs text-muted-foreground">{qaConn ? 'Calls the live API; test cases targeting "live" need this' : 'Add a “Use for QA” connection to enable'}</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 hover:bg-muted/40">
          <input type="checkbox" className="mt-0.5 size-4 accent-[var(--brand)]" checked={runAgentEval} onChange={(e) => setRunAgentEval(e.target.checked)} />
          <span className="text-sm">Run agent task evaluation
            <span className="block text-xs text-muted-foreground">Codex uses the MCP tools on sample tasks and agent-task test cases (uses tokens)</span>
          </span>
        </label>
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
