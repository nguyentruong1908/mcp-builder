import { ForbiddenException, Injectable, SetMetadata, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { ProjectPermission, WorkspacePermission } from '@mcp-builder/shared';
import { AccessService, type ResourceKind } from './access.service.js';
import { currentUser } from './context.js';

const PUBLIC = 'auth:public';
const ALLOW_PASSWORD_CHANGE = 'auth:allowPasswordChange';
const PERM = 'auth:perm';

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

type PermMeta = { permission: WorkspacePermission | ProjectPermission | 'member'; resource?: ResourceKind };

/** Workspace permission, or a project permission / membership on the project that owns the record `:id` points at. */
export function Perm(permission: WorkspacePermission): MethodDecorator & ClassDecorator;
export function Perm(permission: ProjectPermission | 'member', resource: ResourceKind): MethodDecorator & ClassDecorator;
export function Perm(permission: PermMeta['permission'], resource?: ResourceKind) {
  return SetMetadata(PERM, { permission, resource } satisfies PermMeta);
}

/** Runs after AuthGuard: routes without @Perm only need the signed-in user AuthGuard already checked. */
@Injectable()
export class PermGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly access: AccessService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<PermMeta | undefined>(PERM, [ctx.getHandler(), ctx.getClass()]);
    if (!meta) return true;
    if (meta.resource) {
      await this.access.assertResource(meta.resource, ctx.switchToHttp().getRequest<Request>().params.id as string, meta.permission as ProjectPermission | 'member');
    } else if (!currentUser()!.permissions.includes(meta.permission as WorkspacePermission)) {
      throw new ForbiddenException(`Requires permission ${meta.permission}`);
    }
    return true;
  }
}
