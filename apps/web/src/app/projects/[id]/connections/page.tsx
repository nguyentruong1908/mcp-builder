'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { Pencil, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import type { AgentAccess, AuthType, ConnectionDto, UpsertConnectionInput } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, fmtDate } from '@/lib/utils';
import { Badge, Card, CardHeader, EmptyState, Field, InlineError, Loaded, Modal, PageHeader, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/toast';

const agentAccessLabel: Record<AgentAccess, string> = { read_only: 'Chỉ tool đọc', write: 'Đọc + ghi (không xóa)', write_destructive: 'Đọc + ghi + xóa' };

const EMPTY: UpsertConnectionInput = { name: 'test', baseUrl: '', authType: 'bearer', authHeader: 'Authorization', secretRef: 'env://', allowWrite: false, agentAccess: 'read_only', useForQa: true };
const authLabel: Record<AuthType, string> = { none: 'Không xác thực', api_key: 'API key (header)', bearer: 'Bearer token' };

export default function ConnectionsPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const q = useApi(() => api.connections(id), [id]);
  const [editing, setEditing] = useState<ConnectionDto | 'new' | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  async function test(c: ConnectionDto) {
    setTesting(c.id);
    try {
      await api.testConnection(c.id);
      const list = await api.connections(id);
      q.setData(list);
      const chk = list.find((x) => x.id === c.id)?.lastCheck;
      toast(chk ? (chk.ok ? `Kết nối ${c.name} OK${chk.latencyMs != null ? ` · ${chk.latencyMs}ms` : ''}` : `Kết nối ${c.name} lỗi: ${chk.message ?? chk.status}`) : 'Đã kiểm tra', chk && !chk.ok ? 'error' : 'ok');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setTesting(null); }
  }
  async function remove(c: ConnectionDto) {
    if (!confirm(`Xóa môi trường “${c.name}”?`)) return;
    try { await api.deleteConnection(c.id); q.setData((p) => (p ?? []).filter((x) => x.id !== c.id)); toast('Đã xóa'); }
    catch (e) { toast((e as Error).message, 'error'); }
  }

  return (
    <>
      <PageHeader title="Connections"
        description={<>Môi trường dùng để kiểm thử. Factory chỉ lưu <b className="text-foreground">tham chiếu</b> secret (<code className="mono">env://VAR</code>); credential thật không bao giờ được đóng vào artifact.</>}
        actions={<button className="btn btn-outline" onClick={() => setEditing('new')}><Plus className="size-4" />Thêm môi trường</button>} />
      <Loaded q={q}>
        {(list) => list.length === 0 ? (
          <Card><EmptyState icon={<Plug className="size-5" />} title="Chưa có môi trường" description="Thêm môi trường test để chạy integration QA. Không có môi trường, kết quả integration sẽ là NOT RUN."
            action={<button className="btn btn-primary btn-sm" onClick={() => setEditing('new')}><Plus className="size-3.5" />Thêm môi trường</button>} /></Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {list.map((c) => (
              <Card key={c.id} className={cn(c.useForQa && 'ring-1 ring-brand/50')}>
                <CardHeader
                  title={<span className="flex items-center gap-2"><span className="mono text-base">{c.name}</span>{c.useForQa && <Badge tone="brand">Dùng cho QA</Badge>}</span>}
                  actions={c.lastCheck ? <Badge tone={c.lastCheck.ok ? 'success' : 'danger'}><span className="size-1.5 rounded-full bg-current" />{c.lastCheck.ok ? 'OK' : 'Lỗi'}</Badge> : <Badge>Chưa kiểm tra</Badge>}
                />
                <dl className="kv px-5 pb-5">
                  <dt>Base URL</dt><dd className="mono break-all text-xs">{c.baseUrl}</dd>
                  <dt>Auth</dt><dd>{authLabel[c.authType]}{c.authType === 'api_key' && <> · <code className="mono">{c.authHeader}</code></>}</dd>
                  <dt>Secret</dt><dd className="flex flex-wrap items-center gap-1.5">{c.authType === 'none' ? '—' : <><span className="mono text-xs">{c.secretRef}</span><Badge tone={c.secretResolvable ? 'success' : 'warning'}>{c.secretResolvable ? 'có giá trị' : 'thiếu biến môi trường'}</Badge></>}</dd>
                  <dt>Ghi dữ liệu</dt><dd><Badge tone={c.allowWrite ? 'warning' : 'outline'}>{c.allowWrite ? 'Cho phép' : 'Không'}</Badge></dd>
                  <dt>Agent eval</dt><dd><Badge tone={c.agentAccess === 'read_only' ? 'outline' : c.agentAccess === 'write' ? 'warning' : 'danger'}>{agentAccessLabel[c.agentAccess ?? 'read_only']}</Badge></dd>
                  {c.lastCheck && <><dt>Kiểm tra</dt><dd className="text-xs">{fmtDate(c.lastCheck.at)}{c.lastCheck.status != null && ` · HTTP ${c.lastCheck.status}`}{c.lastCheck.latencyMs != null && ` · ${c.lastCheck.latencyMs}ms`}{c.lastCheck.message && <div className="text-muted-foreground">{c.lastCheck.message}</div>}</dd></>}
                </dl>
                <div className="flex gap-2 border-t px-5 py-3">
                  <button className="btn btn-outline btn-sm" disabled={testing === c.id} onClick={() => test(c)}>{testing === c.id ? <Spinner className="size-3.5" /> : <PlugZap className="size-3.5" />}Kiểm tra kết nối</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(c)}><Pencil className="size-3.5" />Sửa</button>
                  <button className="btn btn-ghost btn-sm ml-auto text-danger" onClick={() => remove(c)} aria-label={`Xóa ${c.name}`}><Trash2 className="size-3.5" /></button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Loaded>
      {editing && (
        <ConnectionForm projectId={id} initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); q.refetch(); toast('Đã lưu môi trường'); }} />
      )}
    </>
  );
}

function ConnectionForm({ projectId, initial, onClose, onSaved }: { projectId: string; initial: ConnectionDto | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<UpsertConnectionInput>(() => {
    if (!initial) return EMPTY;
    const { id: _i, secretResolvable: _s, lastCheck: _l, ...rest } = initial;
    return rest;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof UpsertConnectionInput>(k: K, v: UpsertConnectionInput[K]) => setF((x) => ({ ...x, [k]: v }));

  async function save() {
    if (!f.name.trim() || !/^https?:\/\//.test(f.baseUrl)) return setErr('Cần tên và Base URL bắt đầu bằng http(s)://');
    if (f.authType !== 'none' && !/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(f.secretRef)) return setErr('Secret phải là tham chiếu dạng env://TEN_BIEN, không nhập giá trị secret.');
    setBusy(true); setErr(null);
    try {
      if (initial) await api.updateConnection(initial.id, f); else await api.createConnection(projectId, f);
      onSaved();
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={initial ? `Sửa môi trường ${initial.name}` : 'Thêm môi trường'}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Hủy</button><button className="btn btn-primary" disabled={busy} onClick={save}>{busy && <Spinner />}Lưu</button></>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tên">{(i) => <input id={i} className="input font-mono text-xs" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="dev / test / prod" />}</Field>
        <Field label="Kiểu xác thực">
          {(i) => (
            <select id={i} className="input" value={f.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
              {(Object.keys(authLabel) as AuthType[]).map((k) => <option key={k} value={k}>{authLabel[k]}</option>)}
            </select>
          )}
        </Field>
        <Field label="Base URL" className="sm:col-span-2">{(i) => <input id={i} className="input font-mono text-xs" value={f.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} placeholder="https://erp-test.example.internal" />}</Field>
        {f.authType === 'api_key' && <Field label="Header">{(i) => <input id={i} className="input font-mono text-xs" value={f.authHeader} onChange={(e) => set('authHeader', e.target.value)} placeholder="X-Api-Key" />}</Field>}
        {f.authType !== 'none' && (
          <Field label="Tham chiếu secret" hint="Giá trị đọc từ biến môi trường của API khi chạy QA." className={f.authType === 'api_key' ? '' : 'sm:col-span-2'}>
            {(i) => <input id={i} className="input font-mono text-xs" value={f.secretRef} onChange={(e) => set('secretRef', e.target.value)} placeholder="env://ERP_TEST_TOKEN" />}
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm"><Switch label="Dùng cho QA" checked={f.useForQa} onChange={(v) => set('useForQa', v)} />Dùng cho QA</label>
        <label className="flex items-center gap-2 text-sm"><Switch label="Cho phép ghi dữ liệu" checked={f.allowWrite} onChange={(v) => setF((x) => ({ ...x, allowWrite: v, agentAccess: v ? x.agentAccess : 'read_only' }))} />Cho phép tool ghi chạy</label>
        <Field label="Agent eval được phép" className="sm:col-span-2"
          hint={f.allowWrite
            ? 'Agent chạy full access và tự duyệt: với mức có ghi/xóa, agent có thể thay đổi dữ liệu thật trên môi trường này khi làm tác vụ mẫu.'
            : 'Bật "Cho phép tool ghi chạy" để cho agent dùng tool ghi/xóa. Test case live trên tool ghi cũng cần quyền này.'}>
          {(i) => (
            <select id={i} className="input" value={f.agentAccess} disabled={!f.allowWrite} onChange={(e) => set('agentAccess', e.target.value as AgentAccess)}>
              {(Object.keys(agentAccessLabel) as AgentAccess[]).map((k) => <option key={k} value={k}>{agentAccessLabel[k]}</option>)}
            </select>
          )}
        </Field>
        <div className="sm:col-span-2"><InlineError error={err} /></div>
      </div>
    </Modal>
  );
}
