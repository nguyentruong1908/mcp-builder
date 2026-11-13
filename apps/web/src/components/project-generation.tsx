'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { EffectiveGeneration, GenerationProfile } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { Badge, Card, CardHeader, InlineError, Loaded, Spinner, Switch } from './ui';
import { GenerationFields } from './generation-form';
import { useToast } from './toast';

const SOURCE_LABEL: Record<string, string> = { project: 'project', workspace: 'workspace', env: 'CODEX_MODEL', default: 'model default' };
const EMPTY: GenerationProfile = { model: null, reasoningEffort: null, rules: '' };

export function EffectiveGenerationSummary({ g }: { g: EffectiveGeneration }) {
  return (
    <dl className="kv">
      <dt>Model</dt><dd><span className="mono">{g.model}</span> <Badge tone="outline">{SOURCE_LABEL[g.source.model]}</Badge></dd>
      <dt>Reasoning</dt><dd><span className="mono">{g.reasoningEffort ?? 'default'}</span> <Badge tone="outline">{SOURCE_LABEL[g.source.reasoningEffort]}</Badge></dd>
      <dt>Profile</dt><dd className="mono text-xs">workspace v{g.workspaceVersion}{g.projectVersion !== null ? ` · project v${g.projectVersion}` : ''} · rules {g.rulesSha256.slice(0, 12)}</dd>
    </dl>
  );
}

/** Project overview card: effective profile + optional project override. */
export function ProjectGenerationCard({ projectId }: { projectId: string }) {
  const q = useApi(() => Promise.all([api.projectGeneration(projectId), api.codexModels().catch(() => [])]), [projectId]);
  const toast = useToast();
  const [draft, setDraft] = useState<GenerationProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const override = q.data?.[0].override;
  useEffect(() => { setDraft(override ? { model: override.model, reasoningEffort: override.reasoningEffort, rules: override.rules } : null); }, [override]);

  const setGen = (g: Awaited<ReturnType<typeof api.projectGeneration>>) => q.setData((prev) => (prev ? [g, prev[1]] : prev));

  async function toggle(on: boolean) {
    setErr(null);
    if (on) { setDraft({ ...EMPTY }); return; }
    if (!override) { setDraft(null); return; }
    if (!confirm('Remove the override? The project will use the workspace generation profile for future builds.')) return;
    setBusy(true);
    try { setGen(await api.clearProjectGeneration(projectId)); toast('Generation profile override removed'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function save() {
    if (!draft) return;
    setBusy(true); setErr(null);
    try { const g = await api.saveProjectGeneration(projectId, draft); setGen(g); toast(`Override v${g.override?.version ?? ''} saved`); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Card className="mt-4">
      <Loaded q={q}>
        {([g, models]) => (
          <>
            <CardHeader title="Generation profile" description="Model, reasoning and rules Codex uses to generate this project's adapters"
              actions={<label className="flex items-center gap-2 text-sm"><Switch checked={draft !== null} onChange={toggle} label="Override for this project" disabled={busy} />Override for this project</label>} />
            <div className="space-y-4 px-5 pb-5">
              <EffectiveGenerationSummary g={g.effective} />
              <details className="rounded-md border px-3 py-2">
                <summary className="cursor-pointer text-sm font-medium">Workspace rules (v{g.workspace.version}, read-only)</summary>
                {g.workspace.rules.trim()
                  ? <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">{g.workspace.rules}</pre>
                  : <p className="mt-2 text-xs text-muted-foreground">None yet. Set them in <Link href="/settings" className="underline">Settings › Generation profile</Link>.</p>}
              </details>
              {draft && (
                <div className="rounded-lg border p-4">
                  <GenerationFields value={draft} onChange={setDraft} models={models}
                    inheritedModel={g.workspace.model ?? g.effective.model} inheritedLabel={`the workspace model (${g.workspace.model ?? g.effective.model})`}
                    rulesLabel="Extra project rules (appended after the workspace rules)" />
                  <div className="mt-4 flex justify-end gap-2 border-t pt-4">
                    {override && <span className="mr-auto self-center text-xs text-muted-foreground">Override v{override.version}</span>}
                    <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save override</button>
                  </div>
                </div>
              )}
              <InlineError error={err} />
            </div>
          </>
        )}
      </Loaded>
    </Card>
  );
}
