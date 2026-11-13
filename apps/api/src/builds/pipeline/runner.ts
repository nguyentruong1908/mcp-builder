import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StageName, StageState } from '@mcp-factory/shared';
import type { Thread } from '@openai/codex-sdk';
import { codexSandbox, config } from '../../config.js';
import { BuildEvents } from '../../core/core.services.js';
import { buildInclude, buildLabel, toBuildSummary } from '../../core/mappers.js';
import { PrismaService } from '../../core/prisma.service.js';
import { redact, resolveSecret, sha256 } from '../../core/util.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { codexAuthConfigured, codexAuthSource, codexSandboxError } from '../../codex/codex-auth.module.js';
import { generationPrompt, isQaFixable, qaRepairPrompt, repairPrompt, runTurn, startThread } from './codex.js';
import { effectiveOf } from '../../generation/generation.module.js';
import type { EffectiveGeneration, GenerationProfileDto } from '@mcp-factory/shared';
import { minimalEnv, run, tail } from './proc.js';
import { parseSampleTasks } from './agent-eval.js';
import { runQa, verdicts } from './qa.js';
import { BuildAbort, type BuildCtx, type ConnectionSnapshot, type CustomToolCase, type QaRow, type ToolSnapshot } from './types.js';
import { enforceProtected, prepareWorkspace, snapshotProtected, walk } from './workspace.js';

const GENERIC_SECRETS: [string, RegExp][] = [
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['OpenAI key', /sk-[A-Za-z0-9_-]{20,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36}/],
  ['Slack token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
];

export class BuildRunner {
  private stages: Record<StageName, StageState> = { spec: 'idle', codex: 'idle', build: 'idle', qa: 'idle', package: 'idle' };
  private current: StageName | null = null;
  private tokens = { input: 0, cached: 0, output: 0 };
  private cost = 0;

  constructor(private readonly prisma: PrismaService, private readonly events: BuildEvents, private readonly buildId: string) {}

  private async emitBuild() {
    const b = await this.prisma.build.findUnique({ where: { id: this.buildId }, include: buildInclude });
    if (b) this.events.emit(this.buildId, { type: 'build', build: toBuildSummary(b) });
  }

  async run(): Promise<void> {
    const build = await this.prisma.build.findUniqueOrThrow({ where: { id: this.buildId }, include: { project: { include: { connections: true, context: true } }, version: true } });
    const source = build.kind === 'qa' && build.sourceBuildId ? await this.prisma.build.findUnique({ where: { id: build.sourceBuildId }, select: { seq: true } }) : null;
    const generation: EffectiveGeneration | null = build.kind === 'qa' ? null
      : (build.generation as EffectiveGeneration | null) ?? effectiveOf(
        { model: null, reasoningEffort: null, rules: '', version: 0, updatedAt: null, ...(((await this.prisma.setting.findUnique({ where: { key: 'generation' } }))?.value as object) ?? {}) },
        (build.project.generation as GenerationProfileDto | null) ?? null,
      );
    if (generation && !build.generation) await this.prisma.build.update({ where: { id: this.buildId }, data: { generation: generation as unknown as Prisma.InputJsonValue } });
    const cases = await this.prisma.testCase.findMany({ where: { projectId: build.projectId, enabled: true }, orderBy: { createdAt: 'asc' } });
    // Export uses the context frozen in the version; a standalone QA run uses today's context.
    const tasksRaw = build.kind === 'qa' ? build.project.context?.sampleTasks ?? '' : String((build.version.contextSnapshot as { data?: { sampleTasks?: string } } | null)?.data?.sampleTasks ?? '');
    const limits = build.limits as BuildCtx['limits'];
    const controller = new AbortController();
    let abortReason = '';
    const abort = (why: string) => { if (!controller.signal.aborted) { abortReason = why; controller.abort(new BuildAbort(why)); } };
    const timeout = setTimeout(() => abort(`Build timed out (${limits.timeoutMin} min)`), limits.timeoutMin * 60_000);
    const cancelPoll = setInterval(async () => {
      const b = await this.prisma.build.findUnique({ where: { id: this.buildId }, select: { cancelRequested: true } }).catch(() => null);
      if (b?.cancelRequested) abort('Cancelled by user');
    }, 2000);

    const qaConn = build.project.connections.find((c) => c.useForQa) ?? null;
    const knownSecrets = build.project.connections.map((c) => resolveSecret(c.secretRef)).filter((s): s is string => !!s);
    const label = buildLabel(build.seq);
    const dir = join(config.dataDir, 'builds', label);
    const slug = build.project.slug;

    const ctx: BuildCtx = {
      buildId: build.id,
      label,
      project: { id: build.projectId, name: build.project.name, slug, description: build.project.description, outputs: build.project.outputs as BuildCtx['project']['outputs'] },
      version: { id: build.versionId, number: build.version.number },
      tools: ((build.toolsSnapshot ?? build.version.toolsSnapshot) as unknown as ToolSnapshot[]) ?? [],
      contextMd: String((build.version.contextSnapshot as { markdown?: string } | null)?.markdown ?? ''),
      specRaw: '',
      specSha: '',
      qaConnection: qaConn ? ({ name: qaConn.name, baseUrl: qaConn.baseUrl, authType: qaConn.authType, authHeader: qaConn.authHeader, secretRef: qaConn.secretRef, allowWrite: qaConn.allowWrite, agentAccess: qaConn.allowWrite ? (qaConn.agentAccess as ConnectionSnapshot['agentAccess']) : 'read_only' } satisfies ConnectionSnapshot) : null,
      runIntegration: build.runIntegration,
      runAgentEval: build.runAgentEval,
      sampleTasks: [
        ...parseSampleTasks(tasksRaw),
        ...cases.filter((c) => c.kind === 'agent_task' && c.task).map((c) => ({ text: c.task!, expected: c.expectedTools, answerContains: c.answerContains, label: c.name })),
      ],
      toolCases: cases.filter((c) => (c.kind === 'tool_call' && c.tool) || c.kind === 'tool_steps').map((c) => ({
        ...(c.kind === 'tool_steps' ? { steps: c.steps as unknown as NonNullable<CustomToolCase['steps']> } : {}),
        name: c.name, tool: c.tool ?? (c.steps as { tool: string; cleanup: boolean }[]).find((s) => !s.cleanup)?.tool ?? '', args: (c.args as Record<string, unknown>) ?? {}, target: c.target === 'live' ? 'live' : 'mock',
        mockResponse: (c.mockResponse as CustomToolCase['mockResponse']) ?? null, expect: (c.expect as CustomToolCase['expect']) ?? {},
      })),
      qaOnly: source ? { sourceLabel: buildLabel(source.seq), sourceWs: join(config.dataDir, 'builds', buildLabel(source.seq), 'workspace') } : null,
      limits,
      generation,
      dir,
      ws: join(dir, 'workspace'),
      outDir: join(dir, 'artifacts'),
      packageName: slug.endsWith('-tools') ? slug : `${slug}-tools`,
      cliBin: slug,
      mcpBin: `${slug}-mcp`,
      signal: controller.signal,
      knownSecrets,
      checks: {},
      log: async (level, stage, message) => {
        const row = await this.prisma.buildLog.create({ data: { buildId: this.buildId, level, stage, message: redact(message, knownSecrets).slice(0, 8000) } });
        this.events.emit(this.buildId, { type: 'log', log: { id: row.id, ts: row.ts.toISOString(), level: level, stage, message: row.message } });
      },
      setStage: async (stage, state) => {
        this.stages[stage] = state;
        if (state === 'running') this.current = stage;
        await this.prisma.build.update({ where: { id: this.buildId }, data: { stage, stages: this.stages } });
        await this.emitBuild();
      },
      addUsage: async (u) => {
        this.tokens.input += u.input_tokens;
        this.tokens.cached += u.cached_input_tokens;
        this.tokens.output += u.output_tokens;
        const p = config.price;
        this.cost = ((this.tokens.input - this.tokens.cached) * p.input + this.tokens.cached * p.cached + this.tokens.output * p.output) / 1e6;
        await this.prisma.build.update({ where: { id: this.buildId }, data: { inputTokens: this.tokens.input, cachedInputTokens: this.tokens.cached, outputTokens: this.tokens.output, costUsd: this.cost } });
        await this.emitBuild();
        return this.cost;
      },
    };

    const startedAt = Date.now();
    try {
      await ctx.log('info', 'job', ctx.qaOnly
        ? `QA run ${label} · ${ctx.project.name} v${ctx.version.number} · on the code of ${ctx.qaOnly.sourceLabel} · ${ctx.tools.length} tools · ${ctx.toolCases.length} tool test cases · ${ctx.sampleTasks.length} agent tasks`
        : `Build ${label} · ${ctx.project.name} v${ctx.version.number} · ${ctx.tools.length} tools · model ${generation!.model}${generation!.reasoningEffort ? ` (${generation!.reasoningEffort})` : ''} · profile workspace v${generation!.workspaceVersion}${generation!.projectVersion ? ` + project v${generation!.projectVersion}` : ''}${generation!.rules ? ' · with AGENTS.md' : ''}`);
      await this.stageSpec(ctx, build.version.specSnapshotId);
      const thread = ctx.qaOnly ? await this.skipCodex(ctx) : await this.stageCodex(ctx);
      await this.stageBuild(ctx, thread);
      let qa = await this.stageQa(ctx);
      if (thread) qa = await this.repairFromQa(ctx, thread, qa);
      await this.stagePackage(ctx, qa, thread);
      const ok = qa.packageVerified;
      await this.finish(ok ? 'succeeded' : 'failed', ok ? null : `QA not passed: ${qa.failures} required checks failed. Kept as a draft, not marked Ready.`);
      await ctx.log(ok ? 'success' : 'error', 'job', `Package verified: ${ok ? 'YES' : 'NO'} · Integration verified: ${qa.integration.toUpperCase()} · ${Math.round((Date.now() - startedAt) / 1000)}s · $${this.cost.toFixed(2)}`);
    } catch (err) {
      const cancelled = abortReason === 'Cancelled by user';
      const message = abortReason || (err as Error).message;
      if (this.current && this.stages[this.current] === 'running') await ctx.setStage(this.current, 'failed').catch(() => undefined);
      await ctx.log('error', this.current ?? 'job', message).catch(() => undefined);
      await this.finish(cancelled ? 'cancelled' : 'failed', message);
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      // Keep sources for inspection, drop heavy dependencies.
      await rm(join(ctx.ws, 'node_modules'), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async finish(status: 'succeeded' | 'failed' | 'cancelled', error: string | null) {
    await this.prisma.build.update({ where: { id: this.buildId }, data: { status, error, finishedAt: new Date(), stage: this.current } });
    await this.emitBuild();
  }

  private check(ctx: BuildCtx) {
    if (ctx.signal.aborted) throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new BuildAbort('Aborted');
  }

  private async stageSpec(ctx: BuildCtx, specSnapshotId: string | null) {
    await ctx.setStage('spec', 'running');
    const needsCodex = !ctx.qaOnly || (ctx.runAgentEval && ctx.sampleTasks.length > 0);
    if (needsCodex && !codexAuthConfigured()) throw new Error('Codex is not signed in. Go to Settings › Codex to sign in, add an API key, or upload auth.json.');
    const sandboxError = needsCodex && !ctx.qaOnly ? await codexSandboxError() : null;
    if (sandboxError) throw new Error(`The Codex sandbox cannot start: ${sandboxError}`);
    if (!specSnapshotId) throw new Error('The version has no spec snapshot');
    const snap = await this.prisma.specSnapshot.findUniqueOrThrow({ where: { id: specSnapshotId } });
    const errors = (snap.issues as { level: string; message: string }[]).filter((i) => i.level === 'error');
    if (errors.length) throw new Error(`The spec has errors: ${errors.map((e) => e.message).join('; ')}`);
    if (!ctx.tools.length) throw new Error('No tools selected in the Tool designer');
    ctx.specRaw = snap.raw;
    ctx.specSha = snap.sha256;
    await ctx.log('info', 'spec', `OAS ${snap.oasVersion} · snapshot ${snap.sha256.slice(0, 12)} · tools: ${ctx.tools.map((t) => t.name).join(', ')}`);
    if (ctx.qaOnly) {
      // Same generated code as the source build; node_modules are reinstalled from its lockfile.
      await rm(ctx.dir, { recursive: true, force: true });
      await mkdir(ctx.outDir, { recursive: true });
      await cp(ctx.qaOnly.sourceWs, ctx.ws, { recursive: true, filter: (p) => !p.includes(`${sep}node_modules`) });
      await ctx.log('info', 'spec', `Workspace copied from ${ctx.qaOnly.sourceLabel}; installing dependencies…`);
    } else {
      await prepareWorkspace(ctx);
      await ctx.log('info', 'spec', 'Workspace created from the mcp-node template; installing dependencies…');
    }
    const inst = await run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: ctx.ws, signal: ctx.signal, timeoutMs: 300_000 });
    this.check(ctx);
    if (inst.code !== 0) throw new Error(`npm install failed: ${tail(inst.stderr, 800)}`);
    await ctx.setStage('spec', 'ok');
  }

  private async skipCodex(ctx: BuildCtx): Promise<null> {
    await ctx.log('info', 'codex', `Skipping code generation: reusing the adapters of ${ctx.qaOnly!.sourceLabel}`);
    await ctx.setStage('codex', 'skipped');
    return null;
  }

  private async stageCodex(ctx: BuildCtx): Promise<Thread> {
    await ctx.setStage('codex', 'running');
    const protectedFiles = await snapshotProtected(ctx.ws);
    const thread = startThread(ctx);
    await ctx.log('info', 'codex', `Codex thread started (sandbox ${codexSandbox}, ${codexSandbox === 'workspace-write' ? 'no network' : 'container network'}, plugins off, model ${ctx.generation?.model ?? config.codexModel})`);
    await runTurn(ctx, thread, generationPrompt(ctx));
    if (thread.id) await this.prisma.build.update({ where: { id: this.buildId }, data: { codexThreadId: thread.id } });
    const reverted = await enforceProtected(ctx.ws, protectedFiles);
    if (reverted.length) await ctx.log('warn', 'codex', `Restored files Codex may not modify: ${reverted.join(', ')}`);
    const adapters = (await walk(ctx.ws)).filter((f) => f.startsWith('src/adapters/') && f.endsWith('.ts'));
    await ctx.log('success', 'codex', `Codex wrote ${adapters.length} adapters for ${ctx.tools.length} tools`);
    await ctx.setStage('codex', 'ok');
    return thread;
  }

  private async stageBuild(ctx: BuildCtx, thread: Thread | null) {
    await ctx.setStage('build', 'running');
    for (let round = 0; ; round++) {
      this.check(ctx);
      const r = await run('npm', ['run', 'build', '--silent'], { cwd: ctx.ws, signal: ctx.signal, timeoutMs: 180_000 });
      if (r.code === 0) { ctx.checks.tsc = true; ctx.checks.tscDetail = round ? `Passed after ${round} repair rounds` : 'Pass'; break; }
      const out = tail(r.stdout + r.stderr, 6000);
      await ctx.log('warn', 'build', `tsc errors:\n${tail(out, 1500)}`);
      if (!thread || round >= ctx.limits.maxRepairRounds) { ctx.checks.tsc = false; throw new Error(`Build still failing after ${round} repair rounds (limit ${ctx.limits.maxRepairRounds})`); }
      await this.prisma.build.update({ where: { id: this.buildId }, data: { repairRounds: round + 1 } });
      await ctx.log('info', 'build', `Repair round ${round + 1}/${ctx.limits.maxRepairRounds}`);
      const snap = await snapshotProtected(ctx.ws);
      await runTurn(ctx, thread, repairPrompt(out));
      const reverted = await enforceProtected(ctx.ws, snap);
      if (reverted.length) await ctx.log('warn', 'build', `Restored: ${reverted.join(', ')}`);
    }
    await ctx.log('success', 'build', `TypeScript build ${ctx.checks.tscDetail}`);

    const findings: string[] = [];
    for (const rel of await walk(ctx.ws)) {
      if (rel === 'package-lock.json') continue;
      const text = await readFile(join(ctx.ws, rel), 'utf8').catch(() => '');
      for (const s of ctx.knownSecrets) if (s.length >= 6 && text.includes(s)) findings.push(`${rel}: contains an environment secret`);
      for (const [name, re] of GENERIC_SECRETS) if (re.test(text)) findings.push(`${rel}: ${name}`);
    }
    ctx.checks.secretScan = findings.length === 0;
    ctx.checks.secretDetail = findings.length ? findings.join('; ') : '0 findings';
    if (findings.length) throw new Error(`Secret scan found: ${findings.join('; ')}`);
    await ctx.log('success', 'build', 'Secret scan: 0 findings');
    await ctx.setStage('build', 'ok');
  }

  private lastQaRows: QaRow[] = [];

  /** Feeds fixable QA failures back to the same Codex thread, rebuilds and re-runs the whole QA suite. */
  private async repairFromQa(ctx: BuildCtx, thread: Thread, qa: ReturnType<typeof verdicts>) {
    const max = ctx.limits.maxQaRepairRounds ?? 0;
    for (let round = 1; round <= max; round++) {
      const fixable = this.lastQaRows.filter(isQaFixable);
      if (!fixable.length) break;
      this.check(ctx);
      await this.prisma.build.update({ where: { id: this.buildId }, data: { qaRepairRounds: round } });
      await ctx.log('warn', 'qa', `QA repair round ${round}/${max}: sending ${fixable.length} failures to Codex`);
      await ctx.setStage('codex', 'running');
      const snap = await snapshotProtected(ctx.ws);
      await runTurn(ctx, thread, qaRepairPrompt(fixable));
      const reverted = await enforceProtected(ctx.ws, snap);
      if (reverted.length) await ctx.log('warn', 'codex', `Restored: ${reverted.join(', ')}`);
      await ctx.setStage('codex', 'ok');
      await this.stageBuild(ctx, thread);
      const before = fixable.length;
      qa = await this.stageQa(ctx);
      const after = this.lastQaRows.filter(isQaFixable).length;
      await ctx.log(after < before ? 'success' : 'warn', 'qa', `After round ${round}: code-fixable failures ${before} → ${after}`);
      if (after >= before) { await ctx.log('warn', 'qa', 'Stopping QA repair: the last round did not reduce failures'); break; }
    }
    return qa;
  }

  private async stageQa(ctx: BuildCtx) {
    await this.prisma.qaResult.deleteMany({ where: { buildId: this.buildId } });
    await ctx.setStage('qa', 'running');
    const rows = await runQa(ctx);
    this.lastQaRows = rows;
    this.check(ctx);
    await this.prisma.qaResult.createMany({
      data: rows.map((r) => ({ buildId: this.buildId, layer: r.layer, tool: r.tool, name: r.name, status: r.status, detail: redact(r.detail, ctx.knownSecrets).slice(0, 4000), evidence: (r.evidence ?? undefined) as Prisma.InputJsonValue | undefined })),
    });
    const v = verdicts(rows, ctx.tools);
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    await ctx.log(v.failures ? 'warn' : 'success', 'qa', `QA: ${count('pass')} pass · ${count('fail')} fail · ${count('blocked')} blocked · ${count('not_run')} not run`);
    for (const r of rows.filter((x) => x.status === 'fail').slice(0, 20)) await ctx.log('error', 'qa', `[${r.layer}] ${r.tool ?? 'package'} · ${r.name}: ${r.detail}`);
    await this.prisma.build.update({ where: { id: this.buildId }, data: { packageVerified: v.packageVerified, integrationVerified: v.integration } });
    await ctx.setStage('qa', v.failures ? 'failed' : 'ok');
    return v;
  }

  private async stagePackage(ctx: BuildCtx, qa: ReturnType<typeof verdicts>, thread: Thread | null) {
    await ctx.setStage('package', 'running');
    if (!ctx.tgzPath) { await ctx.setStage('package', 'failed'); return; }
    const tgz = await readFile(ctx.tgzPath);
    const tplFiles = await walk(config.templateDir);
    const templateHash = sha256((await Promise.all(tplFiles.sort().map(async (f) => f + sha256(await readFile(join(config.templateDir, f)))))).join('|'));
    const sdkVersion = JSON.parse(await readFile(new URL('../../../node_modules/@openai/codex-sdk/package.json', import.meta.url), 'utf8').catch(() => '{"version":"unknown"}')).version;
    const provenance: Record<string, string> = {
      build: ctx.label,
      package: `${ctx.packageName}@${ctx.version.number}`,
      artifactSha256: sha256(tgz),
      specSha256: ctx.specSha,
      contextSha256: sha256(ctx.contextMd),
      toolsSha256: sha256(JSON.stringify(ctx.tools)),
      template: `mcp-node@${templateHash.slice(0, 12)}`,
      codexSdk: `@openai/codex-sdk@${sdkVersion}`,
      model: ctx.generation?.model ?? `${config.codexModel} (agent eval)`,
      ...(ctx.generation ? {
        reasoningEffort: ctx.generation.reasoningEffort ?? 'model default',
        generationProfile: `workspace@v${ctx.generation.workspaceVersion}${ctx.generation.projectVersion ? `+project@v${ctx.generation.projectVersion}` : ''}`,
        rulesSha256: ctx.generation.rulesSha256,
      } : {}),
      codexAuth: codexAuthSource() ?? 'none',
      codexThread: thread?.id ?? (ctx.qaOnly ? `reused from ${ctx.qaOnly.sourceLabel}` : 'unknown'),
      ...(ctx.qaOnly ? { qaRunOf: ctx.qaOnly.sourceLabel } : {}),
      node: process.version,
      packageVerified: String(qa.packageVerified),
      integrationVerified: qa.integration,
      createdAt: new Date().toISOString(),
    };
    const results = await this.prisma.qaResult.findMany({ where: { buildId: this.buildId }, omit: { id: true, buildId: true } });
    const files: [string, string, Buffer][] = [
      ['mcp_package', ctx.tgzPath, tgz],
      ['provenance', join(ctx.outDir, 'provenance.json'), Buffer.from(JSON.stringify(provenance, null, 2))],
      ['qa_report', join(ctx.outDir, 'qa-report.json'), Buffer.from(JSON.stringify({ provenance, verdict: qa, results }, null, 2))],
    ];
    for (const [kind, path, buf] of files) {
      if (kind !== 'mcp_package') await writeFile(path, buf);
      await this.prisma.artifact.create({ data: { buildId: this.buildId, kind, filename: path.split('/').pop()!, path, sha256: sha256(buf), size: (await stat(path)).size } });
    }
    await this.prisma.build.update({ where: { id: this.buildId }, data: { provenance } });
    await ctx.log('success', 'package', `${files[0][1].split('/').pop()} · sha256 ${provenance.artifactSha256.slice(0, 16)}… · provenance + QA report`);
    await ctx.setStage('package', 'ok');
  }
}

export { minimalEnv };
