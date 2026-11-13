import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function slugify(s: string): string {
  // Strip diacritics (incl. Vietnamese d-stroke) so non-English names still get readable slugs.
  const base = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'project';
}

/** Parses untrusted input with a zod schema; throws 400 with readable messages. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequestException(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  return r.data;
}

const SECRET_PATTERNS: RegExp[] = [
  /(authorization:\s*bearer\s+)[^\s"']+/gi,
  /(bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
  /(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi,
];

/** Masks secrets in log text. `known` are literal secret values resolved for this build. */
export function redact(text: string, known: string[] = []): string {
  let out = text;
  for (const k of known) if (k && k.length >= 4) out = out.split(k).join('******');
  for (const re of SECRET_PATTERNS) out = out.replace(re, (_m, a: string, b?: string) => `${a}******${typeof b === 'string' ? b : ''}`);
  return out;
}

export function semverBump(v: string, part: 'major' | 'minor' | 'patch'): string {
  const [ma, mi, pa] = v.split('.').map((x) => Number.parseInt(x, 10) || 0);
  if (part === 'major') return `${ma + 1}.0.0`;
  if (part === 'minor') return `${ma}.${mi + 1}.0`;
  return `${ma}.${mi}.${pa + 1}`;
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Resolves `env://VAR` secret references from the API process environment. Never returns the ref itself. */
export function resolveSecret(ref: string): string | undefined {
  const m = /^env:\/\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  return m ? process.env[m[1]] || undefined : undefined;
}
