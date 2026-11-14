'use client';

import { useState, type FormEvent } from 'react';
import { Info } from 'lucide-react';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { Card, CardHeader, Field, InlineError, PageHeader, Spinner } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function AccountPage() {
  const { me, refetch } = useMe();
  const toast = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    if (next !== confirm) return setError('Passwords do not match');
    setBusy(true); setError(null);
    try {
      await api.changePassword({ current, next });
      setCurrent(''); setNext(''); setConfirm('');
      toast('Password changed');
      refetch();
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHeader title="Account" description={`${me.displayName} (@${me.username}) · ${me.role.name}`} />
      {me.mustChangePassword && (
        <div className="alert alert-info mb-6">
          <Info className="mt-0.5 size-4 shrink-0 text-info" />
          <div>You must choose a new password before you can use MCP Builder.</div>
        </div>
      )}
      <Card className="max-w-md">
        <CardHeader title="Change password" />
        <form onSubmit={submit} className="space-y-4 p-5">
          <InlineError error={error} />
          <Field label="Current password">{(id) => <input id={id} className="input" type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          <Field label="New password">{(id) => <input id={id} className="input" type="password" autoComplete="new-password" required value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label="Confirm new password">{(id) => <input id={id} className="input" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <button className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Change password</button>
        </form>
      </Card>
    </>
  );
}
