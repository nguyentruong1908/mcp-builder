'use client';

import { useCallback, useEffect, useState } from 'react';

export interface Query<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refetch: () => void;
  setData: (u: T | ((prev: T | undefined) => T | undefined)) => void;
}

/** Fetch on mount and whenever deps change. Keeps stale data while refetching. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[]): Query<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn().then(
      (d) => { if (alive) { setDataState(d); setError(undefined); setLoading(false); } },
      (e: Error) => { if (alive) { setError(e); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((u: T | ((prev: T | undefined) => T | undefined)) => {
    setDataState((prev) => (typeof u === 'function' ? (u as (p: T | undefined) => T | undefined)(prev) : u));
  }, []);

  return { data, error, loading, refetch, setData };
}
