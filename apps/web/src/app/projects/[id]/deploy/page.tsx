'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Copy, KeyRound, Play, RefreshCw, Rocket, Square, Trash2, TriangleAlert } from 'lucide-react';
import type { DeployResult, DeploymentDto } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { copyText, deploymentStatusMeta, fmtDate, impactMeta } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, InlineError, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { DeployDialog, takePendingDeployResult } from '@/components/deploy-dialog';
import { useToast } from '@/components/toast';

export default function DeployPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useApi(() => api.deployment(id), [id]);
  const [dialog, setDialog] = useState(false);
  // The bearer token is only known right after deploy/rotate; kept in React state, never persisted.
  const [token, setToken] = useState<string | null>(null);
  const [redeployed, setRedeployed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dep = q.data;
  const { refetch, setData } = q;

  function applyResult(r: DeployResult) {
    setData(r.deployment);
    setToken(r.token);
    setRedeployed(r.token === null);
  }

  // Result handed over from a deploy started on another page (build detail, Versions).
  useEffect(() => {
    if (!dep) return;
    const r = takePendingDeployResult(dep.id);
    if (r) applyResult(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep?.id]);

  useEffect(() => {
    if (dep?.status !== 'starting') return;
    const t = setInterval(refetch, 3000);
    return () => clearInterval(t);
  }, [dep?.status, refetch]);

  async function act(kind: 'start' | 'stop' | 'rotate' | 'remove', d: DeploymentDto) {
    if (kind === 'rotate' && !confirm('Rotate the token? Agents using the current token will stop working until they get the new one.')) return;
    if (kind === 'remove' && !confirm(`Remove the deployment at ${d.url}? The endpoint stops working. Downloaded packages are not affected.`)) return;
    setBusy(kind); setErr(null);
    try {
      if (kind === 'start') setData(await api.startDeployment(d.id));
      if (kind === 'stop') setData(await api.stopDeployment(d.id));
      if (kind === 'rotate') { applyResult(await api.rotateDeploymentToken(d.id)); toast('New token issued'); }
      if (kind === 'remove') { await api.removeDeployment(d.id); setData(null); setToken(null); setRedeployed(false); toast('Deployment removed'); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Deploy" description="Optional: run the packaged MCP server on this platform, or download the package from Versions & Exports as before."
        actions={dep && <button className="btn btn-primary btn-sm" onClick={() => setDialog(true)}><Rocket className="size-3.5" />Redeploy</button>} />
      <Loaded q={q}>
        {(d) => !d ? (
          <Card>
            <EmptyState icon={<Rocket className="size-5" />} title="Not deployed"
              description="Deploying runs the packaged MCP server on this platform behind an authenticated HTTPS endpoint, so agents can connect without installing anything. It is optional: you can keep downloading the package from Versions & Exports."
              action={<button className="btn btn-primary" onClick={() => setDialog(true)}><Rocket className="size-4" />Deploy a build</button>} />
          </Card>
        ) : (
          <div className="space-y-4">
            {token && <TokenBox token={token} />}
            {redeployed && <div className="alert alert-info"><RefreshCw className="mt-0.5 size-4 shrink-0 text-info" /><div>Redeployed: same URL and token, so connected agents keep working.</div></div>}
            <InlineError error={err} />
            <DeploymentCard d={d} busy={busy} onAct={(k) => act(k, d)} />
            <ConnectAgent d={d} token={token} />
            <ToolsCard d={d} />
            <Logs deploymentId={d.id} />
          </div>
        )}
      </Loaded>
      <DeployDialog open={dialog} onClose={() => setDialog(false)} projectId={id} onDeployed={applyResult} />
    </>
  );
}

function CopyButton({ text, label = 'Copy', className = 'btn btn-outline btn-sm' }: { text: string; label?: string; className?: string }) {
  const toast = useToast();
  return <button className={className} onClick={async () => { const ok = await copyText(text); toast(ok ? 'Copied' : 'Copy failed', ok ? 'ok' : 'error'); }}><Copy className="size-3.5" />{label}</button>;
}

function TokenBox({ token }: { token: string }) {
  return (
    <div className="alert alert-warning">
      <KeyRound className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Copy this token now — it will not be shown again</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <code className="mono break-all rounded-md border bg-background px-2 py-1">{token}</code>
          <CopyButton text={token} />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">The snippets below include it until you leave this page. Lost it? Rotate the token.</p>
      </div>
    </div>
  );
}

function DeploymentCard({ d, busy, onAct }: { d: DeploymentDto; busy: string | null; onAct: (k: 'start' | 'stop' | 'rotate' | 'remove') => void }) {
  const meta = deploymentStatusMeta[d.status];
  const live = d.status === 'running' || d.status === 'starting';
  return (
    <Card>
      <CardHeader title="Deployment" description={`Package ${d.packageName}`}
        actions={<Badge tone={meta.tone}>{d.status === 'starting' && <Spinner className="size-3" />}{meta.label}</Badge>} />
      <div className="space-y-4 px-5 pb-5">
        <div>
          <div className="label">MCP endpoint (Streamable HTTP)</div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="mono break-all rounded-md border bg-muted/40 px-2 py-1.5">{d.url}</code>
            <CopyButton text={d.url} />
          </div>
        </div>
        <dl className="kv">
          <dt>Build</dt><dd><Link className="mono hover:underline" href={`/projects/${d.projectId}/builds/${d.buildId}`}>{d.buildLabel}</Link> · <span className="mono">{d.versionNumber}</span></dd>
          <dt>Environment</dt><dd><span className="mono">{d.connectionName}</span> <span className="text-xs text-muted-foreground">(credentials used for calls to your API)</span></dd>
          <dt>Token</dt><dd className="mono">••••{d.tokenHint}</dd>
          <dt>Started</dt><dd>{fmtDate(d.startedAt)}</dd>
          {d.stoppedAt && <><dt>Stopped</dt><dd>{fmtDate(d.stoppedAt)}</dd></>}
        </dl>
        {d.lastError && <InlineError error={d.lastError} />}
        <div className="flex flex-wrap gap-2 border-t pt-4">
          {live
            ? <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => onAct('stop')}>{busy === 'stop' ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />}Stop</button>
            : <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => onAct('start')}>{busy === 'start' ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}Start</button>}
          <button className="btn btn-outline btn-sm" disabled={!!busy} onClick={() => onAct('rotate')}>{busy === 'rotate' ? <Spinner className="size-3.5" /> : <KeyRound className="size-3.5" />}Rotate token</button>
          <button className="btn btn-danger btn-sm ml-auto" disabled={!!busy} onClick={() => onAct('remove')}>{busy === 'remove' ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}Remove</button>
        </div>
      </div>
    </Card>
  );
}

function ConnectAgent({ d, token }: { d: DeploymentDto; token: string | null }) {
  const [tab, setTab] = useState(d.instructions[0]?.id ?? '');
  const current = d.instructions.find((i) => i.id === tab) ?? d.instructions[0];
  if (!current) return null;
  const content = current.content.replaceAll('{{TOKEN}}', token ?? '<your-token>');
  return (
    <Card>
      <CardHeader title="Connect your agent" description="Copy a snippet into your MCP client or agent." />
      <div className="px-5 pb-5">
        <Tabs className="mb-3" value={current.id} onChange={setTab} tabs={d.instructions.map((i) => ({ id: i.id, label: i.title }))} />
        <div className="relative">
          <pre className="code max-h-96">{content}</pre>
          <CopyButton text={content} className="btn btn-sm absolute right-2 top-2 bg-white/10 text-zinc-200 hover:bg-white/20" />
        </div>
        {!token && current.content.includes('{{TOKEN}}') && (
          <p className="hint flex items-center gap-1.5"><TriangleAlert className="size-3.5 text-warning" />Replace <code className="mono">&lt;your-token&gt;</code> with the token shown once at deploy time, or rotate the token to get a new one.</p>
        )}
      </div>
    </Card>
  );
}

function ToolsCard({ d }: { d: DeploymentDto }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Tools" description={`${d.tools.length} tools exposed by this deployment`} />
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Tool</th><th>Impact</th><th>Confirm</th><th>Description</th></tr></thead>
          <tbody>
            {d.tools.map((t) => (
              <tr key={t.name}>
                <td className="mono">{t.name}</td>
                <td><Badge tone={impactMeta[t.impact].tone}>{impactMeta[t.impact].label}</Badge></td>
                <td className="text-xs">{t.requireConfirm ? 'Ask first' : '—'}</td>
                <td className="max-w-md text-xs text-muted-foreground">{t.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Logs({ deploymentId }: { deploymentId: string }) {
  const [open, setOpen] = useState(false);
  const q = useApi(() => (open ? api.deploymentLogs(deploymentId) : Promise.resolve(null)), [deploymentId, open]);
  return (
    <Card>
      <CardHeader title="Server logs" description="Recent output of the deployed MCP server"
        actions={<>
          {open && <button className="btn btn-ghost btn-sm" onClick={q.refetch} aria-label="Refresh logs">{q.loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}Refresh</button>}
          <button className="btn btn-outline btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide' : 'Show'}</button>
        </>} />
      {open && (
        <div className="px-5 pb-5">
          {q.error ? <InlineError error={q.error.message} />
            : <pre className="code max-h-80">{q.data ? (q.data.lines.length ? q.data.lines.join('\n') : 'No output yet.') : 'Loading…'}</pre>}
        </div>
      )}
    </Card>
  );
}
