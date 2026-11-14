'use client';

import { createContext, useContext } from 'react';
import type { ProjectPermission, WorkspacePermission } from '@mcp-builder/shared';

/** Labels mirror the API's permission catalog (GET /permissions); the Roles tab renders from the API. */
const LABELS: Record<ProjectPermission | WorkspacePermission, string> = {
  'users.manage': 'Manage users', 'roles.manage': 'Manage roles', 'codex.manage': 'Manage Codex sign-in', 'settings.manage': 'Manage settings',
  'audit.read': 'Read audit log', 'projects.create': 'Create projects', 'projects.all': 'Access all projects',
  'project.edit': 'Edit project', 'spec.edit': 'Edit spec', 'context.edit': 'Edit context', 'tools.edit': 'Edit tools',
  'connections.manage': 'Manage connections', 'testcases.manage': 'Manage test cases', 'builds.run': 'Run builds', 'qa.run': 'Run QA',
  'versions.release': 'Release versions', 'deploy.manage': 'Manage deployments', 'members.manage': 'Manage members', 'artifacts.download': 'Download artifacts',
};

export const permLabel = (p: ProjectPermission | WorkspacePermission) => LABELS[p];

/** Tooltip for a control that is visible but disabled for lack of a permission. */
export const deniedTitle = (has: boolean, label: string): string | undefined => (has ? undefined : `Requires permission ${label}`);

export const ProjectPermsCtx = createContext<ProjectPermission[]>([]);
/** Effective permissions of the signed-in user on the project in the URL (empty off project pages). */
export const useProjectPermissions = () => useContext(ProjectPermsCtx);

/** `can('qa.run')` → `{ ok, title }` for spreading onto a button: `disabled={!ok}` `title={title}`. */
export function usePerm(p: ProjectPermission) {
  const ok = useProjectPermissions().includes(p);
  return { ok, title: deniedTitle(ok, LABELS[p]) };
}
