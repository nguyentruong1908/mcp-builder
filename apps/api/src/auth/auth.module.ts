import {
  BadRequestException, Body, Controller, ForbiddenException, Get, HttpException, Injectable, Logger, Module, Post, Req, Res,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { MeDto } from '@mcp-builder/shared';
import { AuditService } from '../core/core.services.js';
import { PrismaService } from '../core/prisma.service.js';
import { parse } from '../core/util.js';
import { currentUser, requestContext, type RequestUser } from './context.js';
import { AllowPasswordChange, AuthGuard, Public } from './guards.js';
import { LoginLimiter } from './limiter.js';
import { DUMMY_HASH, hashPassword, passwordProblem, verifyPassword } from './password.js';
import { ADMIN_ROLE_ID } from './permissions.js';
import { clearSessionCookie, SessionService, setSessionCookie, toRequestUser } from './sessions.js';

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, '3–32 characters: a-z, 0-9, dot, underscore, hyphen');
const INVALID_LOGIN = 'Invalid username or password';

const toMe = (u: RequestUser): MeDto => ({
  id: u.id, username: u.username, displayName: u.displayName, role: { id: u.roleId, name: u.roleName }, permissions: u.permissions, mustChangePassword: u.mustChangePassword,
});

/** Creates the first user as Admin, or returns null when a user already exists. The table lock serialises concurrent attempts. */
async function createFirstAdmin(prisma: PrismaService, input: { username: string; displayName: string; password: string }) {
  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`;
    if (await tx.user.count()) return null;
    return tx.user.create({ data: { username: input.username, displayName: input.displayName, passwordHash, roleId: ADMIN_ROLE_ID }, include: { role: true } });
  });
}

@Controller('auth')
class AuthController {
  constructor(
    private readonly prisma: PrismaService, private readonly sessions: SessionService,
    private readonly limiter: LoginLimiter, private readonly audit: AuditService,
  ) {}

  private async signIn(user: RequestUser, req: Request, res: Response): Promise<MeDto> {
    setSessionCookie(res, await this.sessions.create(user.id, req.headers['user-agent'] ?? ''));
    return toMe(user);
  }

  @Public() @Get('setup-status')
  async setupStatus() {
    return { needsSetup: (await this.prisma.user.count()) === 0 };
  }

  @Public() @Post('setup')
  async setup(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    if (await this.prisma.user.count()) throw new ForbiddenException('Setup is already complete');
    const input = parse(z.object({ username: usernameSchema, displayName: z.string().trim().min(1).max(100), password: z.string().max(200) }), body);
    const problem = passwordProblem(input.password, input.username);
    if (problem) throw new BadRequestException(problem);
    const user = await createFirstAdmin(this.prisma, input);
    if (!user) throw new ForbiddenException('Setup is already complete');
    await this.audit.log('user.create', user.username, { via: 'setup' }, user.username);
    return this.signIn(toRequestUser(user), req, res);
  }

  @Public() @Post('login')
  async login(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<MeDto> {
    const input = parse(z.object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(200) }), body);
    const key = `${req.ip}|${input.username}`;
    if (this.limiter.blocked(key)) throw new HttpException('Too many failed sign-in attempts. Try again in 15 minutes.', 429);
    // Counted before verifying so parallel attempts cannot all pass the check; reset on success.
    this.limiter.fail(key);
    const user = await this.prisma.user.findUnique({ where: { username: input.username }, include: { role: true } });
    // Unknown users are checked against a dummy hash so timing does not reveal which usernames exist.
    const ok = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      await this.audit.log('auth.login_failed', input.username);
      throw new HttpException(INVALID_LOGIN, 401);
    }
    this.limiter.reset(key);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log('auth.login', user.username, undefined, user.username);
    return this.signIn(toRequestUser(user), req, res);
  }

  @AllowPasswordChange() @Post('logout')
  async logout(@Res({ passthrough: true }) res: Response) {
    const sessionId = requestContext.getStore()?.sessionId;
    if (sessionId) await this.sessions.revoke(sessionId);
    clearSessionCookie(res);
    await this.audit.log('auth.logout', currentUser()!.username);
    return { ok: true };
  }

  @AllowPasswordChange() @Get('me')
  me(): MeDto {
    return toMe(currentUser()!);
  }

  @AllowPasswordChange() @Post('password')
  async changePassword(@Body() body: unknown): Promise<MeDto> {
    const input = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), body);
    const me = currentUser()!;
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    if (!(await verifyPassword(input.current, user.passwordHash))) throw new BadRequestException('Current password is incorrect');
    const problem = passwordProblem(input.next, user.username);
    if (problem) throw new BadRequestException(problem);
    const updated = await this.prisma.user.update({
      where: { id: user.id }, data: { passwordHash: await hashPassword(input.next), mustChangePassword: false }, include: { role: true },
    });
    await this.sessions.revokeAllForUser(user.id, requestContext.getStore()?.sessionId ?? undefined);
    return toMe(toRequestUser(updated));
  }
}

/** Creates the first admin from ADMIN_USERNAME / ADMIN_PASSWORD when the users table is empty. */
@Injectable()
export class AuthBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('Auth');

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap() {
    const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
    if (!ADMIN_USERNAME || !ADMIN_PASSWORD || (await this.prisma.user.count())) return;
    const username = usernameSchema.safeParse(ADMIN_USERNAME);
    const problem = username.success ? passwordProblem(ADMIN_PASSWORD, username.data) : 'ADMIN_USERNAME is not a valid username.';
    if (problem) return this.logger.error(`First admin not created: ${problem}`);
    const user = await createFirstAdmin(this.prisma, { username: username.data!, displayName: 'Admin', password: ADMIN_PASSWORD });
    if (user) this.logger.log(`Created first admin user "${user.username}" from ADMIN_USERNAME`);
  }
}

@Module({
  controllers: [AuthController],
  providers: [SessionService, LoginLimiter, AuthBootstrap, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [SessionService],
})
export class AuthModule {}
