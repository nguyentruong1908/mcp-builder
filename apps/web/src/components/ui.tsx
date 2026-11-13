'use client';

import { useEffect, useId, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RefreshCw, ServerOff, X } from 'lucide-react';
import { API_URL, NetworkError } from '@/lib/api';
import type { Query } from '@/lib/use-api';
import { cn, methodCls, type Tone } from '@/lib/utils';

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('card', className)}>{children}</div>;
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-5 pt-4 pb-3', className)}>
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-6">{title}</div>
        {description && <div className="text-xs text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Badge({ tone = 'outline', className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return <span className={cn('badge', `badge-${tone}`, className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden className={cn('size-4 animate-spin', className)} />;
}

export function LoadingBlock({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground" role="status">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-14 text-center', className)}>
      {icon && <div className="mb-1 flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">{icon}</div>}
      <div className="font-medium">{title}</div>
      {description && <div className="max-w-md text-sm text-muted-foreground">{description}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  const down = error instanceof NetworkError;
  return (
    <Card className="mx-auto max-w-xl">
      <EmptyState
        icon={down ? <ServerOff className="size-5" /> : <AlertTriangle className="size-5 text-danger" />}
        title={down ? 'Cannot reach the API' : 'Failed to load data'}
        description={
          down ? (
            <>
              Check that the API is running at <code className="mono text-foreground">{API_URL}</code> (set <code className="mono">NEXT_PUBLIC_API_URL</code> if it differs).
            </>
          ) : (
            error.message
          )
        }
        action={onRetry && (
          <button className="btn btn-outline btn-sm" onClick={onRetry}>
            <RefreshCw className="size-3.5" /> Retry
          </button>
        )}
      />
    </Card>
  );
}

/** Renders loading / error states for a query, then the children with data. */
export function Loaded<T>({ q, children, loading }: { q: Query<T>; children: (data: T) => ReactNode; loading?: ReactNode }) {
  if (q.data !== undefined) return <>{children(q.data)}</>;
  if (q.error) return <ErrorState error={q.error} onRetry={q.refetch} />;
  return <>{loading ?? <LoadingBlock />}</>;
}

export function InlineError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div className="alert alert-danger" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
      <div>{error}</div>
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange, className }: { tabs: { id: K; label: ReactNode }[]; value: K; onChange: (k: K) => void; className?: string }) {
  return (
    <div className={cn('tabs', className)} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={value === t.id} className={cn('tab', value === t.id && 'active')} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Modal({ open, onClose, title, description, children, footer, size = 'max-w-xl' }: {
  open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: string;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className={cn('card relative flex max-h-[90vh] w-full flex-col shadow-2xl', size)} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="flex items-start justify-between gap-3 border-b px-6 py-4">
          <div>
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          <button className="btn btn-ghost btn-icon size-8" onClick={onClose} aria-label="Close"><X className="size-4" /></button>
        </div>
        <div className="overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t bg-muted/30 px-6 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, sub, icon, valueClass }: { label: ReactNode; value: ReactNode; sub?: ReactNode; icon?: ReactNode; valueClass?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">{label}{icon}</div>
      <div className={cn('stat-n', valueClass)}>{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export function MethodBadge({ method }: { method: string }) {
  const m = method.toUpperCase();
  return <span className={cn('method', methodCls[m] ?? 'bg-muted text-muted-foreground')}>{m}</span>;
}
