import { spawn } from 'node:child_process';

export interface ProcResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/**
 * Environment for build subprocesses (npm, node, codex): only what tooling needs.
 * The API's own env (DATABASE_URL, QA secrets, ...) must never leak into generated code or Codex.
 */
export function minimalEnv(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL', 'USER', 'CODEX_HOME', 'npm_config_cache', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return { ...env, ...extra };
}

export function run(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; input?: string }): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? minimalEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (s: string, chunk: Buffer) => (s.length > 2_000_000 ? s : s + chunk.toString('utf8'));
    child.stdout.on('data', (c: Buffer) => { stdout = cap(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = cap(stderr, c); });
    const kill = () => { if (child.exitCode === null) child.kill('SIGKILL'); };
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export const tail = (s: string, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);
