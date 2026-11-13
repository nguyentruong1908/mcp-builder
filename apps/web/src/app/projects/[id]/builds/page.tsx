'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Hammer } from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { fmtDate, fmtDuration, fmtUsd, isActive } from '@/lib/utils';
import { Card, EmptyState, Loaded, PageHeader } from '@/components/ui';
import { BuildBadges } from '@/components/build-badges';

export default function BuildsPage() {
  const { id } = useParams<{ id: string }>();
  const q = useApi(() => api.builds(id), [id]);
  const anyActive = q.data?.some((b) => isActive(b.status));

  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(q.refetch, 4000);
    return () => clearInterval(t);
  }, [anyActive, q.refetch]);

  return (
    <>
      <PageHeader title="Builds" description="Exports run as background jobs: generation → build → QA → package. A QA run re-runs QA on a build's code and skips Codex." />
      <Loaded q={q}>
        {(list) => list.length === 0 ? (
          <Card><EmptyState icon={<Hammer className="size-5" />} title="No builds yet" description="Click Export at the top to run your first build." /></Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="tbl">
                <thead><tr><th>Build</th><th>Version</th><th>Result</th><th>Duration</th><th>Cost</th><th>Repairs</th><th>Triggered by</th><th>When</th></tr></thead>
                <tbody>
                  {list.map((b) => (
                    <tr key={b.id}>
                      <td><Link href={`/projects/${id}/builds/${b.id}`} className="mono font-medium hover:underline">{b.label}</Link>{b.kind === 'qa' && b.sourceBuildId && <div className="text-xs text-muted-foreground">on the code of <Link href={`/projects/${id}/builds/${b.sourceBuildId}`} className="mono hover:underline">{b.sourceBuildLabel}</Link></div>}</td>
                      <td className="mono">{b.versionNumber}</td>
                      <td><BuildBadges b={b} /></td>
                      <td className="tabular-nums">{fmtDuration(b.durationMs)}</td>
                      <td className="tabular-nums">{fmtUsd(b.costUsd)}</td>
                      <td className="tabular-nums">{b.repairRounds}</td>
                      <td>{b.triggeredBy}</td>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(b.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </Loaded>
    </>
  );
}
