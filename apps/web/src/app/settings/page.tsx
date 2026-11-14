'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SettingsDto } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { hasWorkspacePerm, useMe } from '@/lib/auth';
import { deniedTitle, permLabel } from '@/lib/perms';
import { useApi } from '@/lib/use-api';
import { fmtDate, initials } from '@/lib/utils';
import { Card, CardHeader, EmptyState, Field, InlineError, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';
import { CodexAuthPanel } from './codex-auth';
import { GenerationProfilePanel } from './generation-profile';
import { UsersPanel } from './users';
import { RolesPanel } from './roles';

type Tab = 'codex' | 'generation' | 'budget' | 'users' | 'roles' | 'audit';

export default function SettingsPage() {
  const { me } = useMe();
  const [tab, setTab] = useState<Tab>('codex');
  const tabs = useMemo(() => {
    const all: { id: Tab; label: string; perm?: Parameters<typeof hasWorkspacePerm>[1] }[] = [
      { id: 'codex', label: 'Codex' }, { id: 'generation', label: 'Generation profile' }, { id: 'budget', label: 'Budget & limits' },
      { id: 'users', label: 'Users', perm: 'users.manage' }, { id: 'roles', label: 'Roles', perm: 'roles.manage' }, { id: 'audit', label: 'Audit log', perm: 'audit.read' },
    ];
    return all.filter((t) => !t.perm || hasWorkspacePerm(me, t.perm));
  }, [me]);
  return (
    <>
      <PageHeader title="Settings & Audit" description="Codex account, budget, build limits and activity history." />
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'codex' ? <CodexAuthPanel /> : tab === 'generation' ? <GenerationProfilePanel /> : tab === 'budget' ? <BudgetForm /> : tab === 'users' ? <UsersPanel /> : tab === 'roles' ? <RolesPanel /> : <AuditLog />}
    </>
  );
}

function BudgetForm() {
  const q = useApi(() => api.settings(), []);
  const toast = useToast();
  const canEdit = hasWorkspacePerm(useMe().me, 'settings.manage');
  const [form, setForm] = useState<SettingsDto>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data) setForm(q.data); }, [q.data]);

  const fields: { key: keyof Omit<SettingsDto, 'codexModel'>; label: string; hint?: string }[] = [
    { key: 'maxCostUsdPerBuild', label: 'Codex cost cap per build (USD)' },
    { key: 'maxRepairRounds', label: 'Build repair rounds', hint: 'When the TypeScript build fails. Once exhausted, the build fails clearly and spends nothing more.' },
    { key: 'maxQaRepairRounds', label: 'QA repair rounds', hint: 'When QA has code-fixable failures (contract, error handling, test cases, integration, agent), Codex receives them to fix and QA runs again. 0 = off.' },
    { key: 'monthlyBudgetUsd', label: 'Monthly budget (USD)' },
    { key: 'buildTimeoutMin', label: 'Build timeout (minutes)' },
  ];

  async function save() {
    if (!form) return;
    setBusy(true); setErr(null);
    try {
      const { codexModel: _, ...input } = form;
      q.setData(await api.saveSettings(input));
      toast('Settings saved');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Loaded q={q}>
      {() => form && (
        <Card className="max-w-2xl px-5 pt-5 pb-5">
          <div className="grid gap-5 sm:grid-cols-2">
            {fields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint}>
                {(id) => <input id={id} type="number" min={0} disabled={!canEdit} title={deniedTitle(canEdit, permLabel('settings.manage'))} className="input" value={form[f.key] ?? 0} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })} />}
              </Field>
            ))}
            <Field label="Codex model" hint="Set with the API's CODEX_MODEL environment variable.">
              {(id) => <input id={id} className="input font-mono text-xs" value={form.codexModel} disabled />}
            </Field>
          </div>
          <div className="mt-4"><InlineError error={err} /></div>
          <div className="mt-6 flex justify-end gap-2 border-t pt-4">
            <button className="btn btn-ghost" disabled={!canEdit} onClick={() => q.data && setForm(q.data)}>Revert</button>
            <button className="btn btn-primary" disabled={busy || !canEdit} title={deniedTitle(canEdit, permLabel('settings.manage'))} onClick={save}>{busy && <Spinner />}Save</button>
          </div>
        </Card>
      )}
    </Loaded>
  );
}

function AuditLog() {
  const q = useApi(() => api.audit(), []);
  return (
    <Loaded q={q}>
      {(rows) => (
        <Card className="overflow-hidden">
          <CardHeader title="Audit log" description={`${rows.length} most recent actions`} />
          {rows.length === 0 ? <EmptyState title="No actions yet" /> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(a.at)}</td>
                      <td><span className="avatar" title={a.actor}>{initials(a.actor)}</span></td>
                      <td><span className="badge badge-outline">{a.action}</span></td>
                      <td className="mono">{a.target}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </Loaded>
  );
}
