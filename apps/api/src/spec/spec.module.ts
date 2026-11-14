import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { SpecDiff, SpecResponse, ToolDto } from '@mcp-builder/shared';
import { config } from '../config.js';
import { AuditService } from '../core/core.services.js';
import { toSpecDto, toToolDto } from '../core/mappers.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse, sha256 } from '../core/util.js';
import type { Prisma } from '../generated/prisma/client.js';
import { diffOperations, processSpec, SpecError, type NormalizedOperation } from './spec-processor.js';

const MAX_SPEC_BYTES = 5 * 1024 * 1024;

const importSchema = z.object({
  url: z.string().url().optional(),
  content: z.string().max(MAX_SPEC_BYTES).optional(),
  filename: z.string().max(200).optional(),
}).refine((v) => !!v.url !== !!v.content, 'Provide exactly one of url or content');

const toolPatchSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Tool names may only contain letters, digits, _ or -, up to 64 characters').optional(),
  description: z.string().max(4000).optional(),
  impact: z.enum(['read', 'write', 'side_effect', 'destructive']).optional(),
  requireConfirm: z.boolean().optional(),
  selected: z.boolean().optional(),
}).strict();

/** Fetches a spec URL with an SSRF guard: allowlisted hosts only, no redirects, size and time limits. */
async function fetchSpec(rawUrl: string): Promise<string> {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new BadRequestException('Only http/https URLs are supported');
  if (!config.specFetchAllowlist.includes(url.hostname.toLowerCase())) {
    throw new BadRequestException(`Host "${url.hostname}" is not in SPEC_FETCH_ALLOWLIST. Upload the file instead or ask an admin to allow the host.`);
  }
  let res: Response;
  try {
    res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json, application/yaml, text/yaml, */*' } });
  } catch (err) {
    throw new BadRequestException(`Cannot download the spec: ${(err as Error).message}`);
  }
  if (!res.ok) throw new BadRequestException(`Spec download failed: HTTP ${res.status}`);
  if (Number(res.headers.get('content-length') ?? 0) > MAX_SPEC_BYTES) throw new BadRequestException('Spec exceeds 5MB');
  const text = await res.text();
  if (text.length > MAX_SPEC_BYTES) throw new BadRequestException('Spec exceeds 5MB');
  return text;
}

@Injectable()
export class SpecService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async import(projectId: string, body: unknown) {
    const input = parse(importSchema, body);
    await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } }).catch(() => { throw new NotFoundException('Project not found'); });
    const raw = input.url ? await fetchSpec(input.url) : input.content!;
    let processed;
    try {
      processed = await processSpec(raw);
    } catch (err) {
      if (err instanceof SpecError) throw new BadRequestException(err.message);
      throw err;
    }

    const snapshot = await this.prisma.$transaction(async (tx) => {
      const snap = await tx.specSnapshot.create({
        data: {
          projectId,
          source: input.url ? 'url' : 'upload',
          sourceUrl: input.url ?? null,
          filename: input.filename ?? null,
          raw,
          sha256: sha256(raw),
          oasVersion: processed.oasVersion,
          apiVersion: processed.apiVersion,
          title: processed.title,
          operations: processed.operations as unknown as Prisma.InputJsonValue,
          issues: processed.issues as unknown as Prisma.InputJsonValue,
          securitySchemes: processed.securitySchemes,
          servers: processed.servers,
        },
      });
      await this.syncTools(tx, projectId, processed.operations);
      return snap;
    });
    await this.audit.log('spec.import', `snapshot ${snapshot.sha256.slice(0, 8)}`, { projectId, operations: processed.operations.length });
    return toSpecDto(snapshot);
  }

  /** Upserts one ToolDefinition per operation, keeping user edits; operations that disappeared are unselected. */
  private async syncTools(tx: Prisma.TransactionClient, projectId: string, ops: NormalizedOperation[]) {
    const existing = await tx.toolDefinition.findMany({ where: { projectId } });
    const byKey = new Map(existing.map((t) => [`${t.method} ${t.path}`, t]));
    const takenNames = new Set(existing.map((t) => t.name));
    for (const op of ops) {
      const prev = byKey.get(`${op.method} ${op.path}`);
      const shape = {
        tag: op.tag,
        operationId: op.operationId,
        unsupportedReason: op.unsupportedReason,
        inputSchema: op.inputSchema as Prisma.InputJsonValue,
        params: op.params as unknown as Prisma.InputJsonValue,
        bodyWhole: op.bodyWhole,
        responseSchema: (op.responseSchema ?? undefined) as Prisma.InputJsonValue | undefined,
        present: true,
      };
      if (prev) {
        await tx.toolDefinition.update({ where: { id: prev.id }, data: { ...shape, selected: op.unsupportedReason ? false : prev.selected } });
        byKey.delete(`${op.method} ${op.path}`);
      } else {
        let name = op.toolName;
        for (let i = 2; takenNames.has(name); i++) name = `${op.toolName.slice(0, 60)}_${i}`;
        takenNames.add(name);
        await tx.toolDefinition.create({
          data: {
            ...shape, projectId, method: op.method, path: op.path, name, description: op.description,
            impact: op.defaultImpact, requireConfirm: op.defaultImpact !== 'read',
            // Read tools start selected; anything with side effects must be opted in explicitly.
            selected: !op.unsupportedReason && op.defaultImpact === 'read',
          },
        });
      }
    }
    for (const gone of byKey.values()) await tx.toolDefinition.update({ where: { id: gone.id }, data: { present: false, selected: false } });
  }

  async list(projectId: string): Promise<SpecResponse> {
    const snaps = await this.prisma.specSnapshot.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const dtos = snaps.map(toSpecDto);
    return { current: dtos[0] ?? null, history: dtos };
  }

  async diff(projectId: string, fromId?: string, toId?: string): Promise<SpecDiff> {
    const snaps = await this.prisma.specSnapshot.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, take: 2, select: { id: true } });
    const to = toId ?? snaps[0]?.id;
    const from = fromId ?? snaps[1]?.id;
    if (!to || !from) throw new BadRequestException('At least two snapshots are needed for a diff');
    const [a, b] = await Promise.all([
      this.prisma.specSnapshot.findFirst({ where: { id: from, projectId } }),
      this.prisma.specSnapshot.findFirst({ where: { id: to, projectId } }),
    ]);
    if (!a || !b) throw new NotFoundException('Snapshot not found');
    const tools = await this.prisma.toolDefinition.findMany({ where: { projectId, selected: true }, select: { method: true, path: true, name: true } });
    const names = new Map(tools.map((t) => [`${t.method} ${t.path}`, t.name]));
    return diffOperations(a.operations as unknown as NormalizedOperation[], b.operations as unknown as NormalizedOperation[], a.id, b.id, names);
  }
}

@Controller()
export class SpecController {
  constructor(private readonly spec: SpecService, private readonly prisma: PrismaService) {}

  @Post('projects/:id/spec') import(@Param('id') id: string, @Body() body: unknown) { return this.spec.import(id, body); }
  @Get('projects/:id/spec') list(@Param('id') id: string) { return this.spec.list(id); }
  @Get('projects/:id/spec/diff') diff(@Param('id') id: string, @Query('from') from?: string, @Query('to') to?: string) { return this.spec.diff(id, from, to); }

  @Get('projects/:id/tools')
  async tools(@Param('id') id: string): Promise<ToolDto[]> {
    const rows = await this.prisma.toolDefinition.findMany({ where: { projectId: id, present: true }, orderBy: [{ tag: 'asc' }, { path: 'asc' }, { method: 'asc' }] });
    return rows.map(toToolDto);
  }

  @Patch('tools/:id')
  async updateTool(@Param('id') id: string, @Body() body: unknown): Promise<ToolDto> {
    const patch = parse(toolPatchSchema, body);
    const tool = await this.prisma.toolDefinition.findUnique({ where: { id } });
    if (!tool) throw new NotFoundException('Tool not found');
    if (patch.selected && tool.unsupportedReason) throw new BadRequestException(`Cannot select: ${tool.unsupportedReason}`);
    if (patch.name && patch.name !== tool.name) {
      const clash = await this.prisma.toolDefinition.findFirst({ where: { projectId: tool.projectId, name: patch.name, present: true, NOT: { id } } });
      if (clash) throw new BadRequestException(`Name "${patch.name}" is already used by ${clash.method} ${clash.path}`);
    }
    return toToolDto(await this.prisma.toolDefinition.update({ where: { id }, data: patch }));
  }
}

@Module({ controllers: [SpecController], providers: [SpecService] })
export class SpecModule {}
