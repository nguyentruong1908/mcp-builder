'use client';

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';

type Toast = { msg: string; kind: 'ok' | 'error' };
const Ctx = createContext<(msg: string, kind?: Toast['kind']) => void>(() => {});

export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    setToast({ msg, kind });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2600);
  }, []);
  return (
    <Ctx.Provider value={show}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[60]">
        {toast && (
          <div role="status" className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border bg-card px-4 py-3 text-sm shadow-xl">
            {toast.kind === 'ok' ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />}
            <span>{toast.msg}</span>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
