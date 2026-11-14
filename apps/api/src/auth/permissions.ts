import type { PermissionInfo, ProjectPermission, RoleScope, WorkspacePermission } from '@mcp-builder/shared';

export const WORKSPACE_PERMISSIONS = [
  'users.manage', 'roles.manage', 'codex.manage', 'settings.manage', 'audit.read', 'projects.create', 'projects.all',
] as const satisfies readonly WorkspacePermission[];

export const PROJECT_PERMISSIONS = [
  'project.edit', 'spec.edit', 'context.edit', 'tools.edit', 'connections.manage', 'testcases.manage',
  'builds.run', 'qa.run', 'versions.release', 'deploy.manage', 'members.manage', 'artifacts.download',
] as const satisfies readonly ProjectPermission[];

export const ADMIN_ROLE_ID = 'role_admin';
export const OWNER_ROLE_ID = 'role_owner';

const W: RoleScope = 'workspace';
const P: RoleScope = 'project';

export const PERMISSION_INFO: PermissionInfo[] = [
  { key: 'users.manage', scope: W, label: 'Manage users', description: 'Create users, edit, reset passwords, disable or enable.' },
  { key: 'roles.manage', scope: W, label: 'Manage roles', description: 'Create, edit and delete roles.' },
  { key: 'codex.manage', scope: W, label: 'Manage Codex sign-in', description: 'Device code, API key, auth.json upload and sign-out.' },
  { key: 'settings.manage', scope: W, label: 'Manage settings', description: 'Limits, budget and the workspace generation profile.' },
  { key: 'audit.read', scope: W, label: 'Read audit log', description: 'View the workspace-wide audit log.' },
  { key: 'projects.create', scope: W, label: 'Create projects', description: 'Create new projects.' },
  { key: 'projects.all', scope: W, label: 'All projects', description: 'Act as a member with every project permission on every project, member or not.' },
  { key: 'project.edit', scope: P, label: 'Edit project', description: 'Name, description, outputs, archive and the project generation override.' },
  { key: 'spec.edit', scope: P, label: 'Import specs', description: 'Import API specs.' },
  { key: 'context.edit', scope: P, label: 'Edit context', description: 'Context, glossary and sample tasks.' },
  { key: 'tools.edit', scope: P, label: 'Edit tools', description: 'Tool designer changes.' },
  { key: 'connections.manage', scope: P, label: 'Manage connections', description: 'Create, edit, delete and test QA environments.' },
  { key: 'testcases.manage', scope: P, label: 'Manage test cases', description: 'Create, edit and delete test cases.' },
  { key: 'builds.run', scope: P, label: 'Run exports', description: 'Start and cancel an export (build).' },
  { key: 'qa.run', scope: P, label: 'Run QA', description: 'Start and cancel a standalone QA run.' },
  { key: 'versions.release', scope: P, label: 'Release versions', description: 'Release and deprecate versions.' },
  { key: 'deploy.manage', scope: P, label: 'Manage deployment', description: 'Deploy, redeploy, start, stop, rotate token and remove a deployment.' },
  { key: 'members.manage', scope: P, label: 'Manage members', description: 'Add and remove members and change their project role.' },
  { key: 'artifacts.download', scope: P, label: 'Download artifacts', description: 'Download packages, QA reports and provenance.' },
];

export function isPermissionOfScope(key: string, scope: RoleScope): boolean {
  return (scope === 'workspace' ? (WORKSPACE_PERMISSIONS as readonly string[]) : (PROJECT_PERMISSIONS as readonly string[])).includes(key);
}

/** null = no access to the project. */
export function effectiveProjectPermissions(workspace: readonly string[], memberRole: readonly string[] | null): ProjectPermission[] | null {
  if (workspace.includes('projects.all')) return [...PROJECT_PERMISSIONS];
  return memberRole ? (memberRole.filter((k) => isPermissionOfScope(k, 'project')) as ProjectPermission[]) : null;
}

/** The actor may hand out a role only if it holds every permission of that role. */
export function canGrant(actor: readonly string[], role: readonly string[]): boolean {
  return role.every((k) => actor.includes(k));
}
