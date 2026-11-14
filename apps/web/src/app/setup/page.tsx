'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { Field, InlineError, Spinner } from '@/components/ui';
import { LogoMark } from '@/components/logo';

export default function SetupPage() {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.setupStatus().then((s) => { if (!s.needsSetup) window.location.replace('/login'); }, () => {});
  }, []);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (password !== confirm) return setError('Passwords do not match');
    setBusy(true); setError(null);
    try {
      await api.setup({ username, displayName, password });
      window.location.assign('/');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div className="flex items-center gap-2.5"><LogoMark className="size-8 text-foreground" /><h1 className="text-lg font-semibold">Create the admin account</h1></div>
        <p className="text-sm text-muted-foreground">First run: this account gets full administrator access.</p>
        <InlineError error={error} />
        <Field label="Username">{(id) => <input id={id} className="input" autoComplete="username" autoFocus required value={username} onChange={(e) => setUsername(e.target.value)} />}</Field>
        <Field label="Display name">{(id) => <input id={id} className="input" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />}</Field>
        <Field label="Password">{(id) => <input id={id} className="input" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Field label="Confirm password">{(id) => <input id={id} className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
        <button className="btn btn-primary w-full" disabled={busy}>{busy && <Spinner />}Create account</button>
      </form>
    </div>
  );
}
