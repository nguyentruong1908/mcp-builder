import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { BuildStatus, DeploymentStatus, Impact, IntegrationVerdict, QaLayer, QaStatus, StageName, StageState, VersionStatus } from '@mcp-factory/shared';

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'brand' | 'outline';

export const impactMeta: Record<Impact, { label: string; tone: Tone }> = {
  read: { label: 'Read', tone: 'info' },
  write: { label: 'Write', tone: 'warning' },
  side_effect: { label: 'Side effect', tone: 'warning' },
  destructive: { label: 'Delete', tone: 'danger' },
};

export const methodCls: Record<string, string> = {
  GET: 'bg-info-soft text-info',
  POST: 'bg-success-soft text-success',
  PUT: 'bg-warning-soft text-warning',
  PATCH: 'bg-warning-soft text-warning',
  DELETE: 'bg-danger-soft text-danger',
};

export const LAYERS: QaLayer[] = ['input', 'build', 'interface', 'contract', 'error', 'runtime', 'integration', 'agent', 'custom', 'install'];
export const layerMeta: Record<QaLayer, { label: string; short: string; description: string }> = {
  input: { label: 'Input validation', short: 'Input', description: 'Spec, $ref, tool schemas' },
  build: { label: 'Build & static', short: 'Build', description: 'Compile, typecheck, secret scan' },
  interface: { label: 'MCP / CLI interface', short: 'Interface', description: 'tools/list, schema, --help, exit code' },
  contract: { label: 'API contract', short: 'Contract', description: 'Method, path, query, body' },
  error: { label: 'Error handling', short: 'Error', description: '401/404/429/5xx' },
  runtime: { label: 'Runtime behavior', short: 'Runtime', description: 'Pagination, retry, idempotency' },
  integration: { label: 'Integration', short: 'Integration', description: 'Live API · QA environment' },
  agent: { label: 'Agent task eval', short: 'Agent', description: 'Sample tasks from context' },
  custom: { label: 'Custom test cases', short: 'Custom', description: 'Defined by you' },
  install: { label: 'Installation', short: 'Install', description: 'Install into a clean environment' },
};

export const deploymentStatusMeta: Record<DeploymentStatus, { label: string; tone: Tone }> = {
  starting: { label: 'Starting', tone: 'info' },
  running: { label: 'Running', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'outline' },
  failed: { label: 'Failed', tone: 'danger' },
};

export const qaMeta: Record<QaStatus, { label: string; tone: Tone }> = {
  pass: { label: 'PASS', tone: 'success' },
  fail: { label: 'FAIL', tone: 'danger' },
  blocked: { label: 'BLOCKED', tone: 'warning' },
  not_run: { label: 'NOT RUN', tone: 'outline' },
};

export const buildStatusMeta: Record<BuildStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'outline' },
  running: { label: 'Running', tone: 'info' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'outline' },
};
export const isActive = (s: BuildStatus) => s === 'queued' || s === 'running';

export const versionStatusMeta: Record<VersionStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'outline' },
  released: { label: 'Released', tone: 'success' },
  deprecated: { label: 'Deprecated', tone: 'warning' },
};

export const verdictMeta: Record<IntegrationVerdict, { label: string; tone: Tone }> = {
  yes: { label: 'Integration ✓', tone: 'success' },
  partial: { label: 'Integration partial', tone: 'warning' },
  no: { label: 'Integration ✗', tone: 'danger' },
  not_run: { label: 'Integration NOT RUN', tone: 'outline' },
};

export const STAGES: StageName[] = ['spec', 'codex', 'build', 'qa', 'package'];
export const stageLabel: Record<StageName, string> = {
  spec: 'Spec processing', codex: 'Codex generation', build: 'Build & static', qa: 'QA runner', package: 'Package',
};
export const stageDone = (s: StageState) => s === 'ok' || s === 'skipped';

const dtf = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtDate = (iso: string | null | undefined) => (iso ? dtf.format(new Date(iso)) : '—');

export function fmtDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
export const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
export const fmtNum = (n: number) => n.toLocaleString('en-US');
export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
export const shortHash = (h: string) => (h.length > 12 ? `${h.replace(/^sha256:/, '').slice(0, 4)}…${h.slice(-4)}` : h);
export const initials = (name: string) =>
  name.trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}
