'use client';

import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import type { SettingsDto } from '@mcp-factory/shared';
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
      <PageHeader title="Settings & Audit" description="Tài khoản Codex, ngân sách, giới hạn build và lịch sử thao tác." />
      <div className="alert alert-info mb-6">
        <Info className="mt-0.5 size-4 shrink-0 text-info" />
        <div>Bản này chưa bật đăng nhập: mọi thao tác ghi dưới một người dùng mặc định. Quản lý thành viên và vai trò sẽ có khi bật auth.</div>
      </div>
      <Tabs className="mb-6" value={tab} onChange={setTab} tabs={[{ id: 'codex', label: 'Codex' }, { id: 'generation', label: 'Generation profile' }, { id: 'budget', label: 'Ngân sách & giới hạn' }, { id: 'audit', label: 'Audit log' }]} />
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
    { key: 'maxCostUsdPerBuild', label: 'Trần chi phí Codex / build (USD)' },
    { key: 'maxRepairRounds', label: 'Số vòng tự sửa build', hint: 'Khi TypeScript build lỗi. Hết vòng thì build fail rõ ràng và không chi thêm.' },
    { key: 'maxQaRepairRounds', label: 'Số vòng tự sửa theo QA', hint: 'Khi QA có lỗi sửa được bằng code (contract, xử lý lỗi, test case, integration, agent), Codex được gửi kết quả lỗi để sửa rồi chạy lại QA. 0 = tắt.' },
    { key: 'monthlyBudgetUsd', label: 'Ngân sách tháng (USD)' },
    { key: 'buildTimeoutMin', label: 'Timeout build (phút)' },
  ];

  async function save() {
    if (!form) return;
    setBusy(true); setErr(null);
    try {
      const { codexModel: _, ...input } = form;
      q.setData(await api.saveSettings(input));
      toast('Đã lưu cấu hình');
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
            <Field label="Codex model" hint="Đặt bằng biến môi trường CODEX_MODEL của API.">
              {(id) => <input id={id} className="input font-mono text-xs" value={form.codexModel} disabled />}
            </Field>
          </div>
          <div className="mt-4"><InlineError error={err} /></div>
          <div className="mt-6 flex justify-end gap-2 border-t pt-4">
            <button className="btn btn-ghost" onClick={() => q.data && setForm(q.data)}>Hoàn tác</button>
            <button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Lưu</button>
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
          <CardHeader title="Audit log" description={`${rows.length} thao tác gần nhất`} />
          {rows.length === 0 ? <EmptyState title="Chưa có thao tác nào" /> : (
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Lúc</th><th>Người</th><th>Thao tác</th><th>Đối tượng</th></tr></thead>
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
