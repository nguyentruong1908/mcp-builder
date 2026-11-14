import { AsyncLocalStorage } from 'node:async_hooks';
import type { WorkspacePermission } from '@mcp-builder/shared';

export interface RequestUser {
  id: string;
  username: string;
  displayName: string;
  roleId: string;
  roleName: string;
  permissions: WorkspacePermission[];
  mustChangePassword: boolean;
}

/** Set by authMiddleware for every /api request; survives into Nest handlers and SSE streams. */
export const requestContext = new AsyncLocalStorage<{ user: RequestUser | null; sessionId: string | null }>();

export const currentUser = (): RequestUser | null => requestContext.getStore()?.user ?? null;

/** Audit actor: the signed-in username, or 'system' outside a request (e.g. the build worker). */
export const actorName = (): string => currentUser()?.username ?? 'system';
