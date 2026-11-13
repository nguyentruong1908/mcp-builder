import type {
  ArtifactDto, BuildSummary, ConnectionDto, IntegrationVerdict, SpecIssue, SpecSnapshotDto, StageName, StageState, ToolDto, ToolParam, VersionSummary,
} from '@mcp-factory/shared';
import type { Artifact, Build, Connection, SpecSnapshot, ToolDefinition, Version } from '../generated/prisma/client.js';
import { iso, resolveSecret } from './util.js';

export function toSpecDto(s: SpecSnapshot): SpecSnapshotDto {
  const ops = s.operations as { unsupportedReason: string | null }[];
  return {
    id: s.id,
    createdAt: s.createdAt.toISOString(),
    source: s.source as 'url' | 'upload',
    sourceUrl: s.sourceUrl,
    filename: s.filename,
    sha256: s.sha256,
    oasVersion: s.oasVersion,
    apiVersion: s.apiVersion,
    title: s.title,
    operationCount: ops.length,
    supportedCount: ops.filter((o) => !o.unsupportedReason).length,
    issues: s.issues as unknown as SpecIssue[],
    securitySchemes: s.securitySchemes as string[],
    servers: s.servers as string[],
  };
}

export function toToolDto(t: ToolDefinition): ToolDto {
  return {
    id: t.id,
    method: t.method,
    path: t.path,
    tag: t.tag,
    operationId: t.operationId,
    name: t.name,
    description: t.description,
    impact: t.impact,
    requireConfirm: t.requireConfirm,
    selected: t.selected,
    unsupportedReason: t.unsupportedReason,
    inputSchema: t.inputSchema as Record<string, unknown>,
    params: t.params as unknown as ToolParam[],
  };
}

export function toConnectionDto(c: Connection): ConnectionDto {
  return {
    id: c.id,
    name: c.name,
    baseUrl: c.baseUrl,
    authType: c.authType,
    authHeader: c.authHeader,
    secretRef: c.secretRef,
    allowWrite: c.allowWrite,
    agentAccess: c.agentAccess as ConnectionDto['agentAccess'],
    useForQa: c.useForQa,
    secretResolvable: c.authType === 'none' || resolveSecret(c.secretRef) !== undefined,
    lastCheck: (c.lastCheck as ConnectionDto['lastCheck']) ?? null,
  };
}

export function toVersionSummary(v: Version): VersionSummary {
  return { id: v.id, number: v.number, status: v.status, apiVersion: v.apiVersion, createdAt: v.createdAt.toISOString(), releasedAt: iso(v.releasedAt) };
}

export const buildLabel = (seq: number) => `b-${String(seq).padStart(4, '0')}`;

export function toBuildSummary(b: Build & { project: { name: string }; version: { number: string } }): BuildSummary {
  const end = b.finishedAt ?? (b.status === 'running' ? new Date() : null);
  return {
    id: b.id,
    kind: b.kind === 'qa' ? 'qa' : 'export',
    sourceBuildId: b.sourceBuildId,
    sourceBuildLabel: b.sourceBuildLabel,
    seq: b.seq,
    label: buildLabel(b.seq),
    projectId: b.projectId,
    projectName: b.project.name,
    versionId: b.versionId,
    versionNumber: b.version.number,
    status: b.status,
    stage: b.stage as StageName | null,
    stages: b.stages as Record<StageName, StageState>,
    packageVerified: b.packageVerified,
    integrationVerified: b.integrationVerified as IntegrationVerdict | null,
    repairRounds: b.repairRounds,
    qaRepairRounds: b.qaRepairRounds,
    tokens: { input: b.inputTokens, cachedInput: b.cachedInputTokens, output: b.outputTokens },
    costUsd: Math.round(b.costUsd * 10000) / 10000,
    durationMs: b.startedAt && end ? end.getTime() - b.startedAt.getTime() : null,
    triggeredBy: b.triggeredBy,
    createdAt: b.createdAt.toISOString(),
    startedAt: iso(b.startedAt),
    finishedAt: iso(b.finishedAt),
    error: b.error,
  };
}

export function toArtifactDto(a: Artifact): ArtifactDto {
  return { id: a.id, kind: a.kind as ArtifactDto['kind'], filename: a.filename, sha256: a.sha256, size: a.size, downloadUrl: `/api/artifacts/${a.id}/download` };
}

export const buildInclude = { project: { select: { name: true } }, version: { select: { number: true } } } as const;
