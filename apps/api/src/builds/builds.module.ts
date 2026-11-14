import {
  BadRequestException, Body, ConflictException, Controller, Get, Injectable, Logger, Module, NotFoundException, Param, Post, Query, Res, Sse,
  type MessageEvent, type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { z } from 'zod';
import type { BuildDetail, BuildLogDto, BuildSummary, QaLayer, QaReport, QaStatus, VersionDto } from '@mcp-builder/shared';
import { config } from '../config.js';
import { AuditService, BuildEvents, SettingsService } from '../core/core.services.js';
import { buildInclude, buildLabel, toArtifactDto, toBuildSummary, toVersionSummary } from '../core/mappers.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse, semverBump } from '../core/util.js';
import type { Prisma } from '../generated/prisma/client.js';
import { BuildRunner } from './pipeline/runner.js';
import type { ToolSnapshot } from './pipeline/types.js';
import { renderContextMd } from './pipeline/workspace.js';

const LAYERS: QaLayer[] = ['input', 'build', 'interface', 'contract', 'error', 'runtime', 'integration', 'agent', 'custom', 'install'];
const RANK: Record<QaStatus, number> = { fail: 3, blocked: 2, not_run: 1, pass: 0 };

@Injectable()
export class BuildsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  /** Export: freezes the current spec/context/tools into the latest draft version and queues a build. */
  async create(projectId: string, body: unknown, actor = 'system'): Promise<BuildSummary> {
    const input = parse(z.object({ runIntegration: z.boolean().default(true), runAgentEval: z.boolean().default(true) }).strict(), body ?? {});
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, include: { context: true } });
    if (!project) throw new NotFoundException('Project not found');
    if (project.archivedAt) throw new BadRequestException('Project is archived');
    if (await this.prisma.build.count({ where: { projectId, status: { in: ['queued', 'running'] } } })) throw new ConflictException('A build is already running for this project');

    const s = await this.settings.get();
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const spent = (await this.prisma.build.aggregate({ where: { createdAt: { gte: monthStart } }, _sum: { costUsd: true } }))._sum.costUsd ?? 0;
    if (spent >= s.monthlyBudgetUsd) throw new ConflictException(`Monthly budget exhausted ($${spent.toFixed(2)} / $${s.monthlyBudgetUsd})`);

    const spec = await this.prisma.specSnapshot.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    if (!spec) throw new BadRequestException('No OpenAPI spec imported yet');
    const tools = await this.prisma.toolDefinition.findMany({ where: { projectId, selected: true, present: true, unsupportedReason: null }, orderBy: { name: 'asc' } });
    if (!tools.length) throw new BadRequestException('No tools selected');
    const toolsSnapshot: ToolSnapshot[] = tools.map((t) => ({
      name: t.name, description: t.description, method: t.method, path: t.path, tag: t.tag, impact: t.impact, requireConfirm: t.requireConfirm,
      params: t.params as unknown as ToolSnapshot['params'], inputSchema: t.inputSchema as Record<string, unknown>, bodyWhole: t.bodyWhole, responseSchema: t.responseSchema ?? null,
    }));
    const contextSnapshot = { markdown: renderContextMd(project, project.context), data: project.context } as unknown as Prisma.InputJsonValue;

    const build = await this.prisma.$transaction(async (tx) => {
      const latest = await tx.version.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
      const data = { specSnapshotId: spec.id, apiVersion: spec.apiVersion, toolsSnapshot: toolsSnapshot as unknown as Prisma.InputJsonValue, contextSnapshot };
      const version = latest?.status === 'draft'
        ? await tx.version.update({ where: { id: latest.id }, data })
        : await tx.version.create({ data: { ...data, projectId, number: latest ? semverBump(latest.number, 'minor') : '0.1.0' } });
      return tx.build.create({
        data: {
          projectId, versionId: version.id, runIntegration: input.runIntegration, runAgentEval: input.runAgentEval, triggeredBy: actor,
          toolsSnapshot: toolsSnapshot as unknown as Prisma.InputJsonValue,
          limits: { maxRepairRounds: s.maxRepairRounds, maxQaRepairRounds: s.maxQaRepairRounds, maxCostUsd: s.maxCostUsdPerBuild, timeoutMin: s.buildTimeoutMin },
        },
        include: buildInclude,
      });
    });
    await this.audit.log('build.export', `${project.name} v${build.version.number} → b-${String(build.seq).padStart(4, '0')}`, { projectId, buildId: build.id }, actor);
    return toBuildSummary(build);
  }

  /** Standalone QA run: re-runs QA (incl. custom test cases) on a finished build's generated code. Codex generation is skipped. */
  async createQaRun(sourceId: string, body: unknown, actor = 'system'): Promise<BuildSummary> {
    const input = parse(z.object({ runIntegration: z.boolean().default(true), runAgentEval: z.boolean().default(true) }).strict(), body ?? {});
    const src = await this.prisma.build.findUnique({ where: { id: sourceId }, include: { version: true, project: true } });
    if (!src) throw new NotFoundException('Build not found');
    if (src.status === 'queued' || src.status === 'running') throw new ConflictException('The source build has not finished');
    if (await this.prisma.build.count({ where: { projectId: src.projectId, status: { in: ['queued', 'running'] } } })) throw new ConflictException('A build is already running for this project');
    const ws = join(config.dataDir, 'builds', buildLabel(src.seq), 'workspace');
    if (!existsSync(join(ws, 'dist/mcp.js')) || !existsSync(join(ws, 'factory/tools.json'))) throw new BadRequestException(`Build ${buildLabel(src.seq)} has no compiled code (it must have passed the Build & static stage)`);

    // The code was generated from factory/tools.json; QA must use exactly those definitions.
    const built = JSON.parse(readFileSync(join(ws, 'factory/tools.json'), 'utf8')) as { tools: { name: string }[] };
    let tools = (src.toolsSnapshot ?? src.version.toolsSnapshot) as unknown as ToolSnapshot[] | null;
    const same = (a: { name: string }[], b: { name: string }[]) => a.map((t) => t.name).sort().join() === b.map((t) => t.name).sort().join();
    if (!tools || !same(tools, built.tools)) tools = built.tools.map((t) => ({ tag: 'default', responseSchema: null, bodyWhole: false, ...t })) as ToolSnapshot[];

    const s = await this.settings.get();
    const run = await this.prisma.build.create({
      data: {
        kind: 'qa',
        sourceBuildId: src.id,
        sourceBuildLabel: src.kind === 'qa' && src.sourceBuildLabel ? src.sourceBuildLabel : buildLabel(src.seq),
        projectId: src.projectId, versionId: src.versionId, triggeredBy: actor,
        runIntegration: input.runIntegration, runAgentEval: input.runAgentEval,
        toolsSnapshot: tools as unknown as Prisma.InputJsonValue,
        limits: { maxRepairRounds: 0, maxQaRepairRounds: 0, maxCostUsd: s.maxCostUsdPerBuild, timeoutMin: s.buildTimeoutMin },
      },
      include: buildInclude,
    });
    await this.audit.log('build.qa_run', `${src.project.name} · QA on the code of ${run.sourceBuildLabel} → ${buildLabel(run.seq)}`, { projectId: src.projectId, buildId: run.id });
    return toBuildSummary(run);
  }

  async detail(id: string): Promise<BuildDetail> {
    const b = await this.prisma.build.findUnique({ where: { id }, include: { ...buildInclude, artifacts: { orderBy: { createdAt: 'asc' } } } });
    if (!b) throw new NotFoundException('Build not found');
    return { ...toBuildSummary(b), provenance: b.provenance as Record<string, string>, artifacts: b.artifacts.map(toArtifactDto), limits: b.limits as BuildDetail['limits'], generation: (b.generation as BuildDetail['generation']) ?? null };
  }

  async logs(id: string, after = 0): Promise<BuildLogDto[]> {
    const rows = await this.prisma.buildLog.findMany({ where: { buildId: id, id: { gt: after } }, orderBy: { id: 'asc' }, take: 2000 });
    return rows.map((r) => ({ id: r.id, ts: r.ts.toISOString(), level: r.level as BuildLogDto['level'], stage: r.stage as BuildLogDto['stage'], message: r.message }));
  }

  async qa(id: string): Promise<QaReport> {
    const b = await this.prisma.build.findUnique({ where: { id }, include: { ...buildInclude, qaResults: true, version: { select: { number: true, toolsSnapshot: true } } } });
    const snapshot = (b?.toolsSnapshot ?? b?.version.toolsSnapshot) as unknown as ToolSnapshot[] | null;
    if (!b) throw new NotFoundException('Build not found');
    const results = b.qaResults.map((r) => ({ id: r.id, layer: r.layer as QaLayer, tool: r.tool, name: r.name, status: r.status, detail: r.detail, evidence: r.evidence ?? undefined }));
    const layers = LAYERS.map((layer) => {
      const rs = results.filter((r) => r.layer === layer);
      const n = (s: QaStatus) => rs.filter((r) => r.status === s).length;
      return { layer, pass: n('pass'), fail: n('fail'), blocked: n('blocked'), notRun: n('not_run') };
    });
    const toolNames = (snapshot ?? []).map((t) => t.name);
    const matrix = toolNames.map((tool) => {
      const cells: Partial<Record<QaLayer, QaStatus>> = {};
      for (const r of results.filter((x) => x.tool === tool)) {
        const cur = cells[r.layer];
        if (!cur || RANK[r.status] > RANK[cur]) cells[r.layer] = r.status;
      }
      return { tool, cells };
    });
    return { build: toBuildSummary(b), layers, matrix, failures: results.filter((r) => r.status === 'fail'), results };
  }

  async versions(projectId: string): Promise<VersionDto[]> {
    const rows = await this.prisma.version.findMany({ where: { projectId }, orderBy: { createdAt: 'desc' }, include: { builds: { orderBy: { createdAt: 'desc' }, take: 1, include: buildInclude } } });
    return rows.map((v) => ({
      ...toVersionSummary(v),
      changelog: v.changelog,
      toolCount: ((v.toolsSnapshot as unknown[]) ?? []).length,
      latestBuild: v.builds[0] ? toBuildSummary(v.builds[0]) : null,
    }));
  }

  async release(id: string): Promise<VersionDto> {
    const v = await this.prisma.version.findUnique({ where: { id }, include: { builds: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (!v) throw new NotFoundException('Version not found');
    if (v.status !== 'draft') throw new BadRequestException('Only draft versions can be released');
    const b = v.builds[0];
    if (!b || b.status !== 'succeeded' || !b.packageVerified) throw new BadRequestException('The latest build of this version is not Package verified');
    await this.prisma.version.update({ where: { id }, data: { status: 'released', releasedAt: new Date() } });
    await this.audit.log('version.release', `v${v.number}`, { projectId: v.projectId, versionId: id, buildId: b.id, integrationVerified: b.integrationVerified });
    return (await this.versions(v.projectId)).find((x) => x.id === id)!;
  }

  async deprecate(id: string): Promise<VersionDto> {
    const v = await this.prisma.version.findUnique({ where: { id } });
    if (!v) throw new NotFoundException('Version not found');
    if (v.status !== 'released') throw new BadRequestException('Only released versions can be deprecated');
    await this.prisma.version.update({ where: { id }, data: { status: 'deprecated', deprecatedAt: new Date() } });
    await this.audit.log('version.deprecate', `v${v.number}`, { projectId: v.projectId, versionId: id });
    return (await this.versions(v.projectId)).find((x) => x.id === id)!;
  }
}

/** Polls queued builds from Postgres (FOR UPDATE SKIP LOCKED) and runs them one at a time per process. */
@Injectable()
export class BuildWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('BuildWorker');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly prisma: PrismaService, private readonly events: BuildEvents) {}

  async onApplicationBootstrap() {
    // A build cannot survive an API restart: its subprocesses are gone.
    const orphans = await this.prisma.build.updateMany({ where: { status: 'running' }, data: { status: 'failed', error: 'The API restarted while the build was running', finishedAt: new Date() } });
    if (orphans.count) this.logger.warn(`Marked ${orphans.count} orphaned build(s) as failed`);
    this.timer = setInterval(() => void this.tick(), config.workerPollMs);
  }

  onApplicationShutdown() { clearInterval(this.timer); }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const claimed = await this.prisma.$queryRaw<{ id: string }[]>`
        UPDATE "Build" SET status = 'running', "startedAt" = (now() AT TIME ZONE 'UTC')
        WHERE id = (SELECT id FROM "Build" WHERE status = 'queued' ORDER BY "createdAt" FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id`;
      if (claimed[0]) {
        this.logger.log(`Running build ${claimed[0].id}`);
        await new BuildRunner(this.prisma, this.events, claimed[0].id).run();
      }
    } catch (err) {
      this.logger.error(err);
    } finally {
      this.busy = false;
    }
  }
}

@Controller()
export class BuildsController {
  constructor(private readonly svc: BuildsService, private readonly prisma: PrismaService, private readonly events: BuildEvents, private readonly audit: AuditService) {}

  @Post('projects/:id/builds') create(@Param('id') id: string, @Body() body: unknown) { return this.svc.create(id, body); }

  @Get('projects/:id/builds')
  async list(@Param('id') id: string): Promise<BuildSummary[]> {
    return (await this.prisma.build.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, take: 50, include: buildInclude })).map(toBuildSummary);
  }

  @Get('builds/:id') detail(@Param('id') id: string) { return this.svc.detail(id); }
  @Post('builds/:id/qa-run') qaRun(@Param('id') id: string, @Body() body: unknown) { return this.svc.createQaRun(id, body); }
  @Get('builds/:id/logs') logs(@Param('id') id: string, @Query('after') after?: string) { return this.svc.logs(id, Number(after) || 0); }
  @Get('builds/:id/qa') qa(@Param('id') id: string) { return this.svc.qa(id); }

  @Post('builds/:id/cancel')
  async cancel(@Param('id') id: string) {
    const b = await this.prisma.build.findUnique({ where: { id } });
    if (!b) throw new NotFoundException('Build not found');
    if (b.status === 'queued') await this.prisma.build.update({ where: { id }, data: { status: 'cancelled', cancelRequested: true, finishedAt: new Date(), error: 'Cancelled by user' } });
    else if (b.status === 'running') await this.prisma.build.update({ where: { id }, data: { cancelRequested: true } });
    else throw new BadRequestException('Build has already finished');
    await this.audit.log('build.cancel', id, { projectId: b.projectId, buildId: id });
    return this.svc.detail(id);
  }

  /** SSE: replays existing logs, then streams new logs and build state changes. */
  @Sse('builds/:id/events')
  stream(@Param('id') id: string): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let lastId = 0;
      const off = this.events.on(id, (e) => {
        if (e.type === 'log') { if (e.log.id <= lastId) return; lastId = e.log.id; }
        sub.next({ data: e });
      });
      void (async () => {
        const b = await this.prisma.build.findUnique({ where: { id }, include: buildInclude });
        if (!b) { sub.error(new NotFoundException('Build not found')); return; }
        sub.next({ data: { type: 'build', build: toBuildSummary(b) } });
        for (const log of await this.svc.logs(id)) { if (log.id > lastId) { lastId = log.id; sub.next({ data: { type: 'log', log } }); } }
      })();
      const ping = setInterval(() => sub.next({ data: { type: 'ping' } }), 25_000);
      return () => { off(); clearInterval(ping); };
    });
  }

  @Get('projects/:id/versions') versions(@Param('id') id: string) { return this.svc.versions(id); }
  @Post('versions/:id/release') release(@Param('id') id: string) { return this.svc.release(id); }
  @Post('versions/:id/deprecate') deprecate(@Param('id') id: string) { return this.svc.deprecate(id); }

  @Get('artifacts/:id/download')
  async download(@Param('id') id: string, @Res() res: Response) {
    const a = await this.prisma.artifact.findUnique({ where: { id } });
    if (!a || !existsSync(a.path) || !a.path.startsWith(config.dataDir)) throw new NotFoundException('Artifact not found');
    res.download(a.path, a.filename);
  }
}

@Module({ controllers: [BuildsController], providers: [BuildsService, BuildWorker] })
export class BuildsModule {}
