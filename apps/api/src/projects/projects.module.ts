import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type {
  AuditDto, ConflictDto, ContextDto, DashboardDto, GlossaryEntry, ProjectDetail, ProjectStep, ProjectSummary, SettingsDto,
} from '@mcp-builder/shared';
import { AuditService, SettingsService } from '../core/core.services.js';
import { buildInclude, toBuildSummary, toVersionSummary } from '../core/mappers.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse, slugify } from '../core/util.js';
import type { Prisma, Project } from '../generated/prisma/client.js';

const outputsSchema = z.object({ mcp: z.boolean(), cli: z.boolean() }).refine((o) => o.mcp || o.cli, 'Select at least one output');
const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().max(2000).optional(),
  owner: z.string().max(120).optional(),
  outputs: outputsSchema.optional(),
}).strict();
const updateSchema = createSchema.partial();
const contextSchema = z.object({
  purpose: z.string().max(4000),
  sampleTasks: z.string().max(8000),
  businessRules: z.string().max(8000),
  dataFormats: z.string().max(2000),
  accessScope: z.string().max(2000),
  impacts: z.array(z.string().max(80)).max(20),
  expectedResults: z.string().max(4000),
  freeform: z.string().max(8000),
  glossary: z.array(z.object({ term: z.string().max(200), meaning: z.string().max(1000), mapping: z.string().max(500) })).max(200),
}).strict();
const settingsSchema = z.object({
  maxCostUsdPerBuild: z.number().positive().max(1000),
  maxRepairRounds: z.number().int().min(0).max(10),
  maxQaRepairRounds: z.number().int().min(0).max(5),
  monthlyBudgetUsd: z.number().positive().max(100000),
  buildTimeoutMin: z.number().int().min(5).max(180),
}).partial().strict();

const EMPTY_CONTEXT: Omit<ContextDto, 'updatedAt'> = {
  purpose: '', sampleTasks: '', businessRules: '', dataFormats: '', accessScope: '', impacts: [], expectedResults: '', freeform: '', glossary: [],
};

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService) {}

  async summary(p: Project): Promise<ProjectSummary> {
    const [spec, toolCount, selectedCount, release, draft, build] = await Promise.all([
      this.prisma.specSnapshot.findFirst({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, select: { sourceUrl: true, filename: true } }),
      this.prisma.toolDefinition.count({ where: { projectId: p.id, present: true, unsupportedReason: null } }),
      this.prisma.toolDefinition.count({ where: { projectId: p.id, present: true, selected: true } }),
      this.prisma.version.findFirst({ where: { projectId: p.id, status: 'released' }, orderBy: { releasedAt: 'desc' } }),
      this.prisma.version.findFirst({ where: { projectId: p.id, status: 'draft' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.build.findFirst({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, include: buildInclude }),
    ]);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      description: p.description,
      owner: p.owner,
      outputs: p.outputs as unknown as ProjectSummary['outputs'],
      archivedAt: p.archivedAt?.toISOString() ?? null,
      createdAt: p.createdAt.toISOString(),
      specSource: spec ? spec.sourceUrl ?? spec.filename ?? 'upload' : null,
      toolCount,
      selectedCount,
      currentRelease: release ? toVersionSummary(release) : null,
      latestDraft: draft ? toVersionSummary(draft) : null,
      latestBuild: build ? toBuildSummary(build) : null,
    };
  }

  async get(id: string): Promise<Project> {
    const p = await this.prisma.project.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  async detail(id: string): Promise<ProjectDetail> {
    const p = await this.get(id);
    const s = await this.summary(p);
    const [spec, ctx, conflicts, conns] = await Promise.all([
      this.prisma.specSnapshot.findFirst({ where: { projectId: id }, orderBy: { createdAt: 'desc' } }),
      this.prisma.projectContext.findUnique({ where: { projectId: id } }),
      this.conflicts(id),
      this.prisma.connection.findMany({ where: { projectId: id } }),
    ]);
    const issues = (spec?.issues as { level: string }[] | undefined) ?? [];
    const errors = issues.filter((i) => i.level === 'error').length;
    const warns = issues.length - errors;
    const b = s.latestBuild;
    const qaConn = conns.find((c) => c.useForQa);
    const steps: ProjectStep[] = [
      { key: 'project', label: 'Create project', state: 'done' },
      { key: 'spec', label: 'Import spec', state: spec ? 'done' : 'todo', detail: spec ? `OAS ${spec.oasVersion}` : undefined },
      { key: 'validate', label: 'Validate input', state: !spec ? 'todo' : errors ? 'fail' : warns ? 'warn' : 'done', detail: spec ? (errors ? `${errors} errors` : warns ? `${warns} warnings` : 'Valid') : undefined },
      { key: 'context', label: 'Context', state: !ctx?.purpose ? 'todo' : conflicts.some((c) => c.severity === 'warning') ? 'warn' : 'done', detail: conflicts.length ? `${conflicts.length} notes` : undefined },
      { key: 'scope', label: 'Scope', state: s.selectedCount ? 'done' : 'todo', detail: spec ? `${s.selectedCount}/${s.toolCount} endpoint` : undefined },
      { key: 'connection', label: 'Connections', state: qaConn ? 'done' : conns.length ? 'warn' : 'todo', detail: qaConn ? `env ${qaConn.name}` : conns.length ? 'No QA environment' : undefined },
      { key: 'export', label: 'Export', state: !b ? 'todo' : b.status === 'failed' ? 'fail' : b.status === 'succeeded' ? 'done' : 'todo', detail: b ? `${b.label} · ${b.status}` : undefined },
      { key: 'result', label: 'Result', state: b?.packageVerified ? (b.integrationVerified === 'yes' ? 'done' : 'warn') : b?.packageVerified === false ? 'fail' : 'todo', detail: b?.packageVerified ? `Integration: ${b.integrationVerified}` : b?.packageVerified === false ? 'Draft' : undefined },
      { key: 'next', label: 'Next version', state: s.currentRelease ? 'done' : 'todo', detail: s.currentRelease ? `v${s.currentRelease.number}` : undefined },
    ];
    return { ...s, steps };
  }

  async create(body: unknown) {
    const input = parse(createSchema, body);
    let slug = slugify(input.name);
    for (let i = 2; await this.prisma.project.findUnique({ where: { slug } }); i++) slug = `${slugify(input.name)}-${i}`;
    const p = await this.prisma.project.create({
      data: { name: input.name, slug, description: input.description ?? '', owner: input.owner || 'system', outputs: input.outputs ?? { mcp: true, cli: true }, context: { create: {} } },
    });
    await this.audit.log('project.create', p.name, { projectId: p.id });
    return this.detail(p.id);
  }

  async update(id: string, body: unknown) {
    const input = parse(updateSchema, body);
    await this.get(id);
    await this.prisma.project.update({ where: { id }, data: input });
    await this.audit.log('project.update', id, input);
    return this.detail(id);
  }

  async archive(id: string) {
    await this.get(id);
    await this.prisma.project.update({ where: { id }, data: { archivedAt: new Date() } });
    await this.audit.log('project.archive', id);
    return this.detail(id);
  }

  async getContext(id: string): Promise<ContextDto> {
    await this.get(id);
    const c = await this.prisma.projectContext.findUnique({ where: { projectId: id } });
    if (!c) return { ...EMPTY_CONTEXT, updatedAt: null };
    const { projectId: _p, updatedAt, glossary, ...rest } = c;
    return { ...rest, glossary: glossary as unknown as GlossaryEntry[], updatedAt: updatedAt.toISOString() };
  }

  async putContext(id: string, body: unknown): Promise<ContextDto> {
    const input = parse(contextSchema, body);
    await this.get(id);
    const data = { ...input, glossary: input.glossary as unknown as Prisma.InputJsonValue };
    await this.prisma.projectContext.upsert({ where: { projectId: id }, create: { projectId: id, ...data }, update: data });
    await this.audit.log('context.update', id);
    return this.getContext(id);
  }

  /** Heuristic checks only: the system flags what it can detect and never invents rules. */
  async conflicts(id: string): Promise<ConflictDto[]> {
    const [ctx, spec, writeTools] = await Promise.all([
      this.prisma.projectContext.findUnique({ where: { projectId: id } }),
      this.prisma.specSnapshot.findFirst({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, select: { raw: true } }),
      this.prisma.toolDefinition.findMany({ where: { projectId: id, selected: true, present: true, impact: { not: 'read' } }, select: { name: true, impact: true } }),
    ]);
    const out: ConflictDto[] = [];
    if (!ctx) return out;
    if (spec) {
      for (const g of (ctx.glossary as unknown as GlossaryEntry[]) ?? []) {
        const tokens = (g.mapping.match(/[A-Za-z_][\w.\-/]*/g) ?? []).map((t) => t.split('.').pop()!.replace(/^\//, ''));
        const missing = tokens.filter((t) => t.length > 1 && !spec.raw.includes(t));
        if (missing.length) out.push({ id: `glossary:${g.term}`, severity: 'warning', title: `Glossary term "${g.term}" maps to something not in the spec`, detail: `${missing.map((m) => `"${m}"`).join(', ')} not found in the current spec.` });
      }
    }
    // Impacts are free text; also accept common Vietnamese verbs so non-English contexts are recognised.
    if (writeTools.length && !ctx.impacts.some((i) => /write|create|update|delete|approve|send|email|ghi|duyệt|xóa/i.test(i))) {
      out.push({ id: 'impacts', severity: 'warning', title: 'Context does not declare write impacts', detail: `${writeTools.length} selected tools have side effects (${writeTools.map((t) => t.name).join(', ')}) but the context "Impacts" field does not mention them.` });
    }
    if (!ctx.sampleTasks.trim()) out.push({ id: 'tasks', severity: 'info', title: 'No sample tasks', detail: 'Agent task evaluation needs sample tasks to evaluate against.' });
    return out;
  }

  async dashboard(): Promise<DashboardDto> {
    const weekAgo = new Date(Date.now() - 7 * 864e5);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const projects = await this.prisma.project.findMany({ where: { archivedAt: null }, orderBy: { updatedAt: 'desc' } });
    const [summaries, running, activity, failedQa7d, newVersions7d, integration7d, cost, settings] = await Promise.all([
      Promise.all(projects.map((p) => this.summary(p))),
      this.prisma.build.findMany({ where: { status: { in: ['queued', 'running'] } }, orderBy: { createdAt: 'asc' }, include: buildInclude }),
      this.audit_(10),
      this.prisma.build.count({ where: { createdAt: { gte: weekAgo }, packageVerified: false } }),
      this.prisma.version.count({ where: { releasedAt: { gte: weekAgo } } }),
      this.prisma.build.count({ where: { createdAt: { gte: weekAgo }, integrationVerified: 'yes' } }),
      this.prisma.build.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true } }),
      this.settings.get(),
    ]);
    return {
      stats: {
        projects: projects.length,
        releasedProjects: summaries.filter((s) => s.currentRelease).length,
        runningBuilds: running.length,
        failedQa7d,
        newVersions7d,
        integrationVerified7d: integration7d,
      },
      projects: summaries,
      running: running.map(toBuildSummary),
      activity,
      budget: { costUsdMonth: Math.round((cost._sum.costUsd ?? 0) * 100) / 100, budgetUsdMonth: settings.monthlyBudgetUsd },
    };
  }

  async audit_(limit = 100, projectId?: string): Promise<AuditDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: projectId ? { meta: { path: ['projectId'], equals: projectId } } : undefined,
      orderBy: { at: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({ id: r.id, at: r.at.toISOString(), actor: r.actor, action: r.action, target: r.target, meta: (r.meta as Record<string, unknown>) ?? null }));
  }
}

@Controller()
export class ProjectsController {
  constructor(private readonly svc: ProjectsService, private readonly prisma: PrismaService, private readonly settings: SettingsService, private readonly audit: AuditService) {}

  @Get('dashboard') dashboard() { return this.svc.dashboard(); }

  @Get('projects')
  async list(@Query('archived') archived?: string): Promise<ProjectSummary[]> {
    const rows = await this.prisma.project.findMany({ where: archived === 'true' ? {} : { archivedAt: null }, orderBy: { createdAt: 'desc' } });
    return Promise.all(rows.map((p) => this.svc.summary(p)));
  }

  @Post('projects') create(@Body() body: unknown) { return this.svc.create(body); }
  @Get('projects/:id') detail(@Param('id') id: string) { return this.svc.detail(id); }
  @Patch('projects/:id') update(@Param('id') id: string, @Body() body: unknown) { return this.svc.update(id, body); }
  @Post('projects/:id/archive') archive(@Param('id') id: string) { return this.svc.archive(id); }
  @Get('projects/:id/context') getContext(@Param('id') id: string) { return this.svc.getContext(id); }
  @Put('projects/:id/context') putContext(@Param('id') id: string, @Body() body: unknown) { return this.svc.putContext(id, body); }
  @Get('projects/:id/conflicts') conflicts(@Param('id') id: string) { return this.svc.conflicts(id); }

  @Get('audit') auditLog(@Query('projectId') projectId?: string) { return this.svc.audit_(200, projectId); }

  @Get('settings') getSettings(): Promise<SettingsDto> { return this.settings.get(); }

  @Put('settings')
  async putSettings(@Body() body: unknown): Promise<SettingsDto> {
    const input = parse(settingsSchema, body);
    if (!Object.keys(input).length) throw new BadRequestException('No changes');
    const res = await this.settings.update(input);
    await this.audit.log('settings.update', 'limits', input);
    return res;
  }
}

@Module({ controllers: [ProjectsController], providers: [ProjectsService], exports: [ProjectsService] })
export class ProjectsModule {}
