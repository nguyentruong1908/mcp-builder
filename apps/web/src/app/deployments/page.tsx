'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ExternalLink, KeyRound, Play, RefreshCw, Rocket, Search, Square, Trash2 } from 'lucide-react';
import type { DeployResult, DeploymentDto, DeploymentStatus, ProjectSummary } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { deploymentStatusMeta, fmtDate } from '@/lib/utils';
import { Badge, Card, EmptyState, InlineError, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { CopyButton, DeployDialog, TokenBox } from '@/components/deploy-dialog';
import { deniedTitle, permLabel } from '@/lib/perms';
import { useToast } from '@/components/toast';

type Filter = 'all' | DeploymentStatus | 'none';
type Action = 'start' | 'stop' | 'rotate' | 'remove';
interface Row { project: ProjectSummary; dep: DeploymentDto | null }

export default function DeploymentsPage() {
  const toast = useToast();
  const q = useApi(() => Promise.all([api.deployments(), api.projects()]), []);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // `${deploymentId}:${action}`
  const [err, setErr] = useState<string | null>(null);
  // Shown once after a deploy or rotation; kept in React state only, never persisted.
  const [token, setToken] = useState<{ project: string; value: string } | null>(null);
  const [deployFor, setDeployFor] = useState<ProjectSummary | null>(null);
  const { refetch } = q;

  const starting = q.data?.[0].some((d) => d.status === 'starting');
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(refetch, 3000);
    return () => clearInterval(t);
  }, [starting, refetch]);

  async function act(kind: Action, d: DeploymentDto) {
    if (kind === 'rotate' && !confirm(`Rotate the token of ${d.projectName}? Agents using the current token stop working until they get the new one.`)) return;
    if (kind === 'remove' && !confirm(`Remove the deployment of ${d.projectName} at ${d.url}? The endpoint stops working. Downloaded packages are not affected.`)) return;
    setBusy(`${d.id}:${kind}`); setErr(null);
    try {
      if (kind === 'start') await api.startDeployment(d.id);
      if (kind === 'stop') await api.stopDeployment(d.id);
      if (kind === 'rotate') { const r = await api.rotateDeploymentToken(d.id); if (r.token) setToken({ project: d.projectName, value: r.token }); toast('New token issued'); }
      if (kind === 'remove') { await api.removeDeployment(d.id); toast('Deployment removed'); }
      refetch();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  function onDeployed(r: DeployResult) {
    if (r.token) setToken({ project: r.deployment.projectName, value: r.token });
    toast(r.token ? `Deployed ${r.deployment.projectName}` : `Redeployed ${r.deployment.projectName}`);
    refetch();
  }

  return (
    <>
      <PageHeader title="Deployments" description="Every MCP server running on this platform, across all projects. Deploying is optional; packages can still be downloaded from each project."
        actions={<button className="btn btn-outline btn-sm" onClick={refetch} disabled={q.loading}>{q.loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}Refresh</button>} />
      {token && <div className="mb-4"><TokenBox token={token.value} title={`New token for ${token.project}: copy it now, it will not be shown again`} /></div>}
      <InlineError error={err} />
      <Loaded q={q}>
        {([deps, projects]) => {
          const byProject = new Map(deps.map((d) => [d.projectId, d]));
          const rows: Row[] = projects.filter((p) => !p.archivedAt || byProject.has(p.id)).map((p) => ({ project: p, dep: byProject.get(p.id) ?? null }));
          const count = (f: Filter) => rows.filter((r) => matches(r, f)).length;
          const term = search.trim().toLowerCase();
          const shown = rows
            .filter((r) => matches(r, filter))
            .filter((r) => !term || `${r.project.name} ${r.project.slug} ${r.dep?.url ?? ''}`.toLowerCase().includes(term))
            .sort((a, b) => Number(!a.dep) - Number(!b.dep) || a.project.name.localeCompare(b.project.name));
          const tabs: { id: Filter; label: string }[] = [
            { id: 'all', label: `All ${rows.length}` },
            { id: 'running', label: `Running ${count('running')}` },
            { id: 'stopped', label: `Stopped ${count('stopped')}` },
            { id: 'failed', label: `Failed ${count('failed')}` },
            { id: 'none', label: `Not deployed ${count('none')}` },
          ];
          if (rows.length === 0) return <Card><EmptyState icon={<Rocket className="size-5" />} title="No projects yet" description="Create a project and export a Package verified build to deploy it." /></Card>;
          return (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 border-b px-3">
                <Tabs className="min-w-0 flex-1" value={filter} onChange={setFilter} tabs={tabs} />
                <label className="relative my-2 w-full sm:w-64">
                  <span className="sr-only">Search deployments</span>
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <input className="input h-8 pl-8" placeholder="Search project or endpoint" value={search} onChange={(e) => setSearch(e.target.value)} />
                </label>
              </div>
              {shown.length === 0 ? <EmptyState title="Nothing here" description="No project matches this filter." /> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Project</th><th>Status</th><th>Endpoint</th><th>Build · environment</th><th className="text-right">Actions</th></tr></thead>
                    <tbody>
                      {shown.map(({ project: p, dep: d }) => d ? (
                        <tr key={p.id}>
                          <td className="whitespace-nowrap"><Link className="font-medium hover:underline" href={`/projects/${p.id}/deploy`}>{p.name}</Link><div className="mono text-xs text-muted-foreground">{d.tools.length} tools · token ••••{d.tokenHint}</div></td>
                          <td>
                            <Badge tone={deploymentStatusMeta[d.status].tone}>{d.status === 'starting' && <Spinner className="size-3" />}{deploymentStatusMeta[d.status].label}</Badge>
                            {d.lastError ? <div className="mt-0.5 max-w-[220px] truncate text-xs text-danger" title={d.lastError}>{d.lastError}</div>
                              : <div className="mt-0.5 whitespace-nowrap text-xs text-muted-foreground">{d.status === 'stopped' ? `since ${fmtDate(d.stoppedAt)}` : fmtDate(d.startedAt)}</div>}
                          </td>
                          <td>
                            <div className="flex items-center gap-1.5">
                              <code className="mono max-w-[220px] truncate text-xs" title={d.url}>{d.url}</code>
                              <CopyButton text={d.url} label="" className="btn btn-ghost btn-icon size-7" />
                            </div>
                          </td>
                          <td className="whitespace-nowrap"><Link className="mono text-xs hover:underline" href={`/projects/${p.id}/builds/${d.buildId}`}>{d.buildLabel}</Link> <span className="mono text-xs text-muted-foreground">{d.versionNumber}</span><div className="mono text-xs text-muted-foreground" title="Environment whose credentials the server uses">env {d.connectionName}</div></td>
                          <td>
                            <div className="flex justify-end gap-1">
                              {d.status === 'running' || d.status === 'starting'
                                ? <IconAction label="Stop" busy={busy === `${d.id}:stop`} disabled={!!busy || !d.canManage} denied={!d.canManage} onClick={() => act('stop', d)} icon={<Square className="size-3.5" />} />
                                : <IconAction label="Start" busy={busy === `${d.id}:start`} disabled={!!busy || !d.canManage} denied={!d.canManage} onClick={() => act('start', d)} icon={<Play className="size-3.5" />} />}
                              <IconAction label="Redeploy" denied={!d.canManage} disabled={!!busy || !!p.archivedAt || !d.canManage} onClick={() => setDeployFor(p)} icon={<Rocket className="size-3.5" />} />
                              <IconAction label="Rotate token" busy={busy === `${d.id}:rotate`} disabled={!!busy || !d.canManage} denied={!d.canManage} onClick={() => act('rotate', d)} icon={<KeyRound className="size-3.5" />} />
                              <Link className="btn btn-ghost btn-icon size-8" href={`/projects/${p.id}/deploy`} title="Manage: agent setup, tools, logs" aria-label={`Manage ${p.name}`}><ExternalLink className="size-3.5" /></Link>
                              <IconAction label="Remove" danger busy={busy === `${d.id}:remove`} disabled={!!busy || !d.canManage} denied={!d.canManage} onClick={() => act('remove', d)} icon={<Trash2 className="size-3.5" />} />
                            </div>
                          </td>
                        </tr>
                      ) : (
                        <tr key={p.id}>
                          <td className="whitespace-nowrap"><Link className="font-medium hover:underline" href={`/projects/${p.id}`}>{p.name}</Link><div className="mono text-xs text-muted-foreground">{p.slug}</div></td>
                          <td><Badge tone="outline">Not deployed</Badge></td>
                          <td colSpan={2} className="text-xs text-muted-foreground">
                            {p.latestBuild?.packageVerified ? `Latest build ${p.latestBuild.label} is Package verified and can be deployed.` : 'Needs a Package verified build before it can be deployed.'}
                          </td>
                          <td className="text-right">
                            <button className="btn btn-outline btn-sm" disabled={!!p.archivedAt || !p.myPermissions.includes('deploy.manage')} title={deniedTitle(p.myPermissions.includes('deploy.manage'), permLabel('deploy.manage'))} onClick={() => setDeployFor(p)}><Rocket className="size-3.5" />Deploy</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        }}
      </Loaded>
      {deployFor && <DeployDialog open onClose={() => setDeployFor(null)} projectId={deployFor.id} onDeployed={onDeployed} />}
    </>
  );
}

function matches({ dep }: Row, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'none') return !dep;
  if (f === 'running') return dep?.status === 'running' || dep?.status === 'starting';
  return dep?.status === f;
}

function IconAction({ label, icon, onClick, disabled, busy, danger, denied }: { label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; busy?: boolean; danger?: boolean; denied?: boolean }) {
  return (
    <button className={`btn btn-ghost btn-icon size-8 ${danger ? 'text-danger hover:text-danger' : ''}`} title={denied ? `Requires permission ${permLabel('deploy.manage')}` : label} aria-label={label} disabled={disabled} onClick={onClick}>
      {busy ? <Spinner className="size-3.5" /> : icon}
    </button>
  );
}
