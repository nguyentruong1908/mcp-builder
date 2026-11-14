import { Logger } from '@nestjs/common';

// Keep test output clean; errors (e.g. unexpected 500s) still print.
Logger.overrideLogger(['error']);

/** Boots the compiled API on a random port. `env` is applied to process.env before boot. */
export async function startApp(env = {}) {
  Object.assign(process.env, env);
  const { createApp } = await import('../../dist/app.js');
  const { PrismaService } = await import('../../dist/core/prisma.service.js');
  const app = await createApp();
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address();
  return { base: `http://127.0.0.1:${port}`, app, prisma: app.get(PrismaService), close: () => app.close() };
}

/** HTTP client that keeps the session cookie and always sends the CSRF header. */
export function client(base) {
  let cookie = '';
  const req = async (method, path, body) => {
    const headers = { 'x-mcpb-request': '1' };
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith('mcpb_session='));
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  return {
    login: (username, password) => req('POST', '/api/auth/login', { username, password }),
    get: (path) => req('GET', path),
    post: (path, body = {}) => req('POST', path, body),
    patch: (path, body = {}) => req('PATCH', path, body),
    put: (path, body = {}) => req('PUT', path, body),
    del: (path) => req('DELETE', path),
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
  };
}

/** Empties every table except the migration-seeded roles. */
export async function resetDb(prisma) {
  const tables = await prisma.$queryRaw`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT IN ('Role', '_prisma_migrations')`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`);
  // Seeded roles have fixed ids `role_*`; roles created by tests get cuids.
  await prisma.$executeRaw`DELETE FROM "Role" WHERE NOT starts_with(id, 'role_')`;
}
