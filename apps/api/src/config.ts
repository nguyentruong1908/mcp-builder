import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  dataDir: resolve(apiRoot, process.env.DATA_DIR ?? '../../data'),
  templateDir: resolve(apiRoot, '../../templates/mcp-node'),
  codexModel: process.env.CODEX_MODEL ?? 'gpt-6-sol',
  price: {
    input: num(process.env.CODEX_PRICE_INPUT_PER_MTOK, 1.25),
    cached: num(process.env.CODEX_PRICE_CACHED_PER_MTOK, 0.125),
    output: num(process.env.CODEX_PRICE_OUTPUT_PER_MTOK, 10),
  },
  specFetchAllowlist: (process.env.SPEC_FETCH_ALLOWLIST ?? 'localhost,127.0.0.1').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  workerPollMs: num(process.env.WORKER_POLL_MS, 2000),
  // Public base URL used to build deployed MCP endpoints (the gateway in Docker, the API itself in dev).
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${num(process.env.PORT, 4000)}`).replace(/\/$/, ''),
};

/** Factory-managed Codex home (auth.json lives here, never in the DB). */
export const codexHome = resolve(apiRoot, process.env.CODEX_HOME_DIR ?? `${config.dataDir}/codex-home`);
/** workspace-write (default) or danger-full-access when the container itself is the isolation boundary. */
export const codexSandbox = (process.env.CODEX_SANDBOX === 'danger-full-access' ? 'danger-full-access' : 'workspace-write') as 'workspace-write' | 'danger-full-access';

/**
 * Codex features turned off for every Factory-driven Codex run: plugins, marketplace skills and apps
 * would otherwise be pulled into builds, costing tokens and making output depend on the account's catalog.
 */
export const CODEX_ISOLATION_CONFIG = { features: { plugins: false, remote_plugin: false, plugin_discovery_prefetch: false, apps: false } };

export const DEFAULT_SETTINGS = { maxCostUsdPerBuild: 15, maxRepairRounds: 3, maxQaRepairRounds: 2, monthlyBudgetUsd: 500, buildTimeoutMin: 30 };
