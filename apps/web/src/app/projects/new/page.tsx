'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Card, Field, InlineError, PageHeader, Spinner, Switch } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function NewProjectPage() {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [owner, setOwner] = useState('');
  const [outputs, setOutputs] = useState({ mcp: true, cli: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr('Enter a project name.');
    setBusy(true); setErr(null);
    try {
      const p = await api.createProject({ name: name.trim(), description: description.trim(), owner: owner.trim(), outputs });
      toast('Project created');
      router.push(`/projects/${p.id}/api`);
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  }

  return (
    <>
      <PageHeader title="New Tool Project" description="A project holds the tools generated from one API; export MCP, CLI or both." />
      <Card className="max-w-2xl">
        <form onSubmit={submit} className="space-y-4 p-5">
          <Field label="Project name" hint="E.g. ERP Sales Tools">
            {(id) => <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />}
          </Field>
          <Field label="Description">
            {(id) => <textarea id={id} className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Let agents look up and create sales orders…" />}
          </Field>
          <Field label="Owner">
            {(id) => <input id={id} className="input" value={owner} onChange={(e) => setOwner(e.target.value)} />}
          </Field>
          <div>
            <div className="label">Outputs</div>
            <div className="flex flex-wrap gap-6">
              <label className="flex items-center gap-2 text-sm"><Switch label="MCP server" checked={outputs.mcp} onChange={(v) => setOutputs({ ...outputs, mcp: v })} />MCP server (stdio / HTTP)</label>
              <label className="flex items-center gap-2 text-sm"><Switch label="CLI" checked={outputs.cli} onChange={(v) => setOutputs({ ...outputs, cli: v })} />CLI</label>
            </div>
          </div>
          <InlineError error={err} />
          <div className="flex justify-end gap-2 border-t pt-4">
            <button type="button" className="btn btn-ghost" onClick={() => router.back()}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy && <Spinner />}Create project</button>
          </div>
        </form>
      </Card>
    </>
  );
}
