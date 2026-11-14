'use client';

import { useEffect, useState } from 'react';
import type { GenerationProfile } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate } from '@/lib/utils';
import { Badge, Card, CardHeader, InlineError, Loaded, Spinner } from '@/components/ui';
import { GenerationFields } from '@/components/generation-form';
import { useToast } from '@/components/toast';

/** Workspace-level generation profile: default for every project. */
export function GenerationProfilePanel() {
  const q = useApi(() => Promise.all([api.generationProfile(), api.codexModels().catch(() => []), api.settings()]), []);
  const toast = useToast();
  const [form, setForm] = useState<GenerationProfile>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (q.data) { const { model, reasoningEffort, rules } = q.data[0]; setForm({ model, reasoningEffort, rules }); } }, [q.data]);

  async function save() {
    if (!form) return;
    setBusy(true); setErr(null);
    try {
      const saved = await api.saveGenerationProfile(form);
      q.setData((prev) => (prev ? [saved, prev[1], prev[2]] : prev));
      toast(`Generation profile v${saved.version} saved`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Loaded q={q}>
      {([profile, models, settings]) => form && (
        <Card className="max-w-3xl">
          <CardHeader title="Workspace generation profile"
            description="How Codex generates adapters for every project. Projects can override model/reasoning and append their own rules."
            actions={<Badge tone="outline">v{profile.version}{profile.updatedAt ? ` · ${fmtDate(profile.updatedAt)}` : ''}</Badge>} />
          <div className="px-5 pb-5">
            <GenerationFields value={form} onChange={setForm} models={models}
              inheritedModel={settings.codexModel} inheritedLabel={`the server CODEX_MODEL (${settings.codexModel})`}
              rulesLabel="Workspace rules (AGENTS.md)" />
            <div className="mt-4"><InlineError error={err} /></div>
            <div className="mt-6 flex items-center justify-end gap-2 border-t pt-4">
              <span className="mr-auto text-xs text-muted-foreground">Each save creates a new version; builds record the version and the rules hash in provenance.</span>
              <button className="btn btn-ghost" onClick={() => setForm({ model: profile.model, reasoningEffort: profile.reasoningEffort, rules: profile.rules })}>Revert</button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Save</button>
            </div>
          </div>
        </Card>
      )}
    </Loaded>
  );
}
