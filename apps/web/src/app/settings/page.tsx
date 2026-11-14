'use client';

import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type { SettingsDto } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate, initials } from '@/lib/utils';
import { Card, CardHeader, EmptyState, Field, InlineError, Loaded, PageHeader, Spinner, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';
import { CodexAuthPanel } from './codex-auth';
import { GenerationProfilePanel } from './generation-profile';

type Tab = 'codex' | 'generation' | 'budget' | 'audit';

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>('codex');
  return (
    <>
      <PageHeader title="Settings & Audit" description="Codex account, budget, build limits and activity history." />
      <div className="alert alert-info mb-6">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <div>Sign-in is not enabled in this version: all actions are recorded under a default user. Members and roles arrive with auth.</div>
      </div>
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={[{ id: 'codex', label: 'Codex' }, { id: 'generation', label: 'Generation profile' }, { id: 'budget', label: 'Budget & limits' }, { id: 'audit', label: 'Audit log' }]} />
      {tab === 'codex' ? <CodexAuthPanel /> : tab === 'generation' ? <GenerationProfilePanel /> : tab === 'budget' ? <BudgetForm /> : <AuditLog />}
    </>
  );
}

function BudgetForm() {
  const q = useApi(() => api.settings(), []);
  const toast = useToast();
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
                {(id) => <input id={id} type="number" min={0} className="input" value={form[f.key] ?? 0} onChange={(e) => setForm({ ...form, [f.key]: Number(e.target.value) })} />}
              </Field>
            ))}
            <Field label="Codex model" hint="Set with the API's CODEX_MODEL environment variable.">
              {(id) => <input id={id} className="input font-mono text-xs" value={form.codexModel} disabled />}
            </Field>
          </div>
          <div className="mt-4"><InlineError error={err} /></div>
          <div className="mt-6 flex justify-end gap-2 border-t pt-4">
            <button className="btn btn-ghost" onClick={() => q.data && setForm(q.data)}>Revert</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button>
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
