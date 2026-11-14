import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, client, resetDb } from './helpers.mjs';
import { hashPassword } from '../../dist/auth/password.js';

const PASSWORD = 'test-password-1';
const OWNER_PERMISSIONS = [
  'project.edit', 'spec.edit', 'context.edit', 'tools.edit', 'connections.manage', 'testcases.manage',
  'builds.run', 'qa.run', 'versions.release', 'deploy.manage', 'members.manage', 'artifacts.download',
].sort();
let s, dataDir, admin, dev, outsider, third, P;

before(async () => {
  // Artifact downloads must live under DATA_DIR; config reads it when the app is first imported.
  dataDir = await mkdtemp(join(tmpdir(), 'mcpb-access-'));
  s = await startApp({ DATA_DIR: dataDir });
  await resetDb(s.prisma);
  const passwordHash = await hashPassword(PASSWORD);
  for (const [username, roleId] of [['admin', 'role_admin'], ['dev', 'role_member'], ['outsider', 'role_member'], ['third', 'role_member']]) {
    await s.prisma.user.create({ data: { username, displayName: username, passwordHash, roleId } });
  }
  [admin, dev, outsider, third] = await Promise.all(['admin', 'dev', 'outsider', 'third'].map(async (u) => {
    const c = client(s.base);
    assert.equal((await c.login(u, PASSWORD)).status, 201);
    return c;
  }));
  const created = await dev.post('/api/projects', { name: 'Payroll' });
  assert.equal(created.status, 201);
  P = created.body;
});
after(async () => {
  await s?.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function addMember(username, roleId) {
  const u = await s.prisma.user.findUniqueOrThrow({ where: { username } });
  await s.prisma.projectMember.create({ data: { projectId: P.id, userId: u.id, roleId } });
}

test('the creator becomes Owner, with every project permission', async () => {
  const mine = (await dev.get('/api/projects')).body.find((p) => p.id === P.id);
  assert.ok(mine);
  assert.equal(mine.owner, 'dev');
  assert.deepEqual([...mine.myPermissions].sort(), OWNER_PERMISSIONS);
  const member = await s.prisma.projectMember.findFirst({ where: { projectId: P.id }, include: { user: true } });
  assert.equal(member.user.username, 'dev');
  assert.equal(member.roleId, 'role_owner');
});

test('non-members do not see the project and get the same 404 as a missing one', async () => {
  assert.deepEqual((await outsider.get('/api/projects')).body, []);
  const hidden = await outsider.get(`/api/projects/${P.id}`);
  const missing = await outsider.get('/api/projects/does-not-exist');
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body);
  assert.equal(missing.body.message, 'Project not found');
});

test('a project without members is visible only with projects.all', async () => {
  const legacy = await s.prisma.project.create({ data: { name: 'Legacy', slug: 'legacy' } });
  const seen = (await admin.get('/api/projects')).body.find((p) => p.id === legacy.id);
  assert.ok(seen);
  assert.deepEqual([...seen.myPermissions].sort(), OWNER_PERMISSIONS);
  assert.ok(!(await dev.get('/api/projects')).body.some((p) => p.id === legacy.id));
  assert.equal((await dev.get(`/api/projects/${legacy.id}`)).status, 404);
});

test('the dashboard only counts and shows accessible projects', async () => {
  const d = (await outsider.get('/api/dashboard')).body;
  assert.equal(d.stats.projects, 0);
  assert.deepEqual(d.projects, []);
  assert.ok(!d.activity.some((a) => a.meta?.projectId === P.id || a.target.includes('Payroll')));
  const mine = (await dev.get('/api/dashboard')).body;
  assert.equal(mine.stats.projects, 1);
  assert.ok(mine.activity.some((a) => a.meta?.projectId === P.id));
});

test('the workspace audit log needs audit.read; a project audit log needs membership', async () => {
  const denied = await dev.get('/api/audit');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.message, 'Requires permission audit.read');
  assert.equal((await dev.get(`/api/audit?projectId=${P.id}`)).status, 200);
  assert.equal((await outsider.get(`/api/audit?projectId=${P.id}`)).status, 404);
  const all = await admin.get('/api/audit');
  assert.equal(all.status, 200);
  const created = all.body.find((a) => a.action === 'project.create' && a.meta?.projectId === P.id);
  assert.equal(created.actor, 'dev');
});

test('project updates are audited under the project with the real actor', async () => {
  assert.equal((await dev.patch(`/api/projects/${P.id}`, { description: 'Monthly payroll' })).status, 200);
  const entries = (await admin.get(`/api/audit?projectId=${P.id}`)).body;
  const update = entries.find((a) => a.action === 'project.update');
  assert.ok(update);
  assert.equal(update.actor, 'dev');
});

test('a member without the permission gets 403 Requires permission <key>', async () => {
  await addMember('outsider', 'role_agent_developer');
  const detail = await outsider.get(`/api/projects/${P.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.myPermissions, ['artifacts.download']);
  const ctx = await outsider.put(`/api/projects/${P.id}/context`, {});
  assert.equal(ctx.status, 403);
  assert.equal(ctx.body.message, 'Requires permission context.edit');
  const conn = await outsider.post(`/api/projects/${P.id}/connections`, { name: 'qa', baseUrl: 'http://localhost:9', authType: 'none', secretRef: '' });
  assert.equal(conn.status, 403);
  assert.equal(conn.body.message, 'Requires permission connections.manage');
});

test('child-resource routes resolve to their project', async () => {
  const conn = await dev.post(`/api/projects/${P.id}/connections`, { name: 'qa', baseUrl: 'http://localhost:9', authType: 'none', secretRef: '' });
  assert.equal(conn.status, 201, JSON.stringify(conn.body));
  const forbidden = await outsider.patch(`/api/connections/${conn.body.id}`, { allowWrite: false });
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.message, 'Requires permission connections.manage');
  const hidden = await third.patch(`/api/connections/${conn.body.id}`, { allowWrite: false });
  const missing = await third.patch('/api/connections/does-not-exist', { allowWrite: false });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, missing.body);
});

let build;
test('artifact download needs artifacts.download on the artifact project', async () => {
  const version = await s.prisma.version.create({ data: { projectId: P.id, number: '0.1.0' } });
  build = await s.prisma.build.create({ data: { projectId: P.id, versionId: version.id, status: 'succeeded' } });
  const path = join(dataDir, 'report.txt');
  await writeFile(path, 'qa report');
  const artifact = await s.prisma.artifact.create({ data: { buildId: build.id, kind: 'qa_report', filename: 'report.txt', path, sha256: 'x', size: 9 } });
  const url = `${s.base}/api/artifacts/${artifact.id}/download`;
  const ok = await fetch(url, { headers: { cookie: outsider.cookie } });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'qa report');
  assert.equal((await fetch(url, { headers: { cookie: third.cookie } })).status, 404);
  assert.equal((await fetch(url)).status, 401);
});

test('build events (SSE) need a session and membership', async () => {
  const url = `${s.base}/api/builds/${build.id}/events`;
  const ac = new AbortController();
  const res = await fetch(url, { headers: { cookie: outsider.cookie }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  ac.abort();
  await res.body.cancel().catch(() => {});
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { cookie: third.cookie } })).status, 404);
});

test('deployments are listed for members only, with canManage per user', async () => {
  const conn = await s.prisma.connection.findFirstOrThrow({ where: { projectId: P.id } });
  await s.prisma.deployment.create({
    data: { projectId: P.id, slug: P.slug, buildId: build.id, connectionId: conn.id, desired: 'stopped', status: 'stopped', tokenHash: 'x', tokenHint: 'abcd' },
  });
  const [mine] = (await dev.get('/api/deployments')).body;
  assert.equal(mine.projectId, P.id);
  assert.equal(mine.canManage, true);
  const [theirs] = (await outsider.get('/api/deployments')).body;
  assert.equal(theirs.canManage, false);
  assert.deepEqual((await third.get('/api/deployments')).body, []);
});
