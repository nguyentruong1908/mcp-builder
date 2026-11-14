'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Rocket, TriangleAlert } from 'lucide-react';
import type { DeployResult } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate } from '@/lib/utils';
import { Field, InlineError, LoadingBlock, Modal, Spinner } from './ui';
import { useToast } from './toast';

/**
 * One-time handoff of a deploy/rotate result to the deploy page across client-side navigation.
 * In memory only: the token must never reach localStorage or the URL.
 */
let pending: DeployResult | null = null;
export function takePendingDeployResult(deploymentId: string): DeployResult | null {
  const r = pending && pending.deployment.id === deploymentId ? pending : null;
  pending = null;
  return r;
}

/** Deploys a Package-verified build on the platform. Redeploying replaces the current deployment and keeps its URL. */
export function DeployDialog({ open, onClose, projectId, buildId, onDeployed }: {
  open: boolean; onClose: () => void; projectId: string; buildId?: string; onDeployed?: (r: DeployResult) => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const q = useApi(async () => {
    if (!open) return null;
    const [builds, connections, current] = await Promise.all([api.builds(projectId), api.connections(projectId), api.deployment(projectId)]);
    return { builds: builds.filter((b) => b.packageVerified === true && b.stages.package === 'ok'), connections, current };
  }, [projectId, open]);
  const [bid, setBid] = useState('');
  const [cid, setCid] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const d = q.data;
  useEffect(() => {
    if (!d) return;
    setBid((cur) => cur || (buildId && d.builds.some((b) => b.id === buildId) ? buildId : d.builds[0]?.id ?? ''));
    setCid((cur) => cur || (d.current?.connectionId ?? d.connections.find((c) => c.name === 'prod')?.id ?? d.connections[0]?.id ?? ''));
  }, [d, buildId]);
  useEffect(() => { if (open) setErr(null); else { setBid(''); setCid(''); } }, [open]);

  const conn = d?.connections.find((c) => c.id === cid);

  async function deploy() {
    setBusy(true); setErr(null);
    try {
      const r = await api.deploy(bid, { connectionId: cid });
      toast(r.token ? 'Deployed' : 'Redeployed: same URL and token');
      onClose();
      if (onDeployed) onDeployed(r);
      else { pending = r; router.push(`/projects/${projectId}/deploy`); }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={d?.current ? 'Redeploy' : 'Deploy a build'}
      description="Runs the packaged MCP server on this platform behind an authenticated endpoint. Optional: you can still download the package from Versions."
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !bid || !cid} onClick={deploy}>{busy ? <Spinner /> : <Rocket className="size-4" />}{d?.current ? 'Redeploy' : 'Deploy'}</button>
      </>}>
      {!d ? (q.error ? <InlineError error={q.error.message} /> : <LoadingBlock />) : (
        <div className="space-y-4">
          {d.builds.length === 0 ? (
            <InlineError error="No build is Package verified yet. Export and pass QA first." />
          ) : (
            <Field label="Build" hint="Only Package verified builds can be deployed.">
              {(id) => (
                <select id={id} className="input" value={bid} onChange={(e) => setBid(e.target.value)}>
                  {d.builds.map((b) => <option key={b.id} value={b.id}>{b.label} · {b.versionNumber} · {fmtDate(b.createdAt)}</option>)}
                </select>
              )}
            </Field>
          )}
          {d.connections.length === 0 ? (
            <div className="alert alert-warning"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div>Add an environment in <Link className="underline" href={`/projects/${projectId}/connections`}>Connections</Link> first: the deployed server needs a base URL and credentials for your API.</div></div>
          ) : (
            <Field label="Environment" hint="The server calls your API with this environment's credentials.">
              {(id) => (
                <select id={id} className="input" value={cid} onChange={(e) => setCid(e.target.value)}>
                  {d.connections.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.baseUrl}</option>)}
                </select>
              )}
            </Field>
          )}
          {conn && !conn.secretResolvable && (
            <div className="alert alert-warning"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div>The secret <code className="mono">{conn.secretRef}</code> is not set on the server, so calls to your API will fail authentication.</div></div>
          )}
          {d.current && (
            <p className="text-sm text-muted-foreground">Redeploying replaces <span className="mono">{d.current.buildLabel}</span> and keeps the same URL and token, so connected agents keep working.</p>
          )}
          <InlineError error={err} />
        </div>
      )}
    </Modal>
  );
}
