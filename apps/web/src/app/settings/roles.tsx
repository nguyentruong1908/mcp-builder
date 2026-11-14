'use client';

import { useState } from 'react';
import { Lock, Plus, Trash2 } from 'lucide-react';
import type { PermissionInfo, RoleDto, RoleScope } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { Badge, Card, CardHeader, Field, InlineError, Loaded, Modal, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';

export function RolesPanel() {
  const q = useApi(() => Promise.all([api.permissions(), api.roles()]), []);
  const [creating, setCreating] = useState<RoleScope | null>(null);
  return (
    <Loaded q={q}>
      {([perms, roles]) => (
        <div className="space-y-4">
          {(['project', 'workspace'] as const).map((scope) => (
            <Matrix key={scope} scope={scope} perms={perms.filter((p) => p.scope === scope)} roles={roles.filter((r) => r.scope === scope)}
              onChanged={q.refetch} onNew={() => setCreating(scope)} />
          ))}
          {creating && <NewRole scope={creating} onClose={() => setCreating(null)} onCreated={() => { setCreating(null); q.refetch(); }} />}
        </div>
      )}
    </Loaded>
  );
}

function Matrix({ scope, perms, roles, onChanged, onNew }: { scope: RoleScope; perms: PermissionInfo[]; roles: RoleDto[]; onChanged: () => void; onNew: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key); setErr(null);
    try { await fn(); if (ok) toast(ok); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }
  const toggle = (r: RoleDto, key: string, on: boolean) =>
    run(r.id + key, () => api.updateRole(r.id, { permissions: on ? [...r.permissions, key] : r.permissions.filter((k) => k !== key) }));
  const rename = (r: RoleDto) => {
    const name = prompt('Role name', r.name)?.trim();
    if (name && name !== r.name) void run(r.id, () => api.updateRole(r.id, { name }), 'Role renamed');
  };
  const remove = (r: RoleDto) => {
    if (!confirm(`Delete role "${r.name}"? ${r.usage ? `It is in use by ${r.usage} ${r.usage === 1 ? 'assignment' : 'assignments'}, so deletion will be refused until they are reassigned.` : 'It is not in use.'}`)) return;
    void run(r.id, () => api.deleteRole(r.id), 'Role deleted');
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader title={scope === 'project' ? 'Project roles' : 'Workspace roles'}
        description={scope === 'project' ? 'What a member can do inside a project.' : 'What a user can do across the workspace.'}
        actions={<button className="btn btn-outline btn-sm" onClick={onNew}><Plus className="size-3.5" />New role</button>} />
      <div className="px-5"><InlineError error={err} /></div>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead>
            <tr>
              <th>Permission</th>
              {roles.map((r) => (
                <th key={r.id} className="text-center">
                  <div className="flex items-center justify-center gap-1">
                    {r.system && <Lock className="size-3" aria-label="System role" />}
                    {r.system ? r.name : <button className="underline decoration-dotted" title="Rename" onClick={() => rename(r)}>{r.name}</button>}
                    {!r.system && <button className="btn btn-ghost btn-icon size-6 text-danger" title={`Delete (in use: ${r.usage})`} aria-label={`Delete ${r.name}`} disabled={!!busy} onClick={() => remove(r)}><Trash2 className="size-3" /></button>}
                  </div>
                  <div className="mt-0.5 font-normal"><Badge tone="outline">{r.usage} in use</Badge></div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {perms.map((p) => (
              <tr key={p.key}>
                <td><div className="font-medium">{p.label}</div><div className="text-xs text-muted-foreground">{p.description}</div></td>
                {roles.map((r) => (
                  <td key={r.id} className="text-center">
                    {busy === r.id + p.key ? <Spinner className="size-3.5" /> : (
                      <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={r.permissions.includes(p.key)} disabled={r.system || !!busy}
                        title={r.system ? 'System roles cannot be edited' : undefined} aria-label={`${r.name}: ${p.label}`} onChange={(e) => toggle(r, p.key, e.target.checked)} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NewRole({ scope, onClose, onCreated }: { scope: RoleScope; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { await api.createRole({ name: name.trim(), scope, description: description.trim(), permissions: [] }); onCreated(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }
  return (
    <Modal open onClose={onClose} title={`New ${scope} role`} description="Created without permissions; tick them in the matrix afterwards." size="max-w-md"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !name.trim()} onClick={save}>{busy && <Spinner />}Create role</button></>}>
      <div className="space-y-4">
        <Field label="Name">{(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Description">{(id) => <input id={id} className="input" value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
