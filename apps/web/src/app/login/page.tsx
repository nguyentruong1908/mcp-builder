'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { safeNext } from '@/lib/auth';
import { Field, InlineError, Spinner } from '@/components/ui';
import { LogoMark } from '@/components/logo';

export default function LoginPage() {
  const next = safeNext(useSearchParams().get('next'));
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.setupStatus().then((s) => { if (s.needsSetup) window.location.replace('/setup'); }, () => {});
  }, []);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login({ username, password });
      window.location.assign(next); // full load so the shell refetches `me`
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2.5"><LogoMark className="size-8 text-foreground" /><h1 className="text-lg font-semibold">Sign in to MCP Builder</h1></div>
        <InlineError error={error} />
        <Field label="Username">{(id) => <input id={id} className="input" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}Sign in</button>
      </form>
    </div>
  );
}
