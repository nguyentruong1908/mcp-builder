// Runs the e2e suite against `<dev database>_test`, which it creates if missing and migrates.
// The dev database itself is never touched. Test files empty the tables themselves (helpers.resetDb).
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
try { process.loadEnvFile(new URL('../../.env', import.meta.url)); } catch { /* env may come from the shell */ }
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

const url = new URL(process.env.DATABASE_URL);
const db = `${url.pathname.slice(1)}_test`;
if (!/^[\w-]+$/.test(db)) throw new Error(`Unexpected database name: ${db}`);
url.pathname = `/${db}`;
const testUrl = url.toString();

const maintenance = new URL(testUrl);
maintenance.pathname = '/postgres';
maintenance.search = '';
const admin = new pg.Client({ connectionString: maintenance.toString() });
await admin.connect();
if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount) await admin.query(`CREATE DATABASE "${db}"`);
await admin.end();

const env = { ...process.env, DATABASE_URL: testUrl };
try {
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], { cwd: apiRoot, env, stdio: 'pipe' });
} catch (e) {
  process.stderr.write(`${e.stdout ?? ''}${e.stderr ?? ''}`);
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/e2e/*.test.mjs'], { cwd: apiRoot, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
