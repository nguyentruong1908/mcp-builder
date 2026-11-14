import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const N = 32768, R = 8, P = 1, KEYLEN = 64;
// N=2^15 needs 32 MiB, which is Node's default limit exactly; raise it.
const MAXMEM = 64 * 1024 * 1024;

function derive(pw: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  const opts: ScryptOptions = { N: n, r, p, maxmem: MAXMEM };
  return new Promise((res, rej) => scrypt(pw, salt, KEYLEN, opts, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(pw, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  try {
    const [alg, n, r, p, salt, hash] = stored.split('$');
    if (alg !== 'scrypt' || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const key = await derive(pw, Buffer.from(salt, 'base64'), +n, +r, +p);
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}

export function passwordProblem(pw: string, username: string): string | null {
  if (pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw === username) return 'Password must not be the same as the username.';
  return null;
}

/** Checked for unknown usernames so sign-in timing does not reveal which exist. */
export const DUMMY_HASH: string = await hashPassword(randomBytes(8).toString('hex'));
