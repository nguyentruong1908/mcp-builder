'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Copy, Download, FileCheck2, FileJson, GitBranch, Package, Rocket, TriangleAlert } from 'lucide-react';
import type { VersionDto } from '@mcp-factory/shared';
import { absUrl, api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { copyText, fmtBytes, fmtDate, shortHash, versionStatusMeta } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { BuildBadges } from '@/components/build-badges';
import { SpecDiffView } from '@/components/spec-diff';
import { useToast } from '@/components/toast';

type InstallTab = 'mcp' | 'http' | 'cli';
const artifactIcon = { mcp_package: Package, qa_report: FileCheck2, provenance: FileJson };

export default function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const versions = useApi(() => api.versions(id), [id]);
  const spec = useApi(() => api.spec(id), [id]);
  const project = useApi(() => api.project(id), [id]);
  const [busy, setBusy] = useState<string | null>(null);

  async function act(v: VersionDto, kind: 'release' | 'deprecate') {
    if (kind === 'deprecate' && !confirm(`Deprecate ${v.number}? Việc này chỉ đánh dấu và thông báo; không thể thu hồi package người dùng đã tải.`)) return;
    setBusy(v.id);
    try {
      await (kind === 'release' ? api.releaseVersion(v.id) : api.deprecateVersion(v.id));
      toast(kind === 'release' ? `Đã release ${v.number}` : `Đã deprecate ${v.number}`);
      window.dispatchEvent(new Event('mf:refresh')); // header/sidebar show version state
      versions.refetch(); project.refetch();
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(null); }
  }

  const history = [...(spec.data?.history ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const released = versions.data?.filter((v) => v.status === 'released').sort((a, b) => (b.releasedAt ?? '').localeCompare(a.releasedAt ?? ''))[0];

  return (
    <>
      <PageHeader title="Versions & Exports" description="API version, tool package version và build ID là ba giá trị riêng." />
      <Loaded q={versions}>
        {(list) => list.length === 0 ? (
          <Card><EmptyState icon={<GitBranch className="size-5" />} title="Chưa có version" description="Export lần đầu sẽ tạo version nháp." /></Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Package</th><th>API version</th><th>Build mới nhất</th><th>Tool</th><th>Trạng thái</th><th className="text-right">Thao tác</th></tr></thead>
                <tbody>
                  {list.map((v) => (
                    <tr key={v.id}>
                      <td><div className="mono font-semibold">{v.number}</div>{v.changelog && <div className="max-w-xs truncate text-xs text-muted-foreground" title={v.changelog}>{v.changelog}</div>}</td>
                      <td className="mono">{v.apiVersion || '—'}</td>
                      <td>{v.latestBuild ? (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Link href={`/projects/${id}/builds/${v.latestBuild.id}`} className="mono text-xs hover:underline">{v.latestBuild.label}</Link>
                          <BuildBadges b={v.latestBuild} status={false} />
                        </div>
                      ) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="tabular-nums">{v.toolCount}</td>
                      <td><Badge tone={versionStatusMeta[v.status].tone}>{versionStatusMeta[v.status].label}</Badge>{v.releasedAt && <div className="mt-0.5 text-xs text-muted-foreground">{fmtDate(v.releasedAt)}</div>}</td>
                      <td className="text-right">
                        {v.status === 'draft' && (
                          <button className="btn btn-outline btn-sm" disabled={busy === v.id || !v.latestBuild?.packageVerified} title={v.latestBuild?.packageVerified ? undefined : 'Cần build mới nhất đạt Package verified'} onClick={() => act(v, 'release')}>
                            {busy === v.id ? <Spinner className="size-3.5" /> : <Rocket className="size-3.5" />}Release
                          </button>
                        )}
                        {v.status === 'released' && <button className="btn btn-ghost btn-sm" disabled={busy === v.id} onClick={() => act(v, 'deprecate')}>Deprecate</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Loaded>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Swagger diff" description={history.length >= 2 ? <span className="mono">{shortHash(history[1].sha256)} → {shortHash(history[0].sha256)}</span> : 'Cần ít nhất 2 snapshot'} />
          <div className="px-5 pb-5">
            {history.length >= 2 ? <SpecDiffView projectId={id} from={history[1].id} to={history[0].id} />
              : <p className="text-sm text-muted-foreground">Import lại spec khi API thay đổi để xem endpoint mới/xóa, tham số đổi và tool bị ảnh hưởng.</p>}
          </div>
        </Card>
        {released?.latestBuild ? <Downloads buildId={released.latestBuild.id} version={released.number} slug={project.data?.slug ?? 'tool'} />
          : <Card><CardHeader title="Tải về" /><EmptyState icon={<Package className="size-5" />} title="Chưa có bản release" description="Release một version đạt Package verified để tải package và xem hướng dẫn cài." /></Card>}
      </div>
    </>
  );
}

function Downloads({ buildId, version, slug }: { buildId: string; version: string; slug: string }) {
  const toast = useToast();
  const b = useApi(() => api.build(buildId), [buildId]);
  const [tab, setTab] = useState<InstallTab>('mcp');
  return (
    <Card>
      <CardHeader title={`Tải về · ${version}`} description="Artifact kèm checksum và provenance" actions={<Badge tone="success">Released</Badge>} />
      <Loaded q={b}>
        {(d) => {
          // Package layout comes from templates/mcp-node: name `<slug>-tools`, bins `<slug>` (CLI) and `<slug>-mcp` (MCP server).
          const pkg = d.artifacts.find((a) => a.kind === 'mcp_package')?.filename ?? `${slug}-tools-${version.replace(/^v/, '')}.tgz`;
          const snippets: Record<InstallTab, string> = {
            mcp: `npm install -g ./${pkg}\n\n# cấu hình MCP client (stdio)\n{\n  "mcpServers": {\n    "${slug}": {\n      "command": "${slug}-mcp",\n      "env": {\n        "API_BASE_URL": "https://api.example.com",\n        "API_TOKEN": "<your-token>"\n      }\n    }\n  }\n}`,
            http: `npm install -g ./${pkg}\nexport API_BASE_URL=https://api.example.com\nexport API_TOKEN=<your-token>\nexport MCP_AUTH_TOKEN=<token-cho-client>\n\n${slug}-mcp --http 8080\ncurl localhost:8080/healthz   # {"status":"ok"}`,
            cli: `npm install -g ./${pkg}\nexport API_BASE_URL=https://api.example.com\nexport API_TOKEN=<your-token>\n\n${slug} --help\n${slug} <command> --param value --json\necho $?   # 0 ok · 2 input · 3 auth · 4 API · 5 network`,
          };
          return (
            <>
              <div className="space-y-2 px-5 pb-5">
                {d.artifacts.length === 0 && <p className="text-sm text-muted-foreground">Build này không có artifact.</p>}
                {d.artifacts.map((a) => {
                  const Icon = artifactIcon[a.kind] ?? Package;
                  return (
                    <div key={a.id} className="flex items-center gap-3 rounded-lg border p-3">
                      <span className="flex size-8 items-center justify-center rounded-md bg-muted"><Icon className="size-4" /></span>
                      <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{a.filename}</div><div className="truncate font-mono text-[11px] text-muted-foreground">sha256:{shortHash(a.sha256)} · {fmtBytes(a.size)}</div></div>
                      <a className="btn btn-outline btn-sm" href={absUrl(a.downloadUrl)} download><Download className="size-3.5" />Tải</a>
                    </div>
                  );
                })}
              </div>
              <div className="border-t">
                <Tabs className="px-3" value={tab} onChange={setTab} tabs={[{ id: 'mcp', label: 'MCP local' }, { id: 'http', label: 'MCP HTTP' }, { id: 'cli', label: 'CLI' }]} />
                <div className="px-5 pt-4 pb-5">
                  <div className="relative">
                    <pre className="code">{snippets[tab]}</pre>
                    <button className="btn btn-sm absolute right-2 top-2 bg-white/10 text-zinc-200 hover:bg-white/20" onClick={async () => { const ok = await copyText(snippets[tab]); toast(ok ? 'Đã copy' : 'Không copy được', ok ? 'ok' : 'error'); }}><Copy className="size-3.5" />Copy</button>
                  </div>
                  <p className="hint flex items-center gap-1.5"><TriangleAlert className="size-3.5 text-warning" />Không thể thu hồi package người dùng đã tải. Credential do người dùng tool tự cấu hình, không nằm trong package.</p>
                </div>
              </div>
            </>
          );
        }}
      </Loaded>
    </Card>
  );
}
