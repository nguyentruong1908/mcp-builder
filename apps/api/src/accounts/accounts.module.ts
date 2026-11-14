import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, Module, NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { z } from 'zod';
import type { PermissionInfo, ProjectMemberDto, RoleDto, RoleScope, UserCreateResult, UserDto, UserLookupDto } from '@mcp-builder/shared';
import { AccessService } from '../auth/access.service.js';
import { usernameSchema } from '../auth/auth.module.js';
import { currentUser, type RequestUser } from '../auth/context.js';
import { Perm } from '../auth/guards.js';
import { generatePassword, hashPassword, passwordProblem } from '../auth/password.js';
import { canGrant, isPermissionOfScope, PERMISSION_INFO } from '../auth/permissions.js';
import { SessionService } from '../auth/sessions.js';
import { AuditService } from '../core/core.services.js';
import { PrismaService } from '../core/prisma.service.js';
import { iso, parse } from '../core/util.js';
import type { Prisma, Role, User } from '../generated/prisma/client.js';

const displayName = z.string().trim().min(1).max(100);
const password = z.string().max(200);
const roleFields = {
  name: z.string().trim().min(1).max(50),
  description: z.string().trim().max(300),
  permissions: z.array(z.string()).max(50).transform((p) => [...new Set(p)]),
};

const toUserDto = (u: User & { role: Role }): UserDto => ({
  id: u.id, username: u.username, displayName: u.displayName, role: { id: u.role.id, name: u.role.name },
  disabled: u.disabled, mustChangePassword: u.mustChangePassword, lastLoginAt: iso(u.lastLoginAt), createdAt: u.createdAt.toISOString(),
});
const roleInclude = { _count: { select: { users: true, members: true } } } as const;
const toRoleDto = (r: Role & { _count: { users: number; members: number } }): RoleDto => ({
  id: r.id, name: r.name, scope: r.scope as RoleScope, description: r.description, permissions: r.permissions, system: r.system,
  usage: r._count.users + r._count.members,
});

/** Runs `change` and refuses (409, rolled back) if no enabled user is left whose role has users.manage and roles.manage. */
async function keepingAnAdmin<T>(prisma: PrismaService, change: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Serialises concurrent changes so two admins cannot disable each other at once.
    await tx.$executeRaw`LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`;
    const result = await change(tx);
    const admins = await tx.user.count({ where: { disabled: false, role: { permissions: { hasEvery: ['users.manage', 'roles.manage'] } } } });
    if (!admins) throw new ConflictException('At least one enabled user must keep a role with users.manage and roles.manage');
    return result;
  });
}

async function roleOfScope(prisma: PrismaService, id: string, scope: RoleScope): Promise<Role> {
  const role = await prisma.role.findUnique({ where: { id } });
  if (role?.scope !== scope) throw new BadRequestException(`roleId: not a ${scope} role`);
  return role;
}

/** Acting on a user's role, disabled flag or password needs every permission of the user's current role. */
function assertCanActOn(actor: readonly string[], target: User & { role: Role }) {
  if (!canGrant(actor, target.role.permissions)) throw new ForbiddenException(`You cannot change user "${target.username}": their role has permissions you do not hold`);
}

/** Maps a unique-constraint race (Prisma P2002) to the same 409 the caller would otherwise report. */
const conflictOnDuplicate = (message: string) => (e: unknown): never => {
  if ((e as { code?: string }).code === 'P2002') throw new ConflictException(message);
  throw e;
};

function assertCanGrant(actor: readonly string[], role: Pick<Role, 'name' | 'permissions'>) {
  if (!canGrant(actor, role.permissions)) throw new ForbiddenException(`You cannot grant role "${role.name}": it has permissions you do not hold`);
}

@Controller('users')
class UsersController {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService,
    private readonly sessions: SessionService, private readonly access: AccessService,
  ) {}

  @Perm('users.manage') @Get()
  async list(): Promise<UserDto[]> {
    return (await this.prisma.user.findMany({ include: { role: true }, orderBy: { username: 'asc' } })).map(toUserDto);
  }

  @Get('lookup')
  async lookup(@Query('q') q = ''): Promise<UserLookupDto[]> {
    const me = currentUser()!;
    if (!me.permissions.includes('users.manage') && !(await this.access.hasAnyProjectPermission(me, 'members.manage'))) {
      throw new ForbiddenException('Requires permission users.manage');
    }
    const term = String(q).trim().slice(0, 100);
    const match = { contains: term, mode: 'insensitive' } as const;
    return this.prisma.user.findMany({
      where: { disabled: false, ...(term ? { OR: [{ username: match }, { displayName: match }] } : {}) },
      select: { id: true, username: true, displayName: true }, orderBy: { username: 'asc' }, take: 20,
    });
  }

  @Perm('users.manage') @Post()
  async create(@Body() body: unknown): Promise<UserCreateResult> {
    const input = parse(z.object({ username: usernameSchema, displayName, roleId: z.string(), password: password.optional() }).strict(), body);
    const role = await roleOfScope(this.prisma, input.roleId, 'workspace');
    assertCanGrant(currentUser()!.permissions, role);
    const temporaryPassword = input.password === undefined ? generatePassword() : null;
    const pw = input.password ?? temporaryPassword!;
    const problem = passwordProblem(pw, input.username);
    if (problem) throw new BadRequestException(problem);
    const user = await this.prisma.user.create({
      data: { username: input.username, displayName: input.displayName, roleId: role.id, passwordHash: await hashPassword(pw), mustChangePassword: true },
      include: { role: true },
    }).catch(conflictOnDuplicate(`Username "${input.username}" is already taken`));
    await this.audit.log('user.create', user.username, { role: role.name });
    return { user: toUserDto(user), temporaryPassword };
  }

  @Perm('users.manage') @Patch(':id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<UserDto> {
    const input = parse(z.object({ displayName, roleId: z.string(), disabled: z.boolean() }).partial().strict(), body);
    const me = currentUser()!;
    const cur = await this.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!cur) throw new NotFoundException('User not found');
    const roleChanged = input.roleId !== undefined && input.roleId !== cur.roleId;
    const disabledChanged = input.disabled !== undefined && input.disabled !== cur.disabled;
    if (id === me.id && (roleChanged || disabledChanged)) throw new ForbiddenException('You cannot change your own role or disable yourself');
    if (roleChanged || disabledChanged) assertCanActOn(me.permissions, cur);
    if (roleChanged) assertCanGrant(me.permissions, await roleOfScope(this.prisma, input.roleId!, 'workspace'));
    const user = await keepingAnAdmin(this.prisma, (tx) => tx.user.update({ where: { id }, data: input, include: { role: true } }));
    if (input.disabled) await this.sessions.revokeAllForUser(id);
    if (disabledChanged) await this.audit.log(input.disabled ? 'user.disable' : 'user.enable', user.username);
    const fields = Object.keys(input).filter((k) => k !== 'disabled');
    if (fields.length) await this.audit.log('user.update', user.username, { fields, role: user.role.name });
    return toUserDto(user);
  }

  @Perm('users.manage') @Post(':id/reset-password')
  async resetPassword(@Param('id') id: string, @Body() body: unknown): Promise<{ temporaryPassword: string | null }> {
    const input = parse(z.object({ password: password.optional() }).strict(), body);
    const target = await this.prisma.user.findUnique({ where: { id }, include: { role: true } });
    if (!target) throw new NotFoundException('User not found');
    // Knowing the new password means owning the account.
    assertCanActOn(currentUser()!.permissions, target);
    const temporaryPassword = input.password === undefined ? generatePassword() : null;
    const pw = input.password ?? temporaryPassword!;
    const problem = passwordProblem(pw, target.username);
    if (problem) throw new BadRequestException(problem);
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(pw), mustChangePassword: true } });
    await this.sessions.revokeAllForUser(id);
    await this.audit.log('user.reset_password', target.username);
    return { temporaryPassword };
  }
}

@Controller()
class RolesController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get('permissions')
  permissions(): PermissionInfo[] {
    return PERMISSION_INFO;
  }

  @Get('roles')
  async list(): Promise<RoleDto[]> {
    return (await this.prisma.role.findMany({ include: roleInclude, orderBy: [{ scope: 'desc' }, { createdAt: 'asc' }] })).map(toRoleDto);
  }

  /** Permissions must match the scope (400); workspace roles only with permissions the actor holds, project roles only with projects.all (403). */
  private checkPermissions(me: RequestUser, scope: RoleScope, permissions: string[]) {
    const wrong = permissions.filter((p) => !isPermissionOfScope(p, scope));
    if (wrong.length) throw new BadRequestException(`permissions: not ${scope} permissions: ${wrong.join(', ')}`);
    if (scope === 'project' && !me.permissions.includes('projects.all')) throw new ForbiddenException('Requires permission projects.all');
    if (scope === 'workspace' && !canGrant(me.permissions, permissions)) throw new ForbiddenException('A role may only include permissions you hold');
  }

  /** System roles are fixed (409); the actor may not edit or delete a role they are assigned to (403). */
  private async editable(me: RequestUser, id: string): Promise<Role> {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.system) throw new ConflictException('System roles cannot be changed or deleted');
    if (me.roleId === id || (await this.prisma.projectMember.count({ where: { userId: me.id, roleId: id } }))) {
      throw new ForbiddenException('You cannot change a role you are assigned to');
    }
    return role;
  }

  @Perm('roles.manage') @Post('roles')
  async create(@Body() body: unknown): Promise<RoleDto> {
    const input = parse(z.object({ ...roleFields, description: roleFields.description.default(''), scope: z.enum(['workspace', 'project']) }).strict(), body);
    this.checkPermissions(currentUser()!, input.scope, input.permissions);
    const role = await this.prisma.role.create({ data: input, include: roleInclude })
      .catch(conflictOnDuplicate(`A ${input.scope} role named "${input.name}" already exists`));
    await this.audit.log('role.create', role.name, { scope: role.scope, permissions: role.permissions });
    return toRoleDto(role);
  }

  @Perm('roles.manage') @Patch('roles/:id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<RoleDto> {
    const input = parse(z.object(roleFields).partial().strict(), body);
    const me = currentUser()!;
    const cur = await this.editable(me, id);
    this.checkPermissions(me, cur.scope as RoleScope, input.permissions ?? cur.permissions);
    const role = await keepingAnAdmin(this.prisma, (tx) => tx.role.update({ where: { id }, data: input, include: roleInclude }))
      .catch(conflictOnDuplicate(`A ${cur.scope} role named "${input.name}" already exists`));
    await this.audit.log('role.update', role.name, { fields: Object.keys(input), permissions: role.permissions });
    return toRoleDto(role);
  }

  @Perm('roles.manage') @Delete('roles/:id')
  async remove(@Param('id') id: string) {
    const role = await this.editable(currentUser()!, id);
    const usage = (await this.prisma.user.count({ where: { roleId: id } })) + (await this.prisma.projectMember.count({ where: { roleId: id } }));
    if (usage) throw new ConflictException(`Role "${role.name}" is in use by ${usage} user(s) or member(s) and cannot be deleted`);
    await this.prisma.role.delete({ where: { id } });
    await this.audit.log('role.delete', role.name, { scope: role.scope });
    return { ok: true };
  }
}

const memberInclude = { user: true, role: true } as const;
const toMemberDto = (m: { user: User; role: Role; createdAt: Date }): ProjectMemberDto => ({
  userId: m.user.id, username: m.user.username, displayName: m.user.displayName, role: { id: m.role.id, name: m.role.name }, createdAt: m.createdAt.toISOString(),
});

@Controller('projects/:id/members')
class MembersController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly access: AccessService) {}

  /** A project role the actor may hand out in this project: every permission of it must be among the actor's effective ones. */
  private async grantableRole(projectId: string, roleId: string): Promise<Role> {
    const role = await roleOfScope(this.prisma, roleId, 'project');
    assertCanGrant(await this.access.assertProject(projectId, 'members.manage'), role);
    return role;
  }

  @Perm('member', 'project') @Get()
  async list(@Param('id') projectId: string): Promise<ProjectMemberDto[]> {
    return (await this.prisma.projectMember.findMany({ where: { projectId }, include: memberInclude, orderBy: { createdAt: 'asc' } })).map(toMemberDto);
  }

  @Perm('members.manage', 'project') @Post()
  async add(@Param('id') projectId: string, @Body() body: unknown): Promise<ProjectMemberDto> {
    const input = parse(z.object({ userId: z.string(), roleId: z.string() }).strict(), body);
    const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
    if (!user || user.disabled) throw new BadRequestException('userId: no enabled user with this id');
    const role = await this.grantableRole(projectId, input.roleId);
    if (await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: user.id } } })) {
      throw new ConflictException(`${user.username} is already a member`);
    }
    const m = await this.prisma.projectMember.create({ data: { projectId, userId: user.id, roleId: role.id }, include: memberInclude });
    await this.audit.log('member.add', user.username, { projectId, role: role.name });
    return toMemberDto(m);
  }

  @Perm('members.manage', 'project') @Patch(':userId')
  async update(@Param('id') projectId: string, @Param('userId') userId: string, @Body() body: unknown): Promise<ProjectMemberDto> {
    const input = parse(z.object({ roleId: z.string() }).strict(), body);
    if (userId === currentUser()!.id) throw new ForbiddenException('You cannot change your own project role');
    const where = { projectId_userId: { projectId, userId } };
    if (!(await this.prisma.projectMember.findUnique({ where }))) throw new NotFoundException('Member not found');
    const role = await this.grantableRole(projectId, input.roleId);
    const m = await this.prisma.projectMember.update({ where, data: { roleId: role.id }, include: memberInclude });
    await this.audit.log('member.update', m.user.username, { projectId, role: role.name });
    return toMemberDto(m);
  }

  @Perm('members.manage', 'project') @Delete(':userId')
  async remove(@Param('id') projectId: string, @Param('userId') userId: string) {
    const m = await this.prisma.projectMember.delete({ where: { projectId_userId: { projectId, userId } }, include: { user: true } })
      .catch(() => { throw new NotFoundException('Member not found'); });
    await this.audit.log('member.remove', m.user.username, { projectId });
    return { ok: true };
  }
}

@Module({ controllers: [UsersController, RolesController, MembersController] })
export class AccountsModule {}
