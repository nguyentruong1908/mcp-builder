import {
  BadRequestException, Body, Controller, Delete, Get, Injectable, Logger, Module, NotFoundException, Param, Post,
  type OnApplicationBootstrap, type OnApplicationShutdown,
} from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { DeployResult, DeploymentDto, DeploymentStatus } from '@mcp-builder/shared';
import { config } from '../config.js';
import { AuditService } from '../core/core.services.js';
import { buildLabel } from '../core/mappers.js';
import { PrismaService } from '../core/prisma.service.js';
import { iso, parse, resolveSecret, sha256 } from '../core/util.js';
import { minimalEnv, run, tail } from '../builds/pipeline/proc.js';
import type { ToolSnapshot } from '../builds/pipeline/types.js';
import { buildInstructions } from './instructions.js';

interface Proc { child: ChildProcess; port: number; logs: string[]; stopped: boolean }

const newToken = () => `mcpb_${randomBytes(24).toString('base64url')}`;
const freePort = () => new Promise<number>((ok, fail) => {
  const s = createServer().once('error', fail).listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    s.close(() => ok(port));
  });
});
export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Runs deployed MCP servers as child processes of the API (one per project) and restores them after a restart. */
@Injectable()
export class DeploymentManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('Deployments');
  private readonly procs = new Map<string, Proc>();

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    for (const d of await this.prisma.deployment.findMany({ where: { desired: 'running' }, select: { id: true } })) void this.launch(d.id);
  }

  onApplicationShutdown() {
    for (const id of [...this.procs.keys()]) this.kill(id);
  }

  port(id: string): number | undefined { return this.procs.get(id)?.port; }
  logs(id: string): string[] { return this.procs.get(id)?.logs ?? []; }

  private kill(id: string) {
    const p = this.procs.get(id);
    if (!p) return;
    p.stopped = true;
    p.child.kill('SIGTERM');
    this.procs.delete(id);
  }

  private setStatus(id: string, status: DeploymentStatus, extra: Record<string, unknown> = {}) {
    return this.prisma.deployment.update({ where: { id }, data: { status, ...extra } }).catch(() => undefined);
  }

  /** Installs the build's package (once per build) and starts it in Streamable HTTP mode on a loopback port. */
  async launch(id: string): Promise<void> {
    this.kill(id);
    const d = await this.prisma.deployment.findUnique({ where: { id }, include: { build: { include: { artifacts: true } } } });
    if (!d) return;
    await this.setStatus(id, 'starting', { lastError: null });
    try {
      const conn = await this.prisma.connection.findUnique({ where: { id: d.connectionId } });
      if (!conn) throw new Error('The selected environment no longer exists');
      const secret = resolveSecret(conn.secretRef);
      if (conn.authType !== 'none' && !secret) throw new Error(`Secret ${conn.secretRef || '(empty)'} is not configured on the server`);
      const env: Record<string, string> = { API_BASE_URL: conn.baseUrl, API_TIMEOUT_MS: '15000' };
      if (conn.authType === 'bearer') env.API_TOKEN = secret!;
      if (conn.authType === 'api_key') { env.API_KEY = secret!; env.API_KEY_HEADER = conn.authHeader; }

      const tgz = d.build.artifacts.find((a) => a.kind === 'mcp_package');
      if (!tgz || !existsSync(tgz.path)) throw new Error(`Package of ${buildLabel(d.build.seq)} is missing`);
      const pkg = String((d.build.provenance as Record<string, string>).package ?? '').replace(/@[^@]*$/, '');
      if (!pkg) throw new Error('Package name missing from provenance');
      const dir = join(config.dataDir, 'deployments', d.slug, buildLabel(d.build.seq));
      const entry = join(dir, 'node_modules', pkg, 'dist/mcp.js');
      if (!existsSync(entry)) {
        await mkdir(dir, { recursive: true });
        await run('npm', ['init', '-y'], { cwd: dir, timeoutMs: 30_000 });
        const inst = await run('npm', ['install', tgz.path, '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, timeoutMs: 300_000 });
        if (inst.code !== 0 || !existsSync(entry)) throw new Error(`npm install failed: ${tail(inst.stderr, 400)}`);
      }

      const port = await freePort();
      // The server never sees the deployment token: the proxy authenticates, the server only listens on loopback.
      const child = spawn(process.execPath, [entry, '--http', String(port)], { cwd: dir, env: minimalEnv(env), stdio: ['ignore', 'pipe', 'pipe'] });
      const proc: Proc = { child, port, logs: [], stopped: false };
      const capture = (b: Buffer) => {
        for (const line of b.toString('utf8').split('\n').filter(Boolean)) proc.logs.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
        proc.logs.splice(0, Math.max(0, proc.logs.length - 300));
      };
      child.stdout!.on('data', capture);
      child.stderr!.on('data', capture);
      this.procs.set(id, proc);
      child.on('exit', (code) => {
        if (this.procs.get(id) === proc) this.procs.delete(id);
        if (proc.stopped) return;
        this.logger.warn(`Deployment ${d.slug} exited with code ${code}`);
        void this.setStatus(id, 'failed', { lastError: `Server exited (code ${code}): ${proc.logs.at(-1) ?? 'no output'}`.slice(0, 500) });
      });

      for (let i = 0; ; i++) {
        if (proc.stopped || child.exitCode !== null) throw new Error(`Server exited during startup: ${proc.logs.at(-1) ?? 'no output'}`);
        const ok = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok, () => false);
        if (ok) break;
        if (i > 60) throw new Error('Server did not become healthy within 20s');
        await new Promise((r) => setTimeout(r, 300));
      }
      await this.setStatus(id, 'running', { startedAt: new Date(), stoppedAt: null });
    } catch (err) {
      this.kill(id);
      await this.setStatus(id, 'failed', { lastError: (err as Error).message.slice(0, 500) });
    }
  }

  async stop(id: string) {
    this.kill(id);
    await this.prisma.deployment.update({ where: { id }, data: { desired: 'stopped', status: 'stopped', stoppedAt: new Date() } });
  }
}

/** Express handler mounted at /mcp: authenticates the bearer token, then streams to the deployed server. */
export function mcpProxy(prisma: PrismaService, manager: DeploymentManager) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, error: string) => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };
    const [path, query] = (req.url ?? '/').split('?', 2);
    const [, slug, ...rest] = path.split('/');
    if (!slug) return send(404, 'Not found');
    const d = await prisma.deployment.findUnique({ where: { slug }, select: { id: true, tokenHash: true, status: true } }).catch(() => null);
    if (!d) return send(404, 'Unknown MCP server');
    const auth = req.headers.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !tokenMatches(auth.slice(7).trim(), d.tokenHash)) {
      res.setHeader('www-authenticate', 'Bearer');
      return send(401, 'Missing or invalid bearer token');
    }
    const port = manager.port(d.id);
    if (!port || d.status !== 'running') return send(503, `MCP server is ${d.status}`);
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    delete headers.authorization;
    const up = request(
      { host: '127.0.0.1', port, method: req.method, path: `/mcp${rest.length ? `/${rest.join('/')}` : ''}${query ? `?${query}` : ''}`, headers },
      (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); },
    );
    up.on('error', (e) => (res.headersSent ? res.destroy() : send(502, `Upstream error: ${e.message}`)));
    req.pipe(up);
  };
}

@Controller()
export class DeploymentsController {
  constructor(private readonly prisma: PrismaService, private readonly manager: DeploymentManager, private readonly audit: AuditService) {}

  private async dto(id: string): Promise<DeploymentDto> {
    const d = await this.prisma.deployment.findUnique({ where: { id }, include: { project: true, build: { include: { version: true } } } });
    if (!d) throw new NotFoundException('Deployment not found');
    const conn = await this.prisma.connection.findUnique({ where: { id: d.connectionId }, select: { name: true } });
    const tools = ((d.build.toolsSnapshot ?? d.build.version.toolsSnapshot) as unknown as ToolSnapshot[] | null ?? [])
      .map(({ name, description, impact, requireConfirm }) => ({ name, description, impact, requireConfirm }));
    const url = `${config.publicUrl}/mcp/${d.slug}`;
    return {
      id: d.id,
      projectId: d.projectId,
      slug: d.slug,
      url,
      status: d.status as DeploymentStatus,
      buildId: d.buildId,
      buildLabel: buildLabel(d.build.seq),
      versionNumber: d.build.version.number,
      packageName: String((d.build.provenance as Record<string, string>).package ?? ''),
      connectionId: d.connectionId,
      connectionName: conn?.name ?? '(deleted)',
      tokenHint: d.tokenHint,
      lastError: d.lastError,
      startedAt: iso(d.startedAt),
      stoppedAt: iso(d.stoppedAt),
      createdAt: d.createdAt.toISOString(),
      tools,
      instructions: buildInstructions({ url, slug: d.slug, projectName: d.project.name, description: d.project.description, tools }),
    };
  }

  @Get('projects/:id/deployment')
  async get(@Param('id') projectId: string): Promise<DeploymentDto | null> {
    const d = await this.prisma.deployment.findUnique({ where: { projectId }, select: { id: true } });
    return d ? this.dto(d.id) : null;
  }

  @Post('builds/:id/deploy')
  async deploy(@Param('id') buildId: string, @Body() body: unknown): Promise<DeployResult> {
    const { connectionId } = parse(z.object({ connectionId: z.string().min(1) }).strict(), body);
    const build = await this.prisma.build.findUnique({ where: { id: buildId }, include: { artifacts: true, project: true } });
    if (!build) throw new NotFoundException('Build not found');
    if (!build.packageVerified || !build.artifacts.some((a) => a.kind === 'mcp_package')) throw new BadRequestException('Only Package verified builds with a package can be deployed');
    const conn = await this.prisma.connection.findUnique({ where: { id: connectionId } });
    if (!conn || conn.projectId !== build.projectId) throw new BadRequestException('Choose an environment of this project');

    const existing = await this.prisma.deployment.findUnique({ where: { projectId: build.projectId } });
    let token: string | null = null;
    let id: string;
    if (existing) {
      // Redeploy keeps the URL and token so connected agents keep working.
      await this.prisma.deployment.update({ where: { id: existing.id }, data: { buildId, connectionId, desired: 'running', status: 'starting' } });
      id = existing.id;
    } else {
      token = newToken();
      id = (await this.prisma.deployment.create({
        data: { projectId: build.projectId, slug: build.project.slug, buildId, connectionId, tokenHash: sha256(token), tokenHint: token.slice(-4) },
      })).id;
    }
    void this.manager.launch(id);
    await this.audit.log(existing ? 'deployment.redeploy' : 'deployment.create', `${build.project.slug} → ${buildLabel(build.seq)} (${conn.name})`, { projectId: build.projectId, buildId });
    return { deployment: await this.dto(id), token };
  }

  @Post('deployments/:id/start')
  async start(@Param('id') id: string): Promise<DeploymentDto> {
    await this.prisma.deployment.update({ where: { id }, data: { desired: 'running', status: 'starting' } }).catch(() => { throw new NotFoundException('Deployment not found'); });
    void this.manager.launch(id);
    return this.dto(id);
  }

  @Post('deployments/:id/stop')
  async stop(@Param('id') id: string): Promise<DeploymentDto> {
    await this.dto(id);
    await this.manager.stop(id);
    await this.audit.log('deployment.stop', id);
    return this.dto(id);
  }

  @Post('deployments/:id/rotate-token')
  async rotate(@Param('id') id: string): Promise<DeployResult> {
    await this.dto(id);
    const token = newToken();
    await this.prisma.deployment.update({ where: { id }, data: { tokenHash: sha256(token), tokenHint: token.slice(-4) } });
    await this.audit.log('deployment.rotate_token', id);
    return { deployment: await this.dto(id), token };
  }

  @Delete('deployments/:id')
  async remove(@Param('id') id: string) {
    const d = await this.prisma.deployment.findUnique({ where: { id } });
    if (!d) throw new NotFoundException('Deployment not found');
    await this.manager.stop(id);
    await this.prisma.deployment.delete({ where: { id } });
    await rm(join(config.dataDir, 'deployments', d.slug), { recursive: true, force: true });
    await this.audit.log('deployment.delete', d.slug, { projectId: d.projectId });
    return { ok: true };
  }

  @Get('deployments/:id/logs')
  logs(@Param('id') id: string) { return { lines: this.manager.logs(id) }; }
}

@Module({ controllers: [DeploymentsController], providers: [DeploymentManager], exports: [DeploymentManager] })
export class DeploymentsModule {}
