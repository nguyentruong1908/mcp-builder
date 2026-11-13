'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, usePathname } from 'next/navigation';
import {
  BookOpen, ChevronRight, ChevronsUpDown, FileCode2, Gauge, Hammer, LayoutDashboard, Loader2, Menu, Moon, Package, Play, Plug, Plus,
  Settings2, ShieldCheck, Sun, Wrench,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useApi } from '@/lib/use-api';
import { cn, initials, isActive } from '@/lib/utils';
import { LogoMark } from './logo';
import { ExportDialog } from './export-dialog';
import { ToastProvider } from './toast';
import { Spinner } from './ui';

const projectNav = [
  { seg: '', label: 'Overview', icon: Gauge },
  { seg: '/api', label: 'API & Context', icon: FileCode2 },
  { seg: '/tools', label: 'Tool designer', icon: Wrench },
  { seg: '/connections', label: 'Connections', icon: Plug },
  { seg: '/builds', label: 'Builds', icon: Hammer },
  { seg: '/qa', label: 'QA', icon: ShieldCheck },
  { seg: '/versions', label: 'Versions & Exports', icon: Package },
];

function pageTitle(pathname: string) {
  if (pathname === '/') return 'Dashboard';
  if (pathname.startsWith('/settings')) return 'Settings & Audit';
  if (pathname === '/projects/new') return 'New project';
  const m = pathname.match(/^\/projects\/[^/]+(\/[^/]+)?(\/[^/]+)?/);
  if (m?.[1] === '/builds' && m[2]) return 'Build';
  return projectNav.find((n) => n.seg === (m?.[1] ?? ''))?.label ?? '';
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useParams<{ id?: string }>();
  const projectId = params.id;
  const [mobileNav, setMobileNav] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const project = useApi(() => (projectId ? api.project(projectId) : Promise.resolve(null)), [projectId, pathname]);

  useEffect(() => setMobileNav(false), [pathname]);
  const { refetch } = project;
  useEffect(() => {
    window.addEventListener('mf:refresh', refetch);
    return () => window.removeEventListener('mf:refresh', refetch);
  }, [refetch]);

  const p = project.data && project.data.id === projectId ? project.data : null;
  const running = p?.latestBuild && isActive(p.latestBuild.status) ? p.latestBuild : null;
  const base = projectId ? `/projects/${projectId}` : '';

  return (
    <ToastProvider>
      <div className="flex min-h-screen">
        {mobileNav && <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setMobileNav(false)} aria-hidden />}
        <aside className={cn('top-0 h-screen w-64 shrink-0 flex-col border-r bg-sidebar md:sticky md:flex', mobileNav ? 'fixed inset-y-0 left-0 z-40 flex shadow-2xl' : 'hidden')}>
          <div className="flex h-14 items-center gap-2.5 border-b px-4">
            <LogoMark className="size-8 text-foreground" />
            <div className="leading-tight">
              <div className="text-sm font-semibold">MCP Factory</div>
              <div className="text-[11px] text-muted-foreground">Local workspace</div>
            </div>
            <span className="badge badge-outline ml-auto">beta</span>
          </div>

          <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Main navigation">
            <div className="nav-group">Workspace</div>
            <Link href="/" className={cn('nav-item', pathname === '/' && 'active')}><LayoutDashboard className="size-4" />Dashboard</Link>
            <Link href="/settings" className={cn('nav-item', pathname.startsWith('/settings') && 'active')}><Settings2 className="size-4" />Settings &amp; Audit</Link>

            <div className="nav-group">Tool Project</div>
            <ProjectSwitcher current={p} />
            {projectId && projectNav.map((n) => {
              const href = base + n.seg;
              const active = n.seg === '' ? pathname === href : pathname.startsWith(href);
              return (
                <Link key={n.seg} href={href} className={cn('nav-item', active && 'active')}>
                  <n.icon className="size-4" />
                  <span className="flex-1">{n.label}</span>
                  {n.seg === '/builds' && running && <Loader2 className="size-3.5 animate-spin text-brand" aria-label="Building" />}
                </Link>
              );
            })}
          </nav>

          <div className="border-t p-3">
            <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5">
              <span className="avatar">LW</span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-[13px] font-medium">Local user</div>
                <div className="truncate text-[11px] text-muted-foreground">Sign-in not enabled</div>
              </div>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/80 px-4 backdrop-blur md:px-6">
            <button className="btn btn-ghost btn-icon md:hidden" onClick={() => setMobileNav(true)} aria-label="Open menu"><Menu className="size-4" /></button>
            <nav className="flex min-w-0 flex-1 items-center gap-1.5 text-sm text-muted-foreground" aria-label="Breadcrumb">
              <Link href="/" className="hidden hover:text-foreground sm:inline">Workspace</Link>
              {p && <>
                <ChevronRight className="hidden size-3.5 sm:inline" />
                <Link href={base} className="hidden max-w-[200px] truncate hover:text-foreground sm:inline">{p.name}</Link>
              </>}
              <ChevronRight className="hidden size-3.5 sm:inline" />
              <span className="truncate font-medium text-foreground">{pageTitle(pathname)}</span>
            </nav>
            {p?.latestDraft && (
              <span className="badge badge-outline hidden lg:inline-flex">
                <span className="size-1.5 rounded-full bg-warning" />Draft {p.latestDraft.number}
              </span>
            )}
            <a className="btn btn-outline btn-sm hidden sm:inline-flex" href="https://modelcontextprotocol.io" target="_blank" rel="noreferrer"><BookOpen className="size-3.5" />MCP docs</a>
            {projectId && (running ? (
              <Link className="btn btn-primary" href={`${base}/builds/${running.id}`}><Spinner />Exporting…</Link>
            ) : (
              <button className="btn btn-primary" disabled={!p || !!p.archivedAt} onClick={() => setExportOpen(true)}><Play className="size-4" />Export</button>
            ))}
          </header>
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 md:px-6 md:py-8">{children}</main>
        </div>
      </div>
      {projectId && <ExportDialog projectId={projectId} open={exportOpen} onClose={() => setExportOpen(false)} />}
    </ToastProvider>
  );
}

function ProjectSwitcher({ current }: { current: { id: string; name: string; latestDraft: { number: string } | null; currentRelease: { number: string } | null } | null }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const list = useApi(() => (open ? api.projects() : Promise.resolve(null)), [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const sub = current ? (current.latestDraft ? `draft ${current.latestDraft.number}` : current.currentRelease ? `release ${current.currentRelease.number}` : 'no version yet') : 'Select a project';
  return (
    <div className="relative mb-1.5" ref={ref}>
      <button aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 rounded-md border bg-background px-2.5 py-2 text-left transition-colors hover:bg-muted">
        <div className="flex size-7 items-center justify-center rounded bg-info-soft text-[11px] font-bold text-info">{current ? initials(current.name) : '–'}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">{current?.name ?? 'No project selected'}</div>
          <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
        </div>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-card shadow-xl" role="listbox">
          <div className="max-h-72 overflow-y-auto py-1">
            {list.error && <div className="px-3 py-2 text-xs text-danger">{list.error.message}</div>}
            {!list.data && !list.error && <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground"><Spinner className="size-3.5" />Loading…</div>}
            {list.data?.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No projects yet</div>}
            {list.data?.filter((x) => !x.archivedAt).map((x) => (
              <Link key={x.id} href={`/projects/${x.id}`} role="option" aria-selected={x.id === current?.id} onClick={() => setOpen(false)}
                className={cn('flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-muted', x.id === current?.id && 'bg-muted font-medium')}>
                <span className="truncate">{x.name}</span>
              </Link>
            ))}
          </div>
          <Link href="/projects/new" onClick={() => setOpen(false)} className="flex items-center gap-2 border-t px-3 py-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
            <Plus className="size-3.5" />New project
          </Link>
        </div>
      )}
    </div>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try { localStorage.setItem('mf-theme', next ? 'dark' : 'light'); } catch {}
  }
  return (
    <button className="btn btn-ghost btn-icon size-8" onClick={toggle} aria-label="Toggle light/dark theme">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
