'use client';

import { Lightbulb } from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn } from '@/lib/utils';
import { Badge, Loaded } from './ui';

export function SpecDiffView({ projectId, from, to }: { projectId: string; from: string; to: string }) {
  const q = useApi(() => api.specDiff(projectId, from, to), [projectId, from, to]);
  return (
    <Loaded q={q}>
      {(d) => {
        const lines = [
          ...d.added.map((o) => ({ sign: '+', text: `${o.method.padEnd(6)} ${o.path}` })),
          ...d.changed.map((o) => ({ sign: '~', text: `${o.method.padEnd(6)} ${o.path} · ${o.changes.join('; ')}` })),
          ...d.removed.map((o) => ({ sign: '-', text: `${o.method.padEnd(6)} ${o.path}` })),
        ];
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {d.breaking ? <Badge tone="danger">Breaking</Badge> : <Badge tone="success">Không breaking</Badge>}
              <span className="text-xs text-muted-foreground">+{d.added.length} · ~{d.changed.length} · −{d.removed.length}</span>
            </div>
            {lines.length === 0 ? <p className="text-sm text-muted-foreground">Hai snapshot không khác nhau về operation.</p> : (
              <div className="overflow-hidden rounded-lg border font-mono text-xs">
                {lines.map((l, i) => (
                  <div key={i} className={cn('flex gap-3 border-b px-3 py-2 last:border-b-0', l.sign === '+' ? 'bg-success-soft/50' : l.sign === '-' ? 'bg-danger-soft/50' : 'bg-warning-soft/40')}>
                    <span className={cn('w-3 font-bold', l.sign === '+' ? 'text-success' : l.sign === '-' ? 'text-danger' : 'text-warning')}>{l.sign}</span>
                    <span className="whitespace-pre-wrap">{l.text}</span>
                  </div>
                ))}
              </div>
            )}
            {d.affectedTools.length > 0 && (
              <div className="flex gap-2 text-sm">
                <span className="w-12 shrink-0 text-muted-foreground">Tool</span>
                <div className="flex flex-wrap gap-1">
                  {d.affectedTools.map((t) => <span key={t.name} className="badge badge-warning mono" title={t.reason}>{t.name}</span>)}
                </div>
              </div>
            )}
            <div className="alert alert-warning">
              <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" />
              <div>Đề xuất tăng <b>{d.suggestedBump}</b>. Đây chỉ là đề xuất; người dùng quyết định số version.</div>
            </div>
          </div>
        );
      }}
    </Loaded>
  );
}
