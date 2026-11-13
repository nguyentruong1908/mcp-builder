'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Ban, Check, Copy, FileCode2, Search, TriangleAlert } from 'lucide-react';
import type { Impact, Outputs, ToolDto, UpdateToolInput } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, copyText, impactMeta } from '@/lib/utils';
import { Badge, Card, EmptyState, Field, InlineError, Loaded, MethodBadge, PageHeader, Spinner, Switch, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

type Filter = 'all' | 'selected' | 'write';
type DetailTab = 'def' | 'schema' | 'json';

export default function ToolDesignerPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const tools = useApi(() => api.tools(id), [id]);
  const project = useApi(() => api.project(id), [id]);
  const [curId, setCurId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const list = tools.data ?? [];
  const cur = list.find((t) => t.id === curId) ?? list.find((t) => !t.unsupportedReason) ?? list[0] ?? null;
  const selectedCount = list.filter((t) => t.selected).length;

  const groups = useMemo(() => {
    const q = query.toLowerCase();
    const out: { tag: string; items: ToolDto[] }[] = [];
    for (const t of list) {
      if (q && !`${t.method} ${t.path} ${t.name}`.toLowerCase().includes(q)) continue;
      if (filter === 'selected' && !t.selected) continue;
      if (filter === 'write' && (t.unsupportedReason || t.impact === 'read')) continue;
      let g = out.find((x) => x.tag === t.tag);
      if (!g) out.push((g = { tag: t.tag || 'default', items: [] }));
      g.items.push(t);
    }
    return out;
  }, [list, query, filter]);

  async function patch(t: ToolDto, input: UpdateToolInput) {
    const prev = list;
    tools.setData(prev.map((x) => (x.id === t.id ? { ...x, ...input } : x)));
    try {
      const saved = await api.updateTool(t.id, input);
      tools.setData((p) => (p ?? []).map((x) => (x.id === saved.id ? saved : x)));
      return true;
    } catch (e) {
      tools.setData(prev);
      toast((e as Error).message, 'error');
      return false;
    }
  }

  async function setOutputs(o: Outputs) {
    project.setData((p) => p && { ...p, outputs: o });
    try { project.setData(await api.updateProject(id, { outputs: o })); }
    catch (e) { toast((e as Error).message, 'error'); project.refetch(); }
  }

  return (
    <>
      <PageHeader title="Tool designer" description="Pick the endpoints to include. MCP and CLI share one tool definition."
        actions={tools.data && <Badge tone="brand" className="text-xs">{selectedCount} tools selected</Badge>} />

      {project.data && (
        <Card className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3">
          <span className="text-xs font-medium text-muted-foreground">Outputs</span>
          <label className="flex items-center gap-2 text-sm"><Switch label="MCP server" checked={project.data.outputs.mcp} onChange={(v) => setOutputs({ ...project.data!.outputs, mcp: v })} />MCP server (stdio / HTTP)</label>
          <label className="flex items-center gap-2 text-sm"><Switch label="CLI" checked={project.data.outputs.cli} onChange={(v) => setOutputs({ ...project.data!.outputs, cli: v })} />CLI</label>
          <span className="ml-auto text-xs text-muted-foreground">Runtime: Node.js · npm</span>
        </Card>
      )}

      <Loaded q={tools}>
        {() => list.length === 0 ? (
          <Card><EmptyState icon={<FileCode2 className="size-5" />} title="No endpoints yet" description="Import a Swagger spec first to list its operations."
            action={<Link href={`/projects/${id}/api`} className="btn btn-primary btn-sm">Import Swagger</Link>} /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <Card className="flex max-h-[760px] flex-col overflow-hidden">
              <div className="flex flex-wrap items-center gap-2 border-b p-3">
                <div className="relative min-w-[180px] flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input className="input h-8 pl-8 text-xs" placeholder="Search path or tool name…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search endpoints" />
                </div>
                <div className="seg" role="group" aria-label="Filter endpoints">
                  {([['all', 'All'], ['selected', 'Selected'], ['write', 'With side effects']] as const).map(([k, l]) => (
                    <button key={k} className={cn(filter === k && 'on')} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {groups.length === 0 && <div className="p-10 text-center text-sm text-muted-foreground">No matching endpoints.</div>}
                {groups.map((g) => (
                  <div key={g.tag}>
                    <div className="sticky top-0 z-[1] border-b bg-muted/80 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">{g.tag}</div>
                    {g.items.map((t) => (
                      <div key={t.id} onClick={() => setCurId(t.id)}
                        className={cn('flex cursor-pointer items-center gap-3 border-b px-4 py-2.5 transition-colors', cur?.id === t.id ? 'bg-brand/10 shadow-[inset_2px_0_0_var(--brand)]' : 'hover:bg-muted/50', t.unsupportedReason && 'opacity-60')}>
                        <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={t.selected} disabled={!!t.unsupportedReason}
                          onClick={(e) => e.stopPropagation()} onChange={(e) => patch(t, { selected: e.target.checked })} aria-label={`Select ${t.method} ${t.path}`} />
                        <MethodBadge method={t.method} />
                        <button className="min-w-0 flex-1 text-left" onClick={() => setCurId(t.id)}>
                          <div className="truncate font-mono text-xs">{t.path}</div>
                          <div className="truncate text-xs text-muted-foreground">{t.unsupportedReason ?? t.name}</div>
                        </button>
                        {t.unsupportedReason ? <Badge tone="danger">Unsupported</Badge> : <Badge tone={impactMeta[t.impact].tone}>{impactMeta[t.impact].label}</Badge>}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </Card>
            {cur && <ToolDetail key={cur.id} tool={cur} onPatch={(input) => patch(cur, input)} />}
          </div>
        )}
      </Loaded>
    </>
  );
}

function ToolDetail({ tool, onPatch }: { tool: ToolDto; onPatch: (input: UpdateToolInput) => Promise<boolean> }) {
  const toast = useToast();
  const [tab, setTab] = useState<DetailTab>('def');
  const [draft, setDraft] = useState({ name: tool.name, description: tool.description, impact: tool.impact, requireConfirm: tool.requireConfirm });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setDraft({ name: tool.name, description: tool.description, impact: tool.impact, requireConfirm: tool.requireConfirm }), [tool.name, tool.description, tool.impact, tool.requireConfirm]);

  const dirty = draft.name !== tool.name || draft.description !== tool.description || draft.impact !== tool.impact || draft.requireConfirm !== tool.requireConfirm;
  const nameOk = /^[a-z][a-z0-9_]{0,63}$/.test(draft.name);
  const json = JSON.stringify({
    name: draft.name, description: draft.description, inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: draft.impact === 'read', destructiveHint: draft.impact === 'destructive' },
  }, null, 2);

  async function save() {
    if (!nameOk) return setErr('Tool names use lowercase letters, digits and _, and start with a letter.');
    setBusy(true); setErr(null);
    if (await onPatch(draft)) toast('Tool saved');
    setBusy(false);
  }

  if (tool.unsupportedReason) {
    return (
      <Card className="h-fit p-5">
        <div className="flex items-center gap-2"><MethodBadge method={tool.method} /><span className="mono">{tool.path}</span></div>
        <div className="alert alert-danger mt-4"><Ban className="mt-0.5 size-4 shrink-0 text-danger" /><div>Outside the MVP scope: <b>{tool.unsupportedReason}</b>. This endpoint cannot be included in a build.</div></div>
      </Card>
    );
  }

  return (
    <Card className="h-fit">
      <div className="flex items-start justify-between gap-3 border-b px-5 pt-4 pb-4">
        <div className="min-w-0">
          <div className="truncate font-mono text-base font-semibold">{tool.name}</div>
          <div className="mt-1 flex items-center gap-2"><MethodBadge method={tool.method} /><span className="mono truncate text-muted-foreground">{tool.path}</span></div>
        </div>
        <label className="flex items-center gap-2 text-xs font-medium">
          {tool.selected ? 'Included' : 'Not included'}
          <Switch label="Include in tool set" checked={tool.selected} onChange={(v) => onPatch({ selected: v })} />
        </label>
      </div>
      <Tabs className="px-3" value={tab} onChange={setTab} tabs={[{ id: 'def', label: 'Definition' }, { id: 'schema', label: 'Input schema' }, { id: 'json', label: 'MCP JSON' }]} />
      <div className="px-5 py-5">
        {tab === 'def' && (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tool name (MCP)">{(i) => <input id={i} className={cn('input font-mono text-xs', !nameOk && 'border-danger')} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />}</Field>
              <div><div className="label">CLI command</div><div className="input items-center bg-muted/40 font-mono text-xs text-muted-foreground">{draft.name.replace(/_/g, '-')}</div></div>
            </div>
            <Field label="Description for agents" hint="Agents rely on this to choose the tool. Say when to use it and when not to.">
              {(i) => <textarea id={i} className="textarea" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Impact" hint="Confirmed by you, never inferred from the HTTP method.">
                {(i) => (
                  <select id={i} className="input" value={draft.impact} onChange={(e) => setDraft({ ...draft, impact: e.target.value as Impact })}>
                    <option value="read">Read</option>
                    <option value="write">Write data</option>
                    <option value="side_effect">Side effect (email, approval…)</option>
                    <option value="destructive">Delete</option>
                  </select>
                )}
              </Field>
              <div>
                <div className="label">Confirm before calling</div>
                <label className="flex h-9 items-center gap-2 text-sm"><Switch label="Confirm before calling" checked={draft.requireConfirm} onChange={(v) => setDraft({ ...draft, requireConfirm: v })} />Ask agents to confirm with the user</label>
              </div>
            </div>
            {draft.impact !== 'read' && !draft.requireConfirm && (
              <div className="alert alert-warning"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div>This tool has side effects but does not require confirmation.</div></div>
            )}
            <InlineError error={err} />
            <div className="flex justify-end gap-2">
              <button className="btn btn-ghost" disabled={!dirty || busy} onClick={() => setDraft({ name: tool.name, description: tool.description, impact: tool.impact, requireConfirm: tool.requireConfirm })}>Revert</button>
              <button className="btn btn-primary" disabled={!dirty || busy} onClick={save}>{busy ? <Spinner /> : <Check className="size-4" />}Save</button>
            </div>
          </div>
        )}
        {tab === 'schema' && (
          tool.params.length === 0 ? <p className="text-sm text-muted-foreground">This tool has no parameters.</p> : (
            <div className="overflow-hidden rounded-lg border">
              <table className="tbl">
                <thead><tr><th>Parameter</th><th>Type</th><th>Location</th><th>Required</th></tr></thead>
                <tbody>
                  {tool.params.map((p) => (
                    <tr key={`${p.in}:${p.name}`}>
                      <td><div className="mono">{p.name}</div>{p.description && <div className="text-xs text-muted-foreground">{p.description}</div>}</td>
                      <td className="mono text-muted-foreground">{p.type}</td>
                      <td><Badge>{p.in}</Badge></td>
                      <td>{p.required ? <Check className="size-4 text-success" aria-label="Required" /> : <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
        {tab === 'json' && (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Preview of the current draft{dirty && ' (unsaved)'}</span>
              <button className="btn btn-ghost btn-sm" onClick={async () => { const ok = await copyText(json); toast(ok ? 'Copied' : 'Copy failed', ok ? 'ok' : 'error'); }}><Copy className="size-3.5" />Copy</button>
            </div>
            <pre className="code max-h-[420px]">{json}</pre>
          </>
        )}
      </div>
    </Card>
  );
}
