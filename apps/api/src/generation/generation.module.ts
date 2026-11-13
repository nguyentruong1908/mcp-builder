import { Body, Controller, Delete, Get, Global, Injectable, Module, NotFoundException, Param, Post, Put } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { z } from 'zod';
import type {
  CodexModelOption, EffectiveGeneration, GenerationProfile, GenerationProfileDto, ModelCheckResult, ProjectGenerationDto, ReasoningEffort,
} from '@mcp-factory/shared';
import { codexHome, config } from '../config.js';
import { AuditService } from '../core/core.services.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse, sha256 } from '../core/util.js';
import { minimalEnv } from '../builds/pipeline/proc.js';
import { Prisma } from '../generated/prisma/client.js';

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const profileSchema = z.object({
  model: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,80}$/, 'Tên model không hợp lệ').nullable(),
  reasoningEffort: z.enum(EFFORTS).nullable(),
  rules: z.string().max(20_000),
}).strict();

const EMPTY: GenerationProfileDto = { model: null, reasoningEffort: null, rules: '', version: 0, updatedAt: null };

/** AGENTS.md content: conventions refine style; the prompt's hard rules always win (and are enforced in code). */
export function composeRules(ws: GenerationProfileDto, project: GenerationProfileDto | null): string {
  const parts = [
    ws.rules.trim() && `## Workspace conventions (v${ws.version})\n\n${ws.rules.trim()}`,
    project?.rules.trim() && `## Project conventions (v${project.version})\n\n${project.rules.trim()}`,
  ].filter(Boolean);
  if (!parts.length) return '';
  return `# Generation conventions (MCP Factory profile)

These conventions refine how adapters and the README are written. They never override the task rules
given in the prompt: only src/adapters/ and README.md may change, no network access, no secrets,
no new dependencies, and factory/tools.json is authoritative.

${parts.join('\n\n')}
`;
}

export function effectiveOf(ws: GenerationProfileDto, project: GenerationProfileDto | null): EffectiveGeneration {
  const rules = composeRules(ws, project);
  return {
    model: project?.model ?? ws.model ?? config.codexModel,
    reasoningEffort: project?.reasoningEffort ?? ws.reasoningEffort ?? null,
    rules,
    rulesSha256: sha256(rules),
    workspaceVersion: ws.version,
    projectVersion: project?.version ?? null,
    source: {
      model: project?.model ? 'project' : ws.model ? 'workspace' : 'env',
      reasoningEffort: project?.reasoningEffort ? 'project' : ws.reasoningEffort ? 'workspace' : 'default',
    },
  };
}

@Injectable()
export class GenerationService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async workspace(): Promise<GenerationProfileDto> {
    const row = await this.prisma.setting.findUnique({ where: { key: 'generation' } });
    return { ...EMPTY, ...((row?.value as Partial<GenerationProfileDto>) ?? {}) };
  }

  async projectOverride(projectId: string): Promise<GenerationProfileDto | null> {
    const p = await this.prisma.project.findUnique({ where: { id: projectId }, select: { generation: true } });
    if (!p) throw new NotFoundException('Project không tồn tại');
    return (p.generation as GenerationProfileDto | null) ?? null;
  }

  async effective(projectId: string): Promise<EffectiveGeneration> {
    return effectiveOf(await this.workspace(), await this.projectOverride(projectId));
  }

  async project(projectId: string): Promise<ProjectGenerationDto> {
    const [workspace, override] = [await this.workspace(), await this.projectOverride(projectId)];
    return { workspace, override, effective: effectiveOf(workspace, override) };
  }

  async putWorkspace(body: unknown): Promise<GenerationProfileDto> {
    const input = parse(profileSchema, body);
    const cur = await this.workspace();
    const value: GenerationProfileDto = { ...input, version: cur.version + 1, updatedAt: new Date().toISOString() };
    await this.prisma.setting.upsert({ where: { key: 'generation' }, create: { key: 'generation', value: value as unknown as Prisma.InputJsonValue }, update: { value: value as unknown as Prisma.InputJsonValue } });
    await this.audit.log('generation.workspace', `v${value.version} · ${value.model ?? 'default'} · ${value.reasoningEffort ?? 'default'}`, { rulesSha256: sha256(value.rules) });
    return value;
  }

  async putProject(projectId: string, body: unknown): Promise<ProjectGenerationDto> {
    const input = parse(profileSchema, body);
    const cur = await this.projectOverride(projectId);
    const value: GenerationProfileDto = { ...input, version: (cur?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
    await this.prisma.project.update({ where: { id: projectId }, data: { generation: value as unknown as Prisma.InputJsonValue } });
    await this.audit.log('generation.project', `v${value.version} · ${value.model ?? 'inherit'} · ${value.reasoningEffort ?? 'inherit'}`, { projectId, rulesSha256: sha256(value.rules) });
    return this.project(projectId);
  }

  async deleteProject(projectId: string): Promise<ProjectGenerationDto> {
    await this.projectOverride(projectId);
    await this.prisma.project.update({ where: { id: projectId }, data: { generation: Prisma.DbNull } });
    await this.audit.log('generation.project.reset', projectId, { projectId });
    return this.project(projectId);
  }
}

/** Models the signed-in Codex account advertises (cached by the Codex CLI). Not proof of access: use /check. */
function cachedModels(): CodexModelOption[] {
  const file = join(codexHome, 'models_cache.json');
  try {
    if (existsSync(file)) {
      const d = JSON.parse(readFileSync(file, 'utf8'));
      const list = (d.models ?? d) as Record<string, any>[];
      const opts = list.filter((m) => m.visibility !== 'hide' && typeof m.slug === 'string').map((m) => ({
        slug: m.slug as string,
        displayName: (m.display_name as string) ?? m.slug,
        defaultReasoning: (EFFORTS as readonly string[]).includes(m.default_reasoning_level) ? (m.default_reasoning_level as ReasoningEffort) : null,
        reasoningEfforts: ((m.supported_reasoning_levels ?? []) as (string | { effort: string })[]).map((l) => (typeof l === 'string' ? l : l.effort)).filter((e): e is ReasoningEffort => (EFFORTS as readonly string[]).includes(e)),
      }));
      if (opts.length) return opts;
    }
  } catch { /* fall through */ }
  return [{ slug: config.codexModel, displayName: config.codexModel, defaultReasoning: null, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'] }];
}

@Controller()
export class GenerationController {
  constructor(private readonly svc: GenerationService) {}

  @Get('generation-profile') workspace() { return this.svc.workspace(); }
  @Put('generation-profile') putWorkspace(@Body() body: unknown) { return this.svc.putWorkspace(body); }
  @Get('projects/:id/generation') project(@Param('id') id: string) { return this.svc.project(id); }
  @Put('projects/:id/generation') putProject(@Param('id') id: string, @Body() body: unknown) { return this.svc.putProject(id, body); }
  @Delete('projects/:id/generation') deleteProject(@Param('id') id: string) { return this.svc.deleteProject(id); }

  @Get('codex/models') models(): CodexModelOption[] { return cachedModels(); }

  /** Proves the account can use a model with a tiny Codex turn (costs a few tokens). */
  @Post('codex/models/check')
  async check(@Body() body: unknown): Promise<ModelCheckResult> {
    const { model } = parse(z.object({ model: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,80}$/) }).strict(), body);
    const dir = await mkdtemp(join(tmpdir(), 'mcpf-model-'));
    try {
      const codex = new Codex({ env: minimalEnv({ CODEX_HOME: codexHome }), ...(process.env.CODEX_API_KEY ? { apiKey: process.env.CODEX_API_KEY } : {}) });
      const thread = codex.startThread({ workingDirectory: dir, skipGitRepoCheck: true, sandboxMode: 'read-only', approvalPolicy: 'never', model });
      const turn = await thread.run('Reply with the single word OK. Do not run any commands.', { signal: AbortSignal.timeout(90_000) });
      return { ok: true, model, message: `Model trả lời: ${turn.finalResponse.slice(0, 80)}` };
    } catch (err) {
      return { ok: false, model, message: (err as Error).message.slice(0, 400) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

@Global()
@Module({ controllers: [GenerationController], providers: [GenerationService], exports: [GenerationService] })
export class GenerationModule {}
