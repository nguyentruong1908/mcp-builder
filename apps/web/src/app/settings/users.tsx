'use client';

import { useState } from 'react';
import { Copy, KeyRound, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import type { RoleDto, UserDto } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { useApi } from '@/lib/use-api';
import { copyText, fmtDate } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Field, InlineError, Loaded, Modal, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';

/** One-time password, held only in React state of the open dialog; never persisted or put in a URL. */
function TempPassword({ value }: { value: string }) {
  const toast = useToast();
  return (
    <div className="alert alert-warning flex-col items-stretch gap-2">
      <div className="text-sm">Temporary password. Copy it now, it will not be shown again. The user must change it at first sign-in.</div>
      <div className="flex items-center gap-2">
        <code className="mono flex-1 break-all rounded-md border bg-background px-2 py-1.5 text-sm">{value}</code>
        <button className="btn btn-outline btn-sm" onClick={async () => { const ok = await copyText(value); toast(ok ? 'Copied' : 'Copy failed', ok ? 'ok' : 'error'); }}><Copy className="size-3.5" />Copy</button>
      </div>
    </div>
  );
}

export function UsersPanel() {
  const { me } = useMe();
  const q = useApi(() => Promise.all([api.users(), api.roles()]), []);
  const toast = useToast();
  const [dialog, setDialog] = useState<'new' | UserDto | null>(null);
  const [temp, setTemp] = useState<{ user: string; password: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function act(u: UserDto, kind: 'reset' | 'toggle') {
    if (kind === 'reset' && !confirm(`Reset the password of ${u.username}? Their sessions are signed out.`)) return;
    setBusy(u.id + kind); setErr(null);
    try {
      if (kind === 'reset') { const r = await api.resetPassword(u.id); if (r.temporaryPassword) setTemp({ user: u.username, password: r.temporaryPassword }); }
      else { await api.updateUser(u.id, { disabled: !u.disabled }); toast(u.disabled ? 'User enabled' : 'User disabled'); }
      q.refetch();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <Loaded q={q}>
      {([users, roles]) => (
        <Card className="overflow-hidden">
          <CardHeader title="Users" description={`${users.length} accounts`}
            actions={<button className="btn btn-primary btn-sm" onClick={() => setDialog('new')}><Plus className="size-3.5" />New user</button>} />
          <div className="space-y-3 px-5 pb-3">
            {temp && <div><div className="mb-1 text-xs text-muted-foreground">Password for {temp.user}</div><TempPassword value={temp.password} /></div>}
            <InlineError error={err} />
          </div>
          {users.length === 0 ? <EmptyState title="No users" /> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th className="text-right">Actions</th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={u.disabled ? 'opacity-60' : undefined}>
                      <td className="mono">{u.username}{u.id === me.id && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}</td>
                      <td>{u.displayName}</td>
                      <td><Badge tone="outline">{u.role.name}</Badge></td>
                      <td>{u.disabled ? <Badge tone="danger">Disabled</Badge> : u.mustChangePassword ? <Badge tone="warning">Must change password</Badge> : <Badge tone="success">Active</Badge>}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{u.lastLoginAt ? fmtDate(u.lastLoginAt) : 'Never'}</td>
                      <td>
                        <div className="flex justify-end gap-1">
                          <button className="btn btn-ghost btn-icon size-8" title="Edit" aria-label={`Edit ${u.username}`} onClick={() => setDialog(u)}><Pencil className="size-3.5" /></button>
                          <button className="btn btn-ghost btn-icon size-8" title="Reset password" aria-label={`Reset password of ${u.username}`} disabled={!!busy} onClick={() => act(u, 'reset')}>{busy === u.id + 'reset' ? <Spinner className="size-3.5" /> : <KeyRound className="size-3.5" />}</button>
                          <button className="btn btn-ghost btn-icon size-8" title={u.disabled ? 'Enable' : 'Disable'} aria-label={`${u.disabled ? 'Enable' : 'Disable'} ${u.username}`} disabled={!!busy} onClick={() => act(u, 'toggle')}>{busy === u.id + 'toggle' ? <Spinner className="size-3.5" /> : u.disabled ? <UserCheck className="size-3.5" /> : <UserX className="size-3.5" />}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {dialog && <UserDialog user={dialog === 'new' ? null : dialog} roles={roles.filter((r) => r.scope === 'workspace')} onClose={() => setDialog(null)}
            onDone={(pw, name) => { setTemp(pw ? { user: name, password: pw } : null); setDialog(null); q.refetch(); }} />}
        </Card>
      )}
    </Loaded>
  );
}

function UserDialog({ user, roles, onClose, onDone }: { user: UserDto | null; roles: RoleDto[]; onClose: () => void; onDone: (password: string | null, username: string) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [roleId, setRoleId] = useState(user?.role.id ?? roles.find((r) => r.name === 'Member')?.id ?? roles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      if (user) { await api.updateUser(user.id, { displayName: displayName.trim(), roleId }); onDone(null, user.username); }
      else { const r = await api.createUser({ username: username.trim(), displayName: displayName.trim(), roleId }); onDone(r.temporaryPassword, r.user.username); }
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={user ? `Edit ${user.username}` : 'New user'} size="max-w-md"
      description={user ? undefined : 'A temporary password is generated and shown once.'}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !displayName.trim() || !roleId || (!user && !username.trim())} onClick={save}>{busy && <Spinner />}{user ? 'Save' : 'Create user'}</button></>}>
      <div className="space-y-4">
        {!user && <Field label="Username">{(id) => <input id={id} className="input" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>}
        <Field label="Display name">{(id) => <input id={id} className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
        <Field label="Workspace role">{(id) => <select id={id} className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}</Field>
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
