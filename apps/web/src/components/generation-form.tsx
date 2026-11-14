'use client';

import { useState } from 'react';
import { CheckCircle2, FlaskConical, Sparkles } from 'lucide-react';
import type { CodexModelOption, GenerationProfile, ModelCheckResult, ReasoningEffort } from '@mcp-builder/shared';
import { api } from '@/lib/api';
import { Field, InlineError, Spinner } from './ui';

export const RULES_HINT = 'Written to AGENTS.md in the build workspace. Add conventions only (error message language, response trimming, naming…); fixed constraints cannot be relaxed: file scope, no network, no secrets, no new dependencies.';

const SAMPLE_RULES = `## Adapter conventions

- Error messages (describeError) are short and say what the agent should do next.
- Always keep ids, document codes, statuses, totals and nextCursor in responses; never drop pagination fields.
- Only trim list responses when items have more than 15 fields; keep item order.
- Amounts are integer VND; never convert units or round.
- Never guess business rules that are not in context.md.
`;

/**
 * Model / reasoning / rules fields shared by the workspace profile and the project override.
 * `inheritedModel` is what `model: null` resolves to (CODEX_MODEL or the workspace model).
 */
export function GenerationFields({ value, onChange, models, inheritedModel, inheritedLabel, rulesLabel }: {
  value: GenerationProfile;
  onChange: (v: GenerationProfile) => void;
  models: CodexModelOption[];
  inheritedModel: string;
  inheritedLabel: string;
  rulesLabel: string;
}) {
  const [check, setCheck] = useState<ModelCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const effectiveModel = value.model ?? inheritedModel;
  const opt = models.find((m) => m.slug === effectiveModel);
  const efforts: ReasoningEffort[] = opt?.reasoningEfforts ?? ['low', 'medium', 'high', 'xhigh'];

  async function runCheck() {
    setChecking(true); setCheck(null); setCheckErr(null);
    try { setCheck(await api.checkModel(effectiveModel)); } catch (e) { setCheckErr((e as Error).message); } finally { setChecking(false); }
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Model" hint={value.model === null ? `Using ${inheritedLabel}.` : 'Type another slug if the model is not listed.'}>
          {(id) => (
            <>
              <input id={id} list={`${id}-models`} className="input font-mono text-xs" placeholder={`${inheritedModel} (default)`}
                value={value.model ?? ''} onChange={(e) => { setCheck(null); onChange({ ...value, model: e.target.value.trim() || null }); }} />
              <datalist id={`${id}-models`}>
                {models.map((m) => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Reasoning effort" hint={`${effectiveModel} default: ${opt?.defaultReasoning ?? 'unknown'}.`}>
          {(id) => (
            <select id={id} className="input" value={value.reasoningEffort ?? ''} onChange={(e) => onChange({ ...value, reasoningEffort: (e.target.value || null) as ReasoningEffort | null })}>
              <option value="">Model default{opt?.defaultReasoning ? ` (${opt.defaultReasoning})` : ''}</option>
              {[...new Set([...efforts, ...(value.reasoningEffort ? [value.reasoningEffort] : [])])].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-outline btn-sm" disabled={checking || !effectiveModel} onClick={runCheck}>
          {checking ? <Spinner /> : <FlaskConical className="size-3.5" />}Check model
        </button>
        {checking && <span className="text-xs text-muted-foreground">Running a tiny Codex turn with {effectiveModel}… (30–60 seconds)</span>}
        {check?.ok && <span className="inline-flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" />{check.model}: {check.message}</span>}
      </div>
      {check && !check.ok && <InlineError error={`${check.model}: ${check.message}`} />}
      <InlineError error={checkErr} />
      <Field label={<span className="flex items-center justify-between gap-2">{rulesLabel}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...value, rules: value.rules.trim() ? `${value.rules.trimEnd()}\n\n${SAMPLE_RULES}` : SAMPLE_RULES })}><Sparkles className="size-3.5" />Insert example</button></span>}
        hint={RULES_HINT}>
        {(id) => <textarea id={id} className="textarea min-h-[220px] font-mono text-xs" spellCheck={false} placeholder="## Team conventions…" value={value.rules} onChange={(e) => onChange({ ...value, rules: e.target.value })} />}
      </Field>
    </div>
  );
}
