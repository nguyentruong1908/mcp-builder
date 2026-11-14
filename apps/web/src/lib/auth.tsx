'use client';

import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { MeDto, WorkspacePermission } from '@mcp-builder/shared';
import { api } from './api';
import { useApi } from './use-api';
import { ErrorState, LoadingBlock } from '@/components/ui';

const Ctx = createContext<{ me: MeDto; refetch: () => void } | null>(null);

export function useMe() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMe outside MeProvider');
  return v;
}

export const hasWorkspacePerm = (me: MeDto, p: WorkspacePermission) => me.permissions.includes(p);

/** Only same-origin absolute paths; blocks `//host` and `/\host` open redirects. */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export function MeProvider({ children }: { children: ReactNode }) {
  const q = useApi(() => api.me(), []);
  const pathname = usePathname();
  const router = useRouter();
  const forced = !!q.data?.mustChangePassword && pathname !== '/account';
  useEffect(() => { if (forced) router.replace('/account'); }, [forced, router]);

  // A 401 is already redirecting to /login; keep the spinner meanwhile.
  if (q.error && (q.error as { status?: number }).status !== 401) return <ErrorState error={q.error} onRetry={q.refetch} />;
  if (!q.data || forced) return <LoadingBlock />;
  return <Ctx.Provider value={{ me: q.data, refetch: q.refetch }}>{children}</Ctx.Provider>;
}
