'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import type { UserLookupDto } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate } from '@/lib/utils';
import { usePerm } from '@/lib/perms';
import { Card, CardHeader, EmptyState, Field, InlineError, Loaded, Modal, PageHeader, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function MembersPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const mg = usePerm('members.manage');
  const q = useApi(() => Promise.all([api.members(id), api.roles()]), [id]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key); setErr(null);
    try { await fn(); if (ok) toast(ok); q.refetch(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Members" description="Who can work on this project and with which role."
        actions={<button className="btn btn-primary btn-sm" disabled={!mg.ok} title={mg.title} onClick={() => setAdding(true)}><Plus className="size-3.5" />Add member</button>} />
      <InlineError error={err} />
      <Loaded q={q}>
        {([members, allRoles]) => {
          const roles = allRoles.filter((r) => r.scope === 'project');
          return (
            <Card className="overflow-hidden">
              <CardHeader title="Project members" description={`${members.length} members. Users with the workspace "access all projects" permission see every project regardless.`} />
              {members.length === 0 ? <EmptyState title="No members" /> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>User</th><th>Role</th><th>Added</th><th className="text-right">Actions</th></tr></thead>
                    <tbody>
                      {members.map((m) => (
                        <tr key={m.userId}>
                          <td><div className="font-medium">{m.displayName}</div><div className="mono text-xs text-muted-foreground">{m.username}</div></td>
                          <td>
                            <select className="input h-8 w-auto" aria-label={`Role of ${m.username}`} value={m.role.id} disabled={!mg.ok || busy === m.userId} title={mg.title}
                              onChange={(e) => run(m.userId, () => api.updateMember(id, m.userId, { roleId: e.target.value }), 'Role changed')}>
                              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                          </td>
                          <td className="whitespace-nowrap text-muted-foreground">{fmtDate(m.createdAt)}</td>
                          <td className="text-right">
                            <button className="btn btn-ghost btn-icon size-8 text-danger" aria-label={`Remove ${m.username}`} disabled={!mg.ok || busy === m.userId} title={mg.title ?? 'Remove'}
                              onClick={() => { if (confirm(`Remove ${m.displayName} from this project?`)) void run(m.userId, () => api.removeMember(id, m.userId), 'Member removed'); }}>
                              {busy === m.userId ? <Spinner className="size-3.5" /> : <Trash2 className="size-3.5" />}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {adding && <AddMember projectId={id} roles={roles} exclude={members.map((m) => m.userId)} onClose={() => setAdding(false)} onAdded={() => { setAdding(false); toast('Member added'); q.refetch(); }} />}
            </Card>
          );
        }}
      </Loaded>
    </>
  );
}

function AddMember({ projectId, roles, exclude, onClose, onAdded }: { projectId: string; roles: { id: string; name: string }[]; exclude: string[]; onClose: () => void; onAdded: () => void }) {
  const [term, setTerm] = useState('');
  const [found, setFound] = useState<UserLookupDto[]>([]);
  const [user, setUser] = useState<UserLookupDto | null>(null);
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (!term.trim()) { setFound([]); return; }
      api.userLookup(term.trim()).then(setFound, (e: Error) => setErr(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [term]);

  async function save() {
    if (!user) return;
    setBusy(true); setErr(null);
    try { await api.addMember(projectId, { userId: user.id, roleId }); onAdded(); } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Add member" size="max-w-md"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !user || !roleId} onClick={save}>{busy && <Spinner />}Add</button></>}>
      <div className="space-y-4">
        <Field label="Find a user" hint="Search by username or name.">
          {(i) => <input id={i} className="input" autoComplete="off" value={user ? `${user.displayName} (${user.username})` : term} readOnly={!!user}
            onChange={(e) => setTerm(e.target.value)} onFocus={() => user && setUser(null)} />}
        </Field>
        {!user && found.filter((u) => !exclude.includes(u.id)).length > 0 && (
          <ul className="max-h-48 overflow-y-auto rounded-md border">
            {found.filter((u) => !exclude.includes(u.id)).map((u) => (
              <li key={u.id}><button className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted" onClick={() => setUser(u)}>{u.displayName}<span className="mono text-xs text-muted-foreground">{u.username}</span></button></li>
            ))}
          </ul>
        )}
        <Field label="Role">{(i) => <select id={i} className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>}</Field>
        <InlineError error={err} />
      </div>
    </Modal>
  );
}
