'use client';

import { useEffect, useState } from 'react';
import type { GenerationProfile } from '@mcp-factory/shared';
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
      toast(`Đã lưu generation profile v${saved.version}`);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <Loaded q={q}>
      {([profile, models, settings]) => form && (
        <Card className="max-w-3xl">
          <CardHeader title="Generation profile của workspace"
            description="Cách Codex sinh adapter cho mọi project. Project có thể ghi đè model/reasoning và nối thêm quy tắc riêng."
            actions={<Badge tone="outline">v{profile.version}{profile.updatedAt ? ` · ${fmtDate(profile.updatedAt)}` : ''}</Badge>} />
          <div className="px-5 pb-5">
            <GenerationFields value={form} onChange={setForm} models={models}
              inheritedModel={settings.codexModel} inheritedLabel={`CODEX_MODEL của máy chủ (${settings.codexModel})`}
              rulesLabel="Quy tắc của workspace (AGENTS.md)" />
            <div className="mt-4"><InlineError error={err} /></div>
            <div className="mt-6 flex items-center justify-end gap-2 border-t pt-4">
              <span className="mr-auto text-xs text-muted-foreground">Mỗi lần lưu tạo version mới; build ghi version và hash quy tắc vào provenance.</span>
              <button className="btn btn-ghost" onClick={() => setForm({ model: profile.model, reasoningEffort: profile.reasoningEffort, rules: profile.rules })}>Hoàn tác</button>
              <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Lưu</button>
            </div>
          </div>
        </Card>
      )}
    </Loaded>
  );
}
