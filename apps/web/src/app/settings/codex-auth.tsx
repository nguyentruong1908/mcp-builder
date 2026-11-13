'use client';

import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, FileJson, KeyRound, LogOut, MonitorSmartphone, ShieldAlert, TriangleAlert } from 'lucide-react';
import type { CodexAuthStatus } from '@mcp-factory/shared';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate } from '@/lib/utils';
import { Badge, Card, CardHeader, Field, InlineError, Loaded, Spinner, Tabs } from '@/components/ui';
import { useToast } from '@/components/toast';

type Method = 'device' | 'apikey' | 'upload';

export function CodexAuthPanel() {
  const q = useApi(() => api.codexAuth(), []);
  const pending = q.data?.device.state === 'pending';
  const { refetch } = q;

  // Poll while a device login waits for the user to confirm in the browser.
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(refetch, 3000);
    return () => clearInterval(t);
  }, [pending, refetch]);

  return (
    <Loaded q={q}>
      {(s) => (
        <div className="grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <StatusCard s={s} onChange={q.setData} />
          <LoginCard s={s} onChange={q.setData} />
        </div>
      )}
    </Loaded>
  );
}

function StatusCard({ s, onChange }: { s: CodexAuthStatus; onChange: (s: CodexAuthStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function logout() {
    if (!confirm('Sign Codex out of Factory? New builds will not run until you sign in again.')) return;
    setBusy(true);
    try { onChange(await api.codexLogout()); toast('Codex signed out'); } finally { setBusy(false); }
  }
  const rows: [string, React.ReactNode][] = [
    ['Source', s.source === 'env_api_key' ? 'CODEX_API_KEY environment variable' : s.source === 'auth_file' ? "auth.json in Factory's CODEX_HOME" : '—'],
    ['Type', s.mode === 'chatgpt' ? 'ChatGPT account' : s.mode === 'api_key' ? 'API key' : '—'],
    ['Account', s.email ?? '—'],
    ['Plan', s.plan ?? '—'],
    ['Token refreshed', s.lastRefresh ? fmtDate(s.lastRefresh) : '—'],
    ['Codex CLI', <span key="v" className="mono">{s.codexVersion}</span>],
    ['Model', <span key="m" className="mono">{s.model}</span>],
    ['Sandbox', <span key="s" className="inline-flex items-center gap-2"><span className="mono">{s.sandbox}</span>{s.sandbox === 'workspace-write' && (s.sandboxError ? <Badge tone="danger">error</Badge> : <Badge tone="success">working</Badge>)}</span>],
  ];
  return (
    <Card className="h-fit">
      <CardHeader
        title="Codex status"
        description="The account Factory uses to generate code in builds"
        actions={s.configured ? <Badge tone="success"><CheckCircle2 className="size-3" />Signed in</Badge> : <Badge tone="danger">Not signed in</Badge>}
      />
      <dl className="kv px-5 pb-5">
        {rows.map(([k, v]) => (<div key={k} className="contents"><dt>{k}</dt><dd>{v}</dd></div>))}
      </dl>
      {s.sandboxError && (
        <div className="alert alert-danger mx-5 mb-5"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" /><div><b>The Codex sandbox cannot start</b>; builds will stop before code generation.<div className="mt-1 break-words font-mono text-xs">{s.sandboxError}</div></div></div>
      )}
      {s.source === 'env_api_key' && (
        <div className="alert alert-info mx-5 mb-5"><KeyRound className="mt-0.5 size-4 shrink-0 text-info" /><div>CODEX_API_KEY in the API's environment takes precedence over the credentials stored here.</div></div>
      )}
      {s.source === 'auth_file' && (
        <div className="flex justify-end border-t px-5 py-3">
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={logout}>{busy ? <Spinner /> : <LogOut className="size-3.5" />}Sign out</button>
        </div>
      )}
    </Card>
  );
}

function LoginCard({ s, onChange }: { s: CodexAuthStatus; onChange: (s: CodexAuthStatus) => void }) {
  const [method, setMethod] = useState<Method>('device');
  return (
    <Card>
      <CardHeader title={s.configured ? 'Switch Codex account' : 'Sign in to Codex'} description="Credentials are stored in Factory's data volume (CODEX_HOME), never in the database, and are never shown again." />
      <div className="px-5">
        <Tabs value={method} onChange={setMethod} tabs={[
          { id: 'device', label: <span className="inline-flex items-center gap-1.5"><MonitorSmartphone className="size-3.5" />ChatGPT</span> },
          { id: 'apikey', label: <span className="inline-flex items-center gap-1.5"><KeyRound className="size-3.5" />API key</span> },
          { id: 'upload', label: <span className="inline-flex items-center gap-1.5"><FileJson className="size-3.5" />auth.json</span> },
        ]} />
      </div>
      <div className="px-5 pb-5 pt-4">
        {method === 'device' && <DeviceLogin s={s} onChange={onChange} />}
        {method === 'apikey' && <ApiKeyLogin onChange={onChange} />}
        {method === 'upload' && <UploadAuth onChange={onChange} />}
      </div>
    </Card>
  );
}

function DeviceLogin({ s, onChange }: { s: CodexAuthStatus; onChange: (s: CodexAuthStatus) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const d = s.device;
  const prev = useRef(d.state);
  useEffect(() => {
    if (prev.current === 'pending' && d.state === 'success') toast('Signed in to Codex');
    prev.current = d.state;
  }, [d.state, toast]);

  async function start() {
    setBusy(true); setErr(null);
    try { onChange(await api.codexDeviceStart()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  async function cancel() {
    setBusy(true);
    try { onChange(await api.codexDeviceCancel()); } finally { setBusy(false); }
  }

  if (d.state === 'pending') {
    return (
      <div className="space-y-4">
        <ol className="space-y-4 text-sm">
          <li>
            <div className="font-medium">1. Open the sign-in page and sign in with your ChatGPT account</div>
            {d.url ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1.5 font-mono text-xs text-info underline underline-offset-2">{d.url}<ExternalLink className="size-3" /></a> : <div className="mt-1 flex items-center gap-2 text-muted-foreground"><Spinner />Getting the link…</div>}
          </li>
          <li>
            <div className="font-medium">2. Enter the one-time code</div>
            {d.code ? (
              <div className="mt-2 flex items-center gap-3">
                <span className="rounded-lg border bg-muted px-4 py-2 font-mono text-2xl font-semibold tracking-[0.2em]">{d.code}</span>
                <button className="btn btn-outline btn-sm" onClick={() => { void navigator.clipboard?.writeText(d.code!).then(() => toast('Code copied'), () => undefined); }} aria-label="Copy code"><Copy className="size-3.5" />Copy</button>
              </div>
            ) : <div className="mt-1 flex items-center gap-2 text-muted-foreground"><Spinner />Getting the code…</div>}
            {d.expiresAt && <div className="hint">Expires at {fmtDate(d.expiresAt)}. This page updates automatically once you confirm.</div>}
          </li>
        </ol>
        <div className="alert alert-warning"><ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div>Only enter this code if you just started the sign-in here. Never share it with anyone.</div></div>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />Waiting for confirmation…</span>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Factory runs <code className="mono">codex login --device-auth</code> on the server. You sign in to ChatGPT from any browser with a one-time code; no Codex install needed on your machine. Best when Factory runs in Docker or on a server.</p>
      {d.state === 'success' && <div className="alert alert-info"><CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /><div>The last sign-in succeeded.</div></div>}
      {d.state === 'failed' && <InlineError error={`Sign-in failed: ${d.error ?? 'unknown error'}`} />}
      {d.state === 'cancelled' && <p className="text-sm text-muted-foreground">The previous sign-in was cancelled.</p>}
      <InlineError error={err} />
      <button className="btn btn-primary" disabled={busy} onClick={start}>{busy ? <Spinner /> : <MonitorSmartphone className="size-4" />}Start sign-in</button>
    </div>
  );
}

function ApiKeyLogin({ onChange }: { onChange: (s: CodexAuthStatus) => void }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true); setErr(null);
    try { onChange(await api.codexApiKey({ apiKey: key })); setKey(''); toast('Codex API key saved'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <Field label="OpenAI API key" hint="Runs codex login --with-api-key on the server. Build costs are billed to this API account.">
        {(id) => <input id={id} type="password" autoComplete="off" spellCheck={false} className="input font-mono text-xs" placeholder="sk-..." value={key} onChange={(e) => setKey(e.target.value)} />}
      </Field>
      <InlineError error={err} />
      <button className="btn btn-primary" disabled={busy || !key.trim()} onClick={save}>{busy && <Spinner />}Save API key</button>
    </div>
  );
}

function UploadAuth({ onChange }: { onChange: (s: CodexAuthStatus) => void }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function upload() {
    if (!file) return;
    if (file.size > 64 * 1024) { setErr('File too large (max 64KB)'); return; }
    setBusy(true); setErr(null);
    try { onChange(await api.codexUpload({ content: await file.text() })); setFile(null); toast('auth.json updated'); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Run <code className="mono">codex login</code> on a machine with a browser, then upload <code className="mono">~/.codex/auth.json</code>.</p>
      <div className="alert alert-warning"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" /><div>If this file is still in use on another machine, a token refresh on one side can sign the other out. Prefer a dedicated sign-in for Factory, or use <b>ChatGPT sign-in</b>.</div></div>
      <Field label="auth.json">
        {(id) => <input id={id} type="file" accept="application/json,.json" className="input h-auto py-1.5 text-xs file:mr-3 file:rounded file:border-0 file:bg-muted file:px-2 file:py-1 file:text-foreground" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
      </Field>
      <InlineError error={err} />
      <button className="btn btn-primary" disabled={busy || !file} onClick={upload}>{busy && <Spinner />}Upload</button>
    </div>
  );
}
