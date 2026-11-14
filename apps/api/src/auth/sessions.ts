import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { CookieOptions, RequestHandler, Response } from 'express';
import type { WorkspacePermission } from '@mcp-builder/shared';
import { config } from '../config.js';
import { PrismaService } from '../core/prisma.service.js';
import { sha256 } from '../core/util.js';
import type { Role, User } from '../generated/prisma/client.js';
import { requestContext, type RequestUser } from './context.js';

export const SESSION_COOKIE = 'mcpb_session';
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export function toRequestUser(user: User & { role: Role }): RequestUser {
  return {
    id: user.id, username: user.username, displayName: user.displayName, roleId: user.roleId, roleName: user.role.name,
    permissions: user.role.permissions as WorkspacePermission[], mustChangePassword: user.mustChangePassword,
  };
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Returns the raw token for the cookie; only its sha256 is stored. */
  async create(userId: string, userAgent: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await this.prisma.session.create({ data: { id: sha256(token), userId, userAgent: userAgent.slice(0, 300), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    return token;
  }

  async resolve(token: string): Promise<{ user: RequestUser; sessionId: string } | null> {
    const s = await this.prisma.session.findUnique({ where: { id: sha256(token) }, include: { user: { include: { role: true } } } });
    if (!s || s.expiresAt <= new Date() || s.user.disabled) return null;
    return { user: toRequestUser(s.user), sessionId: s.id };
  }

  async revoke(sessionId: string) {
    await this.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  async revokeAllForUser(userId: string, exceptSessionId?: string) {
    await this.prisma.session.deleteMany({ where: { userId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) } });
  }
}

const cookieOptions = (): CookieOptions => ({ httpOnly: true, sameSite: 'lax', path: '/', secure: config.publicUrl.startsWith('https:') });

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: SESSION_TTL_MS });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/** Resolves the session cookie and runs the rest of the request inside requestContext. */
export function authMiddleware(sessions: SessionService): RequestHandler {
  return (req, _res, next) => {
    const token = readCookie(req.headers.cookie, SESSION_COOKIE);
    (token ? sessions.resolve(token) : Promise.resolve(null)).then(
      (r) => requestContext.run({ user: r?.user ?? null, sessionId: r?.sessionId ?? null }, next),
      next,
    );
  };
}
