import { BadRequestException, Body, ConflictException, Controller, Delete, Get, Module, Post } from '@nestjs/common';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { CodexAuthStatus } from '@mcp-factory/shared';
import { codexHome, codexSandbox, config } from '../config.js';
import { AuditService } from '../core/core.services.js';
import { parse } from '../core/util.js';
import { minimalEnv, run } from '../builds/pipeline/proc.js';

const authFile = () => join(codexHome, 'auth.json');

/** The Codex CLI bundled with @openai/codex-sdk (same binary the SDK runs builds with). */
function codexJs(): string {
  const req = createRequire(import.meta.resolve('@openai/codex-sdk'));
  const pkg = req.resolve('@openai/codex/package.json');
  return join(dirname(pkg), 'bin/codex.js');
}

const codexEnv = () => minimalEnv({ CODEX_HOME: codexHome, NO_COLOR: '1' });

function ensureHome() {
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
}

let versionCache = '';
async function codexVersion(): Promise<string> {
  if (!versionCache) {
    const r = await run(process.execPath, [codexJs(), '--version'], { cwd: process.cwd(), env: codexEnv(), timeoutMs: 10_000 }).catch(() => null);
    versionCache = r?.stdout.trim().replace(/^codex-cli\s*/, '') || 'unknown';
  }
  return versionCache;
}

let sandboxCache: { at: number; error: string | null } | null = null;
/** Runs a no-op inside the Codex sandbox. Fails e.g. in containers without user namespaces. Cached 10 min. */
export async function codexSandboxError(): Promise<string | null> {
  if (codexSandbox === 'danger-full-access') return null;
  if (sandboxCache && Date.now() - sandboxCache.at < 600_000) return sandboxCache.error;
  ensureHome();
  const r = await run(process.execPath, [codexJs(), 'sandbox', '--', 'true'], { cwd: codexHome, env: codexEnv(), timeoutMs: 20_000 }).catch((e: Error) => ({ code: 1, stdout: '', stderr: e.message, timedOut: false }));
  const msg = strip(r.stderr || r.stdout).trim().split('\n')[0] ?? '';
  const error = r.code === 0 ? null : `${msg.slice(0, 240)} (xem mục "Codex sandbox trong Docker" ở README)`;
  sandboxCache = { at: Date.now(), error };
  return error;
}

function jwtClaims(token: unknown): Record<string, any> {
  if (typeof token !== 'string') return {};
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

/** True when builds can authenticate to Codex. Used by the build runner before spending anything. */
export function codexAuthConfigured(): boolean {
  if (process.env.CODEX_API_KEY) return true;
  if (!existsSync(authFile())) return false;
  try {
    const a = JSON.parse(readFileSync(authFile(), 'utf8'));
    return !!(a.OPENAI_API_KEY || a.tokens?.access_token);
  } catch { return false; }
}

export function codexAuthSource(): CodexAuthStatus['source'] {
  return process.env.CODEX_API_KEY ? 'env_api_key' : codexAuthConfigured() ? 'auth_file' : null;
}

// ---- device-code login (one at a time per API process)
type Device = CodexAuthStatus['device'] & { child?: ChildProcess };
let device: Device = { state: 'idle', url: null, code: null, expiresAt: null, error: null };
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function writeAuthAtomically(content: string) {
  ensureHome();
  const tmp = `${authFile()}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, authFile());
  chmodSync(authFile(), 0o600);
}

const authJsonSchema = z.object({
  OPENAI_API_KEY: z.string().nullable().optional(),
  tokens: z.object({ access_token: z.string().min(10), refresh_token: z.string().min(10), id_token: z.string().optional(), account_id: z.string().optional() }).passthrough().nullable().optional(),
}).passthrough().refine((a) => !!a.OPENAI_API_KEY || !!a.tokens?.access_token, 'auth.json phải có tokens (đăng nhập ChatGPT) hoặc OPENAI_API_KEY');

@Controller('codex/auth')
export class CodexAuthController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  async status(): Promise<CodexAuthStatus> {
    let mode: CodexAuthStatus['mode'] = null;
    let email: string | null = null;
    let plan: string | null = null;
    let lastRefresh: string | null = null;
    if (existsSync(authFile())) {
      try {
        const a = JSON.parse(readFileSync(authFile(), 'utf8'));
        const claims = jwtClaims(a.tokens?.id_token);
        mode = a.tokens?.access_token ? 'chatgpt' : a.OPENAI_API_KEY ? 'api_key' : null;
        email = claims.email ?? null;
        plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type ?? null;
        lastRefresh = a.last_refresh ?? null;
      } catch { /* unreadable file → reported as not configured */ }
    }
    if (process.env.CODEX_API_KEY) mode = 'api_key';
    const { child: _c, ...dev } = device;
    // Tokens and keys are never returned; only what the operator needs to recognise the account.
    return { configured: codexAuthConfigured(), source: codexAuthSource(), mode, email, plan, lastRefresh, codexVersion: await codexVersion(), model: config.codexModel, sandbox: codexSandbox, sandboxError: await codexSandboxError(), device: dev };
  }

  @Post('upload')
  async upload(@Body() body: unknown): Promise<CodexAuthStatus> {
    const { content } = parse(z.object({ content: z.string().min(2).max(64 * 1024) }).strict(), body);
    let json: unknown;
    try { json = JSON.parse(content); } catch { throw new BadRequestException('File không phải JSON hợp lệ'); }
    parse(authJsonSchema, json);
    writeAuthAtomically(JSON.stringify(json, null, 2));
    await this.audit.log('codex.auth.upload', 'auth.json');
    return this.status();
  }

  @Post('api-key')
  async apiKey(@Body() body: unknown): Promise<CodexAuthStatus> {
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().regex(/^sk-[A-Za-z0-9_-]{20,}$/, 'API key không đúng định dạng (sk-...)') }).strict(), body);
    ensureHome();
    const r = await run(process.execPath, [codexJs(), 'login', '--with-api-key'], { cwd: codexHome, env: codexEnv(), input: apiKey + '\n', timeoutMs: 30_000 });
    if (r.code !== 0) throw new BadRequestException(`codex login thất bại: ${strip(r.stderr || r.stdout).slice(0, 300)}`);
    await this.audit.log('codex.auth.api_key', 'auth.json');
    return this.status();
  }

  @Post('device')
  async startDevice(): Promise<CodexAuthStatus> {
    if (device.state === 'pending') throw new ConflictException('Đang có một phiên đăng nhập chờ xác nhận');
    ensureHome();
    const child = spawn(process.execPath, [codexJs(), 'login', '--device-auth'], { cwd: codexHome, env: codexEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    device = { state: 'pending', url: null, code: null, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(), error: null, child };
    const current = device;
    let out = '';
    const onData = (c: Buffer) => {
      out = (out + strip(c.toString('utf8'))).slice(-8000);
      current.url ??= /https:\/\/\S+/.exec(out)?.[0] ?? null;
      current.code ??= /\b[A-Z0-9]{4,5}-[A-Z0-9]{4,6}\b/.exec(out)?.[0] ?? null;
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (current.state !== 'pending') return;
      current.state = code === 0 && codexAuthConfigured() ? 'success' : 'failed';
      current.error = current.state === 'failed' ? (out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? `exit ${code}`).slice(0, 300) : null;
      current.child = undefined;
      if (current.state === 'success') void this.audit.log('codex.auth.device', 'auth.json');
    });
    // Wait briefly for the URL and code so the first response can show them.
    for (let i = 0; i < 50 && (!current.url || !current.code) && current.state === 'pending'; i++) await new Promise((r) => setTimeout(r, 200));
    return this.status();
  }

  @Delete('device')
  async cancelDevice(): Promise<CodexAuthStatus> {
    if (device.state === 'pending') {
      device.state = 'cancelled';
      device.child?.kill('SIGTERM');
      device.child = undefined;
    }
    return this.status();
  }

  @Post('logout')
  async logout(): Promise<CodexAuthStatus> {
    await this.cancelDevice();
    rmSync(authFile(), { force: true });
    device = { state: 'idle', url: null, code: null, expiresAt: null, error: null };
    await this.audit.log('codex.auth.logout', 'auth.json');
    return this.status();
  }
}

@Module({ controllers: [CodexAuthController] })
export class CodexAuthModule {}
