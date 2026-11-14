import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, resetDb } from './helpers.mjs';
import { hashPassword } from '../../dist/auth/password.js';

const PASSWORD = 'test-password-1';
const ok = (r) => assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status} ${JSON.stringify(r.body)}`);
let s, root, dev, agent, P, carolPassword, userManagerRole;

before(async () => {
  s = await startApp();
  await resetDb(s.prisma);
  const passwordHash = await hashPassword(PASSWORD);
  for (const [username, roleId] of [['root', 'role_admin'], ['dev', 'role_member'], ['agent', 'role_member']]) {
    await s.prisma.user.create({ data: { username, displayName: username, passwordHash, roleId } });
  }
  [root, dev, agent] = await Promise.all(['root', 'dev', 'agent'].map(async (u) => {
    const c = client(s.base);
    assert.equal((await c.login(u, PASSWORD)).status, 201);
    return c;
  }));
  const created = await dev.post('/api/projects', { name: 'Payroll' });
  assert.equal(created.status, 201);
  P = created.body;
  const agentUser = await s.prisma.user.findUniqueOrThrow({ where: { username: 'agent' } });
  await s.prisma.projectMember.create({ data: { projectId: P.id, userId: agentUser.id, roleId: 'role_agent_developer' } });
});
after(async () => { await s?.close(); });

const userId = async (username) => (await s.prisma.user.findUniqueOrThrow({ where: { username } })).id;

/** Creates a user with a typed password as `actor`, signs in and clears the forced password change. */
async function newUser(actor, username, roleId) {
  ok(await actor.post('/api/users', { username, displayName: username, roleId, password: 'initial-password' }));
  const c = client(s.base);
  assert.equal((await c.login(username, 'initial-password')).status, 201);
  ok(await c.post('/api/auth/password', { current: 'initial-password', next: PASSWORD }));
  return c;
}

test('admin creates a user with a generated temporary password; hashes never leak', async () => {
  const r = await root.post('/api/users', { username: 'carol', displayName: 'Carol', roleId: 'role_member' });
  ok(r);
  assert.equal(r.body.temporaryPassword.length, 16);
  assert.equal(r.body.user.username, 'carol');
  assert.deepEqual(r.body.user.role, { id: 'role_member', name: 'Member' });
  const carol = client(s.base);
  const login = await carol.login('carol', r.body.temporaryPassword);
  assert.equal(login.status, 201);
  assert.equal(login.body.mustChangePassword, true);
  carolPassword = 'carol-password-1';
  ok(await carol.post('/api/auth/password', { current: r.body.temporaryPassword, next: carolPassword }));
  const list = await root.get('/api/users');
  assert.equal(list.status, 200);
  assert.ok(list.body.some((u) => u.username === 'carol'));
  assert.ok(!JSON.stringify(list.body).includes('passwordHash'));
  const audit = await s.prisma.auditLog.findFirst({ where: { action: 'user.create', target: 'carol' } });
  assert.equal(audit.actor, 'root');
  assert.ok(!JSON.stringify(audit).includes(r.body.temporaryPassword));
});

test('username and password rules', async () => {
  assert.equal((await root.post('/api/users', { username: 'carol', displayName: 'Again', roleId: 'role_member' })).status, 409);
  assert.equal((await root.post('/api/users', { username: 'Bad Name', displayName: 'x', roleId: 'role_member' })).status, 400);
  assert.equal((await root.post('/api/users', { username: 'shorty', displayName: 'x', roleId: 'role_member', password: 'short' })).status, 400);
  assert.equal((await root.post('/api/users', { username: 'scoped', displayName: 'x', roleId: 'role_owner' })).status, 400);
  assert.equal((await dev.post('/api/users', { username: 'nope', displayName: 'x', roleId: 'role_member' })).status, 403);
});

test('a user manager cannot hand out more than they hold or change their own role', async () => {
  // projects.create is included so the manager may grant Member (no escalation: Member only has projects.create).
  const role = await root.post('/api/roles', { name: 'UserManager', scope: 'workspace', permissions: ['users.manage', 'projects.create'] });
  ok(role);
  userManagerRole = role.body;
  const uma = await newUser(root, 'uma', userManagerRole.id);
  const carolId = await userId('carol');
  const umaId = await userId('uma');
  const grant = await uma.patch(`/api/users/${carolId}`, { roleId: 'role_admin' });
  assert.equal(grant.status, 403);
  assert.equal((await uma.post('/api/users', { username: 'boss', displayName: 'x', roleId: 'role_admin' })).status, 403);
  assert.equal((await uma.patch(`/api/users/${umaId}`, { roleId: 'role_member' })).status, 403);
  assert.equal((await uma.patch(`/api/users/${umaId}`, { disabled: true })).status, 403);
  ok(await uma.post('/api/users', { username: 'mel', displayName: 'Mel', roleId: 'role_member' }));
  // Resetting an admin's password would hand the manager the admin account.
  assert.equal((await uma.post(`/api/users/${await userId('root')}/reset-password`)).status, 403);
});

test('a role manager cannot add permissions they do not hold', async () => {
  const uma = client(s.base);
  ok(await root.patch(`/api/roles/${userManagerRole.id}`, { permissions: ['users.manage', 'projects.create', 'roles.manage'] }));
  assert.equal((await uma.login('uma', PASSWORD)).status, 201);
  assert.equal((await uma.patch('/api/roles/role_member', { permissions: ['projects.create', 'projects.all'] })).status, 403);
  assert.equal((await uma.post('/api/roles', { name: 'Everything', scope: 'workspace', permissions: ['projects.all'] })).status, 403);
  assert.equal((await uma.post('/api/roles', { name: 'Proj', scope: 'project', permissions: ['qa.run'] })).status, 403);
  assert.equal((await uma.patch(`/api/roles/${userManagerRole.id}`, { permissions: ['users.manage', 'projects.create', 'roles.manage', 'projects.all'] })).status, 403);
  assert.equal((await uma.patch(`/api/roles/${userManagerRole.id}`, { description: 'mine' })).status, 403);
  ok(await root.patch(`/api/roles/${userManagerRole.id}`, { permissions: ['users.manage', 'projects.create'] }));
});

test('the last admin cannot be disabled', async () => {
  const rootId = await userId('root');
  assert.equal((await root.patch(`/api/users/${rootId}`, { disabled: true })).status, 403);
  const admin2 = await newUser(root, 'admin2', 'role_admin');
  const off = await admin2.patch(`/api/users/${rootId}`, { disabled: true });
  ok(off);
  assert.equal(off.body.disabled, true);
  assert.equal((await root.get('/api/auth/me')).status, 401);
  const uma = client(s.base);
  assert.equal((await uma.login('uma', PASSWORD)).status, 201);
  const last = await uma.patch(`/api/users/${await userId('admin2')}`, { disabled: true });
  assert.equal(last.status, 409);
  assert.equal((await uma.patch(`/api/users/${await userId('admin2')}`, { roleId: 'role_member' })).status, 409);
  ok(await admin2.patch(`/api/users/${rootId}`, { disabled: false }));
  assert.equal((await root.login('root', PASSWORD)).status, 201);
  const actions = (await s.prisma.auditLog.findMany({ where: { target: 'root' } })).map((a) => a.action);
  assert.ok(actions.includes('user.disable') && actions.includes('user.enable'));
});

test('system roles, roles in use and role scopes', async () => {
  assert.equal((await root.patch('/api/roles/role_admin', { name: 'Boss' })).status, 409);
  assert.equal((await root.del('/api/roles/role_owner')).status, 409);
  ok(await root.post(`/api/projects/${P.id}/members`, { userId: await userId('mel'), roleId: 'role_developer' }));
  const roles = (await root.get('/api/roles')).body;
  assert.equal(roles.find((r) => r.id === 'role_developer').usage, 1);
  const inUse = await root.del('/api/roles/role_developer');
  assert.equal(inUse.status, 409);
  assert.match(inUse.body.message, /\b1\b/);
  const created = await root.post('/api/roles', { name: 'Tester', scope: 'project', description: 'QA only', permissions: ['qa.run'] });
  ok(created);
  assert.equal(created.body.usage, 0);
  const edited = await root.patch(`/api/roles/${created.body.id}`, { permissions: ['qa.run', 'testcases.manage'] });
  ok(edited);
  assert.deepEqual(edited.body.permissions, ['qa.run', 'testcases.manage']);
  ok(await root.del(`/api/roles/${created.body.id}`));
  assert.equal((await root.post('/api/roles', { name: 'Wrong', scope: 'project', permissions: ['users.manage'] })).status, 400);
  assert.equal((await root.post('/api/roles', { name: 'Member', scope: 'workspace', permissions: [] })).status, 409);
  const perms = await dev.get('/api/permissions');
  assert.equal(perms.status, 200);
  assert.ok(perms.body.some((p) => p.key === 'members.manage' && p.scope === 'project'));
  assert.equal((await dev.get('/api/roles')).status, 200);
  const actions = (await s.prisma.auditLog.findMany({ where: { target: 'Tester' } })).map((a) => a.action).sort();
  assert.deepEqual(actions, ['role.create', 'role.delete', 'role.update']);
});

test('project members', async () => {
  const carol = client(s.base);
  assert.equal((await carol.login('carol', carolPassword)).status, 201);
  const carolId = await userId('carol');
  assert.equal((await carol.get(`/api/projects/${P.id}/members`)).status, 404);
  ok(await dev.post(`/api/projects/${P.id}/members`, { userId: carolId, roleId: 'role_reviewer' }));
  assert.equal((await carol.get(`/api/projects/${P.id}`)).status, 200);
  const members = (await carol.get(`/api/projects/${P.id}/members`)).body;
  assert.deepEqual(members.find((m) => m.username === 'carol').role, { id: 'role_reviewer', name: 'Reviewer' });
  assert.equal((await carol.post(`/api/projects/${P.id}/members`, { userId: await userId('uma'), roleId: 'role_reviewer' })).status, 403);
  assert.equal((await dev.post(`/api/projects/${P.id}/members`, { userId: carolId, roleId: 'role_reviewer' })).status, 409);
  assert.equal((await dev.post(`/api/projects/${P.id}/members`, { userId: await userId('uma'), roleId: 'role_member' })).status, 400);
  ok(await dev.patch(`/api/projects/${P.id}/members/${carolId}`, { roleId: 'role_owner' }));
  assert.equal((await carol.patch(`/api/projects/${P.id}/members/${carolId}`, { roleId: 'role_reviewer' })).status, 403);
  ok(await dev.del(`/api/projects/${P.id}/members/${carolId}`));
  assert.equal((await carol.get(`/api/projects/${P.id}`)).status, 404);
  const audit = await s.prisma.auditLog.findMany({ where: { action: { startsWith: 'member.' }, target: 'carol' } });
  assert.deepEqual(audit.map((a) => a.action).sort(), ['member.add', 'member.remove', 'member.update']);
  assert.ok(audit.every((a) => a.meta.projectId === P.id));
});

test('a member manager cannot hand out project permissions they do not hold', async () => {
  const lead = await root.post('/api/roles', { name: 'Lead', scope: 'project', permissions: ['members.manage'] });
  ok(lead);
  ok(await dev.post(`/api/projects/${P.id}/members`, { userId: await userId('uma'), roleId: lead.body.id }));
  const uma = client(s.base);
  assert.equal((await uma.login('uma', PASSWORD)).status, 201);
  assert.equal((await uma.post(`/api/projects/${P.id}/members`, { userId: await userId('carol'), roleId: 'role_owner' })).status, 403);
  assert.equal((await uma.patch(`/api/projects/${P.id}/members/${await userId('mel')}`, { roleId: 'role_owner' })).status, 403);
});

test('reset password revokes sessions and issues a working temporary password', async () => {
  const carol = client(s.base);
  assert.equal((await carol.login('carol', carolPassword)).status, 201);
  const r = await root.post(`/api/users/${await userId('carol')}/reset-password`);
  ok(r);
  assert.equal(r.body.temporaryPassword.length, 16);
  assert.equal((await carol.get('/api/auth/me')).status, 401);
  const again = await carol.login('carol', r.body.temporaryPassword);
  assert.equal(again.status, 201);
  assert.equal(again.body.mustChangePassword, true);
  const typed = await root.post(`/api/users/${await userId('carol')}/reset-password`, { password: 'typed-password-1' });
  ok(typed);
  assert.equal(typed.body.temporaryPassword, null);
  assert.equal((await root.post(`/api/users/${await userId('carol')}/reset-password`, { password: 'carol' })).status, 400);
  assert.ok(await s.prisma.auditLog.findFirst({ where: { action: 'user.reset_password', target: 'carol' } }));
});

test('user lookup for the member picker', async () => {
  const r = await dev.get('/api/users/lookup?q=car');
  assert.equal(r.status, 200);
  const carol = r.body.find((u) => u.username === 'carol');
  assert.deepEqual(Object.keys(carol).sort(), ['displayName', 'id', 'username']);
  assert.equal((await agent.get('/api/users/lookup?q=car')).status, 403);
  assert.equal((await dev.get('/api/users')).status, 403);
});
