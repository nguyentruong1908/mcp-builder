import { ForbiddenException, Injectable, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { currentUser } from './context.js';

const PUBLIC = 'auth:public';
const ALLOW_PASSWORD_CHANGE = 'auth:allowPasswordChange';

/** Route needs no session. */
export const Public = () => SetMetadata(PUBLIC, true);
/** Route stays reachable while the user must change their password. */
export const AllowPasswordChange = () => SetMetadata(ALLOW_PASSWORD_CHANGE, true);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    // CSRF: a cross-site form cannot set custom headers. Checked before the public bypass so login/setup are covered.
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-mcpb-request'] !== '1') throw new ForbiddenException('Missing X-MCPB-Request header');
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const user = currentUser();
    if (!user) throw new UnauthorizedException();
    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE, targets)) throw new ForbiddenException('password_change_required');
    return true;
  }
}
