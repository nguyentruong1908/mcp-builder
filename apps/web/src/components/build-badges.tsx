import type { BuildSummary } from '@mcp-builder/shared';
import { buildStatusMeta, verdictMeta } from '@/lib/utils';
import { Badge } from './ui';

export function BuildBadges({ b, status = true }: { b: BuildSummary; status?: boolean }) {
  return (
    // span, not div: rendered inside <p> descriptions.
    <span className="inline-flex flex-wrap items-center gap-1">
      {b.kind === 'qa' && <Badge tone="info">QA run</Badge>}
      {status && <Badge tone={buildStatusMeta[b.status].tone}>{buildStatusMeta[b.status].label}</Badge>}
      {b.packageVerified !== null && <Badge tone={b.packageVerified ? 'success' : 'danger'}>Package {b.packageVerified ? '✓' : '✗'}</Badge>}
      {b.integrationVerified && <Badge tone={verdictMeta[b.integrationVerified].tone}>{verdictMeta[b.integrationVerified].label}</Badge>}
    </span>
  );
}
