import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, passwordProblem, generatePassword } from '../dist/auth/password.js';
import { effectiveProjectPermissions, isPermissionOfScope, canGrant } from '../dist/auth/permissions.js';

test('hash round-trips', async () => {
  const h = await hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$32768$8$1$'));
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong horse', h), false);
});

test('verify rejects tampered or malformed hashes', async () => {
  const h = await hashPassword('correct horse');
  const i = h.lastIndexOf('$') + 1;
  const tampered = h.slice(0, i) + (h[i] === 'A' ? 'B' : 'A') + h.slice(i + 1);
  assert.equal(await verifyPassword('correct horse', tampered), false);
  assert.equal(await verifyPassword('correct horse', 'nope'), false);
});

test('password rules', () => {
  assert.match(passwordProblem('short', 'bob'), /10/);
  assert.match(passwordProblem('alice12345', 'alice12345'), /username/);
  assert.equal(passwordProblem('a-long-password', 'bob'), null);
});

test('generatePassword', () => {
  const a = generatePassword();
  assert.equal(a.length, 16);
  assert.notEqual(a, generatePassword());
});

test('effective permissions', () => {
  assert.equal(effectiveProjectPermissions(['projects.create'], null), null);
  assert.equal(effectiveProjectPermissions(['projects.all'], null).length, 12);
  assert.deepEqual(effectiveProjectPermissions([], ['context.edit']), ['context.edit']);
});

test('scope check', () => {
  assert.equal(isPermissionOfScope('users.manage', 'workspace'), true);
  assert.equal(isPermissionOfScope('users.manage', 'project'), false);
  assert.equal(isPermissionOfScope('nope', 'project'), false);
});

test('canGrant', () => {
  assert.equal(canGrant(['a', 'b'], ['a']), true);
  assert.equal(canGrant(['a'], ['a', 'b']), false);
});
