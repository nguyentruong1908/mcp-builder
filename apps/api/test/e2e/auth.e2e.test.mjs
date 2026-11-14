import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp, client, resetDb } from './helpers.mjs';
import { hashPassword } from '../../dist/auth/password.js';

const ADMIN = { ADMIN_USERNAME: 'root', ADMIN_PASSWORD: 'root-password-1' };
const INVALID = 'Invalid username or password';
const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
let s;

before(async () => {
  // Boot once to empty the database, then again so the admin bootstrap runs on an empty users table.
  const first = await startApp();
  await resetDb(first.prisma);
  await first.close();
  s = await startApp(ADMIN);
});
after(() => s?.close());

async function makeUser(username, password, extra = {}) {
  await s.prisma.user.create({ data: { username, displayName: username, passwordHash: await hashPassword(password), roleId: 'role_member', ...extra } });
}

function resetPassword(username) {
  return spawnSync(process.execPath, ['dist/cli/reset-password.js', username], { cwd: apiRoot, encoding: 'utf8' });
}

test('requests without a session get 401', async () => {
  assert.equal((await client(s.base).get('/api/projects')).status, 401);
});

test('non-GET requests without X-MCPB-Request get 403, public routes included', async () => {
  const r = await fetch(`${s.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'root', password: ADMIN.ADMIN_PASSWORD }) });
  assert.equal(r.status, 403);
  assert.equal(r.headers.get('set-cookie'), null);
});

test('admin from env exists, so setup is refused', async () => {
  const c = client(s.base);
  assert.deepEqual((await c.get('/api/auth/setup-status')).body, { needsSetup: false });
  assert.equal((await c.post('/api/auth/setup', { username: 'other', displayName: 'Other', password: 'other-password-1' })).status, 403);
});

test('failed sign-in gives the same 401 message for wrong password and unknown user', async () => {
  const c = client(s.base);
  const wrong = await c.login('root', 'not-the-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.message, INVALID);
  const unknown = await c.login('nobody', 'whatever-password');
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.message, INVALID);
  const failed = await s.prisma.auditLog.findFirst({ where: { action: 'auth.login_failed', target: 'root' } });
  assert.ok(failed);
  assert.ok(!JSON.stringify(failed).includes('not-the-password'));
});

test('sign-in sets the session cookie and returns the user', async () => {
  const c = client(s.base);
  const r = await c.login('root', ADMIN.ADMIN_PASSWORD);
  assert.equal(r.status, 201);
  assert.equal(r.body.username, 'root');
  assert.equal(r.body.role.id, 'role_admin');
  assert.ok(r.body.permissions.includes('users.manage'));
  assert.equal(r.body.mustChangePassword, false);
  const set = r.headers.get('set-cookie');
  assert.match(set, /^mcpb_session=[\w-]{43};/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /Secure/);
  assert.equal((await c.get('/api/auth/me')).body.username, 'root');
  assert.equal((await c.get('/api/projects')).status, 200);
  const session = await s.prisma.session.findFirst();
  assert.notEqual(session.id, c.cookie.split('=')[1]);
  assert.ok((await s.prisma.user.findUnique({ where: { username: 'root' } })).lastLoginAt);
});

test('mutations record the signed-in user as audit actor', async () => {
  const c = client(s.base);
  await c.login('root', ADMIN.ADMIN_PASSWORD);
  assert.equal((await c.post('/api/projects', { name: 'Audit actor check' })).status, 201);
  const entry = await s.prisma.auditLog.findFirst({ where: { action: 'project.create', target: 'Audit actor check' } });
  assert.equal(entry.actor, 'root');
  assert.ok(await s.prisma.auditLog.findFirst({ where: { action: 'auth.login', actor: 'root' } }));
});

test('signed-in POST without X-MCPB-Request gets 403', async () => {
  const c = client(s.base);
  await c.login('root', ADMIN.ADMIN_PASSWORD);
  const r = await fetch(`${s.base}/api/projects`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No header' }) });
  assert.equal(r.status, 403);
});

test('the 11th failed attempt for the same username gets 429', async () => {
  const c = client(s.base);
  for (let i = 0; i < 10; i++) assert.equal((await c.login('ghost', 'wrong-password')).status, 401);
  assert.equal((await c.login('ghost', 'wrong-password')).status, 429);
  assert.equal((await c.login('root', ADMIN.ADMIN_PASSWORD)).status, 201);
});

test('the limiter keys on the forwarded client IP behind a local proxy', async () => {
  const attempt = (ip) => fetch(`${s.base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-mcpb-request': '1', 'x-forwarded-for': ip },
    body: JSON.stringify({ username: 'ghost2', password: 'wrong-password' }),
  }).then((r) => r.status);
  for (let i = 0; i < 10; i++) assert.equal(await attempt('203.0.113.1'), 401);
  assert.equal(await attempt('203.0.113.1'), 429);
  assert.equal(await attempt('203.0.113.2'), 401);
});

test('mustChangePassword locks everything except me, password and logout', async () => {
  await makeUser('carol', 'carol-temp-pass', { mustChangePassword: true });
  const c = client(s.base);
  assert.equal((await c.login('carol', 'carol-temp-pass')).body.mustChangePassword, true);
  const blocked = await c.get('/api/projects');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.message, 'password_change_required');
  assert.equal((await c.get('/api/auth/me')).status, 200);
  assert.equal((await c.post('/api/auth/password', { current: 'wrong-current', next: 'carol-new-pass-1' })).status, 400);
  assert.equal((await c.post('/api/auth/password', { current: 'carol-temp-pass', next: 'short' })).status, 400);
  const changed = await c.post('/api/auth/password', { current: 'carol-temp-pass', next: 'carol-new-pass-1' });
  assert.equal(changed.status, 201);
  assert.equal(changed.body.mustChangePassword, false);
  assert.equal((await c.get('/api/projects')).status, 200);
  assert.equal((await client(s.base).login('carol', 'carol-new-pass-1')).status, 201);
});

test('disabling a user ends their session and refuses sign-in', async () => {
  await makeUser('dana', 'dana-password-1');
  const c = client(s.base);
  await c.login('dana', 'dana-password-1');
  assert.equal((await c.get('/api/projects')).status, 200);
  await s.prisma.user.update({ where: { username: 'dana' }, data: { disabled: true } });
  assert.equal((await c.get('/api/projects')).status, 401);
  const r = await c.login('dana', 'dana-password-1');
  assert.equal(r.status, 401);
  assert.equal(r.body.message, INVALID);
});

test('changing the password revokes the other sessions of the user', async () => {
  await makeUser('eve', 'eve-password-1');
  const a = client(s.base), b = client(s.base);
  await a.login('eve', 'eve-password-1');
  await b.login('eve', 'eve-password-1');
  assert.equal((await b.post('/api/auth/password', { current: 'eve-password-1', next: 'eve-password-2' })).status, 201);
  assert.equal((await a.get('/api/auth/me')).status, 401);
  assert.equal((await b.get('/api/auth/me')).status, 200);
});

test('logout deletes the session', async () => {
  const c = client(s.base);
  await c.login('root', ADMIN.ADMIN_PASSWORD);
  const saved = c.cookie;
  assert.ok((await c.post('/api/auth/logout')).status < 300);
  assert.equal((await c.get('/api/auth/me')).status, 401);
  c.cookie = saved;
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('reset-password command issues a temporary password and re-enables the user', async () => {
  const r = resetPassword('dana');
  assert.equal(r.status, 0, r.stderr);
  const password = /: (\S+)\s*$/.exec(r.stdout)[1];
  const login = await client(s.base).login('dana', password);
  assert.equal(login.status, 201);
  assert.equal(login.body.mustChangePassword, true);
  const unknown = resetPassword('nobody');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /nobody/);
});

test('first-run setup works only while there are no users', async () => {
  await resetDb(s.prisma);
  await s.close();
  delete process.env.ADMIN_USERNAME;
  delete process.env.ADMIN_PASSWORD;
  s = await startApp();
  const c = client(s.base);
  assert.deepEqual((await c.get('/api/auth/setup-status')).body, { needsSetup: true });
  const r = await c.post('/api/auth/setup', { username: 'First', displayName: 'First Admin', password: 'first-password-1' });
  assert.equal(r.status, 201);
  assert.equal(r.body.username, 'first');
  assert.equal(r.body.role.id, 'role_admin');
  assert.equal((await c.get('/api/auth/me')).body.username, 'first');
  assert.equal((await c.post('/api/auth/setup', { username: 'second', displayName: 'Second', password: 'second-password-1' })).status, 403);
  assert.deepEqual((await c.get('/api/auth/setup-status')).body, { needsSetup: false });
});
