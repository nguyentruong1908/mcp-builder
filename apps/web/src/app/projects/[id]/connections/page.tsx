'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Pencil, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import type { AgentAccess, AuthType, ConnectionDto, UpsertConnectionInput } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, fmtDate } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Field, InlineError, Loaded, Modal, PageHeader, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/toast';

const agentAccessLabel: Record<AgentAccess, string> = { read_only: 'Read tools only', write: 'Read + write (no delete)', write_destructive: 'Read + write + delete' };

const EMPTY: UpsertConnectionInput = { name: 'test', baseUrl: '', authType: 'bearer', authHeader: 'Authorization', secretRef: 'env://', allowWrite: false, agentAccess: 'read_only', useForQa: true };
const authLabel: Record<AuthType, string> = { none: 'No auth', api_key: 'API key (header)', bearer: 'Bearer token' };

export default function ConnectionsPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useApi(() => api.connections(id), [id]);
  const [editing, setEditing] = useState<ConnectionDto | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function test(c: ConnectionDto) {
    setTesting(c.id);
    try {
      await api.testConnection(c.id);
      const list = await api.connections(id);
      q.setData(list);
      const chk = list.find((x) => x.id === c.id)?.lastCheck;
      toast(chk ? (chk.ok ? `Connection ${c.name} OK${chk.latencyMs != null ? ` · ${chk.latencyMs}ms` : ''}` : `Connection ${c.name} failed: ${chk.message ?? chk.status}`) : 'Checked', chk && !chk.ok ? 'error' : 'ok');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setTesting(null); }
  }
  async function remove(c: ConnectionDto) {
    if (!confirm(`Delete environment “${c.name}”?`)) return;
    try { await api.deleteConnection(c.id); q.setData((p) => (p ?? []).filter((x) => x.id !== c.id)); toast('Deleted'); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <>
      <PageHeader title="Connections"
        description={<>Environments used for testing. MCP Builder stores only secret <b className="text-foreground">references</b> (<code className="mono">env://VAR</code>); real credentials are never packaged into artifacts.</>}
        actions={<button className="btn btn-outline" onClick={() => setEditing('new')}><Plus className="size-4" />Add environment</button>} />
      <Loaded q={q}>
        {(list) => list.length === 0 ? (
          <Card><EmptyState icon={<Plug className="size-5" />} title="No environments yet" description="Add a test environment to run integration QA. Without one, integration results are NOT RUN."
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Add environment</button>} /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {list.map((c) => (
              <Card key={c.id} className={cn(c.useForQa && 'ring-1 ring-brand/50')}>
                <CardHeader
                  title={<span className="flex items-center gap-2"><span className="mono text-base">{c.name}</span>{c.useForQa && <Badge tone="brand">Used for QA</Badge>}</span>}
                  actions={c.lastCheck ? <Badge tone={c.lastCheck.ok ? 'success' : 'danger'}><span className="size-1.5 rounded-full bg-current" />{c.lastCheck.ok ? 'OK' : 'Failed'}</Badge> : <Badge>Not checked</Badge>}
                />
                <dl className="kv px-5 pb-5">
                  <dt>Base URL</dt><dd className="mono break-all text-xs">{c.baseUrl}</dd>
                  <dt>Auth</dt><dd>{authLabel[c.authType]}{c.authType === 'api_key' && <> · <code className="mono">{c.authHeader}</code></>}</dd>
                  <dt>Secret</dt><dd className="flex flex-wrap items-center gap-1.5">{c.authType === 'none' ? '—' : <><span className="mono text-xs">{c.secretRef}</span><Badge tone={c.secretResolvable ? 'success' : 'warning'}>{c.secretResolvable ? 'resolved' : 'missing env var'}</Badge></>}</dd>
                  <dt>Writes</dt><dd><Badge tone={c.allowWrite ? 'warning' : 'outline'}>{c.allowWrite ? 'Allowed' : 'No'}</Badge></dd>
                  <dt>Agent eval</dt><dd><Badge tone={c.agentAccess === 'read_only' ? 'outline' : c.agentAccess === 'write' ? 'warning' : 'danger'}>{agentAccessLabel[c.agentAccess ?? 'read_only']}</Badge></dd>
                  {c.lastCheck && <><dt>Last check</dt><dd className="text-xs">{fmtDate(c.lastCheck.at)}{c.lastCheck.status != null && ` · HTTP ${c.lastCheck.status}`}{c.lastCheck.latencyMs != null && ` · ${c.lastCheck.latencyMs}ms`}{c.lastCheck.message && <div className="text-muted-foreground">{c.lastCheck.message}</div>}</dd></>}
                </dl>
                <div className="flex gap-2 border-t px-5 py-3">
                  <button className="btn btn-outline btn-sm" disabled={testing === c.id} onClick={() => test(c)}>{testing === c.id ? <Spinner className="size-3.5" /> : <PlugZap className="size-3.5" />}Test connection</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}><Pencil className="size-3.5" />Edit</button>
                  <button className="btn btn-ghost btn-sm ml-auto text-danger" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}><Trash2 className="size-3.5" /></button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Loaded>
      {editing && (
        <ConnectionForm projectId={id} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); q.refetch(); toast('Environment saved'); }} />
      )}
    </>
  );
}

function ConnectionForm({ projectId, initial, onClose, onSaved }: { projectId: string; initial: ConnectionDto | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<UpsertConnectionInput>(() => {
    if (!initial) return EMPTY;
    const { id: _i, secretResolvable: _s, lastCheck: _l, ...rest } = initial;
    return rest;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof UpsertConnectionInput>(k: K, v: UpsertConnectionInput[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (!f.name.trim() || !/^https?:\/\//.test(f.baseUrl)) return setErr('A name and a Base URL starting with http(s):// are required');
    if (f.authType !== 'none' && !/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(f.secretRef)) return setErr('The secret must be a reference like env://VAR_NAME; never enter the secret value.');
    setBusy(true); setErr(null);
    try {
      if (initial) await api.updateConnection(initial.id, f); else await api.createConnection(projectId, f);
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={initial ? `Edit environment ${initial.name}` : 'Add environment'}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">{(i) => <input id={i} className="input font-mono text-xs" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="dev / test / prod" />}</Field>
        <Field label="Auth type">
          {(i) => (
            <select id={i} className="input" value={f.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
              {(Object.keys(authLabel) as AuthType[]).map((k) => <option key={k} value={k}>{authLabel[k]}</option>)}
            </select>
          )}
        </Field>
        <Field label="Base URL" className="sm:col-span-2">{(i) => <input id={i} className="input font-mono text-xs" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://erp-test.example.internal" />}</Field>
        {f.authType === 'api_key' && <Field label="Header">{(i) => <input id={i} className="input font-mono text-xs" value={f.authHeader} onChange={(e) => set('authHeader', e.target.value)} placeholder="X-Api-Key" />}</Field>}
        {f.authType !== 'none' && (
          <Field label="Secret reference" hint="Read from the API's environment when QA runs." className={f.authType === 'api_key' ? '' : 'sm:col-span-2'}>
            {(i) => <input id={i} className="input font-mono text-xs" value={f.secretRef} onChange={(e) => set('secretRef', e.target.value)} placeholder="env://ERP_TEST_TOKEN" />}
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm"><Switch label="Use for QA" checked={f.useForQa} onChange={(v) => set('useForQa', v)} />Use for QA</label>
        <label className="flex items-center gap-2 text-sm"><Switch label="Allow writes" checked={f.allowWrite} onChange={(v) => setF((x) => ({ ...x, allowWrite: v, agentAccess: v ? x.agentAccess : 'read_only' }))} />Allow write tools to run</label>
        <Field label="Agent eval may use" className="sm:col-span-2"
          hint={f.allowWrite
            ? 'The agent runs with full access and auto-approval: at write/delete levels it can change real data in this environment while doing sample tasks.'
            : 'Turn on "Allow write tools to run" to let the agent use write/delete tools. Live test cases on write tools need it too.'}>
          {(i) => (
            <select id={i} className="input" value={f.agentAccess} disabled={!f.allowWrite} onChange={(e) => set('agentAccess', e.target.value as AgentAccess)}>
              {(Object.keys(agentAccessLabel) as AgentAccess[]).map((k) => <option key={k} value={k}>{agentAccessLabel[k]}</option>)}
            </select>
          )}
        </Field>
        <div className="sm:col-span-2"><InlineError error={err} /></div>
      </div>
    </Modal>
  );
}
