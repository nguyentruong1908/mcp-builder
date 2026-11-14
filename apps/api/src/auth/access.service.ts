import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ProjectPermission } from '@mcp-builder/shared';
import { PrismaService } from '../core/prisma.service.js';
import { currentUser, type RequestUser } from './context.js';
import { effectiveProjectPermissions } from './permissions.js';

export type ResourceKind = 'project' | 'connection' | 'tool' | 'testCase' | 'build' | 'version' | 'artifact' | 'deployment';

/** Same messages the handlers use for a missing record, so a hidden project cannot be told apart from a missing one. */
const NOT_FOUND: Record<ResourceKind, string> = {
  project: 'Project not found', connection: 'Environment not found', tool: 'Tool not found', testCase: 'Test case not found',
  build: 'Build not found', version: 'Version not found', artifact: 'Artifact not found', deployment: 'Deployment not found',
};

@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async projectIdOf(kind: ResourceKind, id: string): Promise<string | null> {
    const q = { where: { id }, select: { projectId: true } };
    switch (kind) {
      case 'project': return (await this.prisma.project.findUnique({ where: { id }, select: { id: true } }))?.id ?? null;
      case 'connection': return (await this.prisma.connection.findUnique(q))?.projectId ?? null;
      case 'tool': return (await this.prisma.toolDefinition.findUnique(q))?.projectId ?? null;
      case 'testCase': return (await this.prisma.testCase.findUnique(q))?.projectId ?? null;
      case 'build': return (await this.prisma.build.findUnique(q))?.projectId ?? null;
      case 'version': return (await this.prisma.version.findUnique(q))?.projectId ?? null;
      case 'deployment': return (await this.prisma.deployment.findUnique(q))?.projectId ?? null;
      case 'artifact': return (await this.prisma.artifact.findUnique({ where: { id }, select: { build: { select: { projectId: true } } } }))?.build.projectId ?? null;
    }
  }

  /** null = no access. */
  async projectPermissions(user: RequestUser, projectId: string): Promise<ProjectPermission[] | null> {
    if (user.permissions.includes('projects.all')) return effectiveProjectPermissions(user.permissions, null);
    const m = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId: user.id } }, select: { role: { select: { permissions: true } } } });
    return effectiveProjectPermissions(user.permissions, m?.role.permissions ?? null);
  }

  /** Not a member → 404 (`notFound`); member lacking `perm` → 403. A null projectId means the record does not exist. */
  async assertProject(projectId: string | null, perm: ProjectPermission | 'member', notFound = NOT_FOUND.project): Promise<ProjectPermission[]> {
    const perms = projectId ? await this.projectPermissions(currentUser()!, projectId) : null;
    if (!perms) throw new NotFoundException(notFound);
    if (perm !== 'member' && !perms.includes(perm)) throw new ForbiddenException(`Requires permission ${perm}`);
    return perms;
  }

  async assertResource(kind: ResourceKind, id: string, perm: ProjectPermission | 'member'): Promise<ProjectPermission[]> {
    return this.assertProject(await this.projectIdOf(kind, id), perm, NOT_FOUND[kind]);
  }

  async accessibleProjectIds(user: RequestUser): Promise<string[] | 'all'> {
    if (user.permissions.includes('projects.all')) return 'all';
    return (await this.prisma.projectMember.findMany({ where: { userId: user.id }, select: { projectId: true } })).map((m) => m.projectId);
  }

  async hasAnyProjectPermission(user: RequestUser, perm: ProjectPermission): Promise<boolean> {
    if (user.permissions.includes('projects.all')) return true;
    return (await this.prisma.projectMember.count({ where: { userId: user.id, role: { permissions: { has: perm } } } })) > 0;
  }
}
