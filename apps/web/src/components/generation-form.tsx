'use client';

import { useState } from 'react';
import { CheckCircle2, FlaskConical, Sparkles } from 'lucide-react';
import type { CodexModelOption, GenerationProfile, ModelCheckResult, ReasoningEffort } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { Field, InlineError, Spinner } from './ui';

export const RULES_HINT = 'Ghi thành AGENTS.md trong workspace build. Chỉ bổ sung quy ước (ngôn ngữ thông báo lỗi, cách rút gọn response, đặt tên…); không thể nới các ràng buộc cố định: phạm vi file, không mạng, không secret, không thêm dependency.';

const SAMPLE_RULES = `## Quy ước sinh adapter

- Thông báo lỗi (describeError) viết bằng tiếng Việt, ngắn gọn, nêu bước agent nên làm tiếp.
- Luôn giữ id, mã chứng từ, trạng thái, tổng tiền và nextCursor trong response; không bỏ trường phân trang.
- Chỉ rút gọn response danh sách khi mỗi phần tử có hơn 15 trường; giữ nguyên thứ tự phần tử.
- Tiền tệ là VND (số nguyên), không tự đổi đơn vị hay làm tròn.
- Không đoán quy tắc nghiệp vụ không có trong context.md.
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
        <Field label="Model" hint={value.model === null ? `Đang dùng ${inheritedLabel}.` : 'Gõ slug khác nếu model không có trong danh sách.'}>
          {(id) => (
            <>
              <input id={id} list={`${id}-models`} className="input font-mono text-xs" placeholder={`${inheritedModel} (mặc định)`}
                value={value.model ?? ''} onChange={(e) => { setCheck(null); onChange({ ...value, model: e.target.value.trim() || null }); }} />
              <datalist id={`${id}-models`}>
                {models.map((m) => <option key={m.slug} value={m.slug}>{m.displayName}</option>)}
              </datalist>
            </>
          )}
        </Field>
        <Field label="Reasoning effort" hint={`Mặc định của ${effectiveModel}: ${opt?.defaultReasoning ?? 'không rõ'}.`}>
          {(id) => (
            <select id={id} className="input" value={value.reasoningEffort ?? ''} onChange={(e) => onChange({ ...value, reasoningEffort: (e.target.value || null) as ReasoningEffort | null })}>
              <option value="">Mặc định của model{opt?.defaultReasoning ? ` (${opt.defaultReasoning})` : ''}</option>
              {[...new Set([...efforts, ...(value.reasoningEffort ? [value.reasoningEffort] : [])])].map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-outline btn-sm" disabled={checking || !effectiveModel} onClick={runCheck}>
          {checking ? <Spinner /> : <FlaskConical className="size-3.5" />}Kiểm tra model
        </button>
        {checking && <span className="text-xs text-muted-foreground">Đang chạy một lệnh Codex nhỏ với {effectiveModel}… (30–60 giây)</span>}
        {check?.ok && <span className="inline-flex items-center gap-1.5 text-xs text-success"><CheckCircle2 className="size-3.5" />{check.model}: {check.message}</span>}
      </div>
      {check && !check.ok && <InlineError error={`${check.model}: ${check.message}`} />}
      <InlineError error={checkErr} />
      <Field label={<span className="flex items-center justify-between gap-2">{rulesLabel}
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({ ...value, rules: value.rules.trim() ? `${value.rules.trimEnd()}\n\n${SAMPLE_RULES}` : SAMPLE_RULES })}><Sparkles className="size-3.5" />Chèn mẫu</button></span>}
        hint={RULES_HINT}>
        {(id) => <textarea id={id} className="textarea min-h-[220px] font-mono text-xs" spellCheck={false} placeholder="## Quy ước của đội…" value={value.rules} onChange={(e) => onChange({ ...value, rules: e.target.value })} />}
      </Field>
    </div>
  );
}
